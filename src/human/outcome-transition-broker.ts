/** Applies provider-defined outcome routes while enforcing blocker-first human recovery. */
import { routeOutcome } from "../core/outcome-router.js";
import { taskPropertiesWithStatus } from "../core/task-properties.js";
import { digestJson } from "../core/digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type {
  ConditionalTaskMutation,
  ErrorMutation,
  AgentDefinition,
} from "../domain/records.js";
import type { ProviderOperationIntent } from "../domain/provider.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { HumanRecoveryManager } from "./recovery-manager.js";
import {
  advanceReviewCycle,
  type ReviewCyclePolicy,
} from "./review-cycle-guard.js";
import { advanceTestCycle, type TestCyclePolicy } from "./test-cycle-guard.js";

/** Human-authored recovery request created for a blocked agent outcome. */
export interface BlockedOutcomeResolution {
  /** ISO timestamp used to order and identify the recovery generation. */
  readonly createdAt: string;
  /** Error details persisted before the Task enters human resolution. */
  readonly error: Omit<ErrorMutation, "idempotencyKey" | "relatedTaskId">;
  /** Monotonic human-recovery generation for this Task. */
  readonly generation: number;
  /** Question or decision context presented to the human. */
  readonly prompt: string;
  /** Actor that requested the human decision. */
  readonly requestedBy: string;
  /** Workflow status for resume. */
  readonly resumeStatus: string;
}

/** Shared routing evidence for every outcome transition. */
interface OutcomeTransitionBase {
  /** Definition-owned routes and human-resolution outcomes. */
  readonly definition: Pick<
    AgentDefinition,
    "humanResolutionOutcomes" | "transitions"
  >;
  /** Task status frozen by the assignment that produced the result. */
  readonly expectedTaskStatus?: string;
  /** Task version frozen by the assignment that produced the result. */
  readonly expectedTaskVersion?: string;
  /** Agent result outcome to resolve through the definition routes. */
  readonly outcome: string;
  /** Task whose status or recovery state will advance. */
  readonly taskId: string;
  /** Manager-owned Task content and property updates applied with the route. */
  readonly taskUpdate?: {
    /** Complete replacement body, when the role published Task content. */
    readonly nextBody?: string;
    /** Complete replacement properties, when the role published Task metadata. */
    readonly nextProperties?: JsonObject;
  };
}

/** Outcome transition that must create a durable human-recovery slot. */
export interface HumanResolutionTransitionInput extends OutcomeTransitionBase {
  /** Discriminates the kind variant. */
  readonly kind: "human_resolution";
  /** Human-recovery generation and Error content to persist. */
  readonly resolution: BlockedOutcomeResolution;
}

/** Conditional Task transition that can be prepared and replayed idempotently. */
export interface OrdinaryTransitionInput extends OutcomeTransitionBase {
  /** Stable identity for the complete logical transition. */
  readonly idempotencyKey: string;
  /** Discriminates the kind variant. */
  readonly kind: "task_transition";
  /** Optional confirmed finding identities recorded atomically with a review failure. */
  readonly reviewCycle?: {
    /** Stable canonical identities for every confirmed finding in this review result. */
    readonly findingKeys: readonly string[];
    /** Provider-neutral Task-property names and loop limits. */
    readonly policy?: ReviewCyclePolicy;
  };
  /** Optional confirmed failure identities recorded atomically with a failed test. */
  readonly testCycle?: {
    /** Stable canonical identities for every confirmed failure in this test result. */
    readonly failureKeys: readonly string[];
    /** Provider-neutral Task-property names and loop limits. */
    readonly policy?: TestCyclePolicy;
  };
}

/** Enumerates the supported outcome transition input variants. */
export type OutcomeTransitionInput =
  HumanResolutionTransitionInput | OrdinaryTransitionInput;

/** Enumerates the supported outcome transition receipt variants. */
export type OutcomeTransitionReceipt =
  | {
      /** Stable identifier for human slot id. */
      readonly humanSlotId: string;
      /** Discriminates the kind variant. */
      readonly kind: "human_resolution";
      /** Workflow status for target. */
      readonly targetStatus: string;
      /** Opaque version token for task. */
      readonly taskVersion: string;
    }
  | {
      /** Ordinary transitions never create a human-recovery slot. */
      readonly humanSlotId: null;
      /** Discriminates the kind variant. */
      readonly kind: "task_transition";
      /** Workflow status for target. */
      readonly targetStatus: string;
      /** Opaque version token for task. */
      readonly taskVersion: string;
    };

/** Durable plan that freezes a state-dependent ordinary transition for replay. */
interface OutcomeTransitionPlan {
  /** Exact conditional Task mutation derived from the source snapshot. */
  readonly mutation: ConditionalTaskMutation;
  /** Canonical caller request used to reject changed-input key reuse. */
  readonly request: JsonValue;
  /** Wire-schema discriminator; always `outcome-transition-plan-v1`. */
  readonly schema: "outcome-transition-plan-v1";
  /** Status selected from the source snapshot and definition route. */
  readonly targetStatus: string;
}

/** Stable provider operation used for durable transition-plan replay. */
const OUTCOME_TRANSITION_OPERATION = "outcome_transition";

/** Implements outcome transition broker and its boundary checks. */
export class OutcomeTransitionBroker {
  /** Persists blocker-first recovery generations for declared human outcomes. */
  private readonly humanRecovery: HumanRecoveryManager;

  /** Creates a broker over the provider that owns Task and intent state. */
  public constructor(
    /** Provider used for routing evidence, conditional writes, and replay intents. */ private readonly provider: AgentTaskProvider,
  ) {
    this.humanRecovery = new HumanRecoveryManager(provider);
  }

  /** Applies an authorized outcome transition or creates its human-recovery request. */
  public async apply(
    input: OutcomeTransitionInput,
  ): Promise<OutcomeTransitionReceipt> {
    /** Canonical caller request bound to an ordinary transition's idempotency key. */
    const requestPayload =
      input.kind === "task_transition" ? toJsonValue(input) : null;
    if (input.kind === "task_transition" && requestPayload !== null) {
      /** Previously prepared transition, which must replay before reading mutable Task state. */
      const existingIntent = await this.provider.getOperationIntent(
        input.idempotencyKey,
      );
      if (existingIntent !== null)
        return this.applyPreparedTransition(existingIntent, requestPayload);
    }

    /** Source snapshot used to derive routing and the conditional write version. */
    const taskSnapshot = await this.provider.getTaskSnapshot(input.taskId);
    if (taskSnapshot.archived)
      throw new Error("Cannot route an outcome for an archived Task");
    if (
      (input.kind !== "human_resolution" &&
        input.expectedTaskVersion !== undefined &&
        taskSnapshot.version !== input.expectedTaskVersion) ||
      (input.kind !== "human_resolution" &&
        input.expectedTaskStatus !== undefined &&
        taskSnapshot.status !== input.expectedTaskStatus)
    )
      throw new Error("Task changed after the Agent result was authorized");

    /** Provider-defined statuses accepted by the outcome route. */
    const validStatuses = await this.provider.listTaskStatusOptions();
    /** Status selected from the definition and source Task snapshot. */
    const targetStatus = routeOutcome({
      currentStatus: input.expectedTaskStatus ?? taskSnapshot.status,
      definition: input.definition,
      outcome: input.outcome,
      validStatuses,
    });
    /** Whether the definition requires a durable human interaction for this outcome. */
    const requiresHumanResolution =
      input.definition.humanResolutionOutcomes.includes(input.outcome);

    if (input.kind === "human_resolution") {
      if (!requiresHumanResolution)
        throw new Error(
          `Outcome ${input.outcome} is not declared as a human-resolution outcome`,
        );
      /** Persisted recovery generation and verified waiting-state receipt. */
      const recoveryRequest = await this.humanRecovery.requestResolution({
        createdAt: input.resolution.createdAt,
        error: input.resolution.error,
        generation: input.resolution.generation,
        ...(input.expectedTaskStatus === undefined
          ? {}
          : { expectedTaskStatus: input.expectedTaskStatus }),
        ...(input.expectedTaskVersion === undefined
          ? {}
          : { expectedTaskVersion: input.expectedTaskVersion }),
        prompt: input.resolution.prompt,
        requestedBy: input.resolution.requestedBy,
        resumeStatus: input.resolution.resumeStatus,
        ...(input.taskUpdate?.nextBody === undefined
          ? {}
          : { nextTaskBody: input.taskUpdate.nextBody }),
        ...(input.taskUpdate?.nextProperties === undefined
          ? {}
          : { nextTaskProperties: input.taskUpdate.nextProperties }),
        taskId: input.taskId,
        waitingStatus: targetStatus,
      });
      return {
        humanSlotId: recoveryRequest.slot.slotId,
        kind: "human_resolution",
        targetStatus: recoveryRequest.status,
        taskVersion: recoveryRequest.taskVersion,
      };
    }

    if (requiresHumanResolution)
      throw new Error(
        `Outcome ${input.outcome} requires a durable human resolution request`,
      );
    if (input.reviewCycle !== undefined && input.testCycle !== undefined) {
      throw new TypeError(
        "An outcome transition cannot advance review and test cycles together",
      );
    }
    if (
      targetStatus === taskSnapshot.status &&
      input.reviewCycle === undefined &&
      input.testCycle === undefined &&
      input.taskUpdate === undefined
    )
      return {
        humanSlotId: null,
        kind: "task_transition",
        targetStatus,
        taskVersion: taskSnapshot.version,
      };

    /** Replays a previously prepared transition before deriving new cycle state. */
    if (requestPayload === null)
      throw new Error("Ordinary transition request was not prepared");

    /** Task properties after applying the one selected remediation-cycle policy. */
    let nextTaskProperties =
      input.taskUpdate?.nextProperties ?? taskSnapshot.properties;
    if (input.reviewCycle !== undefined) {
      nextTaskProperties = advanceReviewCycle(
        nextTaskProperties,
        input.reviewCycle.findingKeys,
        input.reviewCycle.policy,
      ).nextProperties;
    } else if (input.testCycle !== undefined) {
      nextTaskProperties = advanceTestCycle(
        nextTaskProperties,
        input.testCycle.failureKeys,
        input.testCycle.policy,
      ).nextProperties;
    }

    /** Frozen, source-versioned transition persisted before its Task mutation. */
    const transitionPlan: OutcomeTransitionPlan = {
      mutation: {
        expectedVersion: taskSnapshot.version,
        idempotencyKey: `${input.idempotencyKey}:task`,
        nextBody: input.taskUpdate?.nextBody ?? null,
        nextProperties: taskPropertiesWithStatus(
          nextTaskProperties,
          targetStatus,
        ),
        nextStatus: targetStatus,
        taskId: taskSnapshot.id,
      },
      request: requestPayload,
      schema: "outcome-transition-plan-v1",
      targetStatus,
    };
    /** Persists the exact state-dependent mutation before it can be applied. */
    let preparedIntent: ProviderOperationIntent;
    try {
      preparedIntent = await this.provider.beginOperationIntent(
        input.idempotencyKey,
        OUTCOME_TRANSITION_OPERATION,
        toJsonValue(transitionPlan),
      );
    } catch (error) {
      /** Resolves an exact concurrent request against the winning frozen plan. */
      const concurrentIntent = await this.provider.getOperationIntent(
        input.idempotencyKey,
      );
      if (
        concurrentIntent === null ||
        !sameTransitionRequest(concurrentIntent.payload, requestPayload)
      ) {
        throw error;
      }
      preparedIntent = concurrentIntent;
    }
    return this.applyPreparedTransition(preparedIntent, requestPayload);
  }

  /** Applies or replays one frozen transition plan. */
  private async applyPreparedTransition(
    preparedIntent: ProviderOperationIntent,
    requestPayload: JsonValue,
  ): Promise<OutcomeTransitionReceipt> {
    if (preparedIntent.operation !== OUTCOME_TRANSITION_OPERATION) {
      throw new Error(
        `Idempotency key ${preparedIntent.idempotencyKey} was reused with a different operation or payload`,
      );
    }
    /** Frozen plan decoded from the provider-owned operation intent. */
    const transitionPlan = parseTransitionPlan(preparedIntent.payload);
    if (digestJson(transitionPlan.request) !== digestJson(requestPayload)) {
      throw new Error(
        `Idempotency key ${preparedIntent.idempotencyKey} was reused with a different operation or payload`,
      );
    }
    if (preparedIntent.state === "applied") {
      return parseTransitionReceipt(preparedIntent.result);
    }

    /** Provider receipt from applying or replaying the frozen Task mutation. */
    const taskWriteReceipt = await this.provider.applyTaskMutation(
      transitionPlan.mutation,
    );
    /** Logical transition receipt persisted after the conditional Task write. */
    const transitionReceipt: OutcomeTransitionReceipt = {
      humanSlotId: null,
      kind: "task_transition",
      targetStatus: transitionPlan.targetStatus,
      taskVersion: taskWriteReceipt.observedVersion,
    };
    /** Completed provider intent that makes future retries read-only. */
    const completedIntent = await this.provider.completeOperationIntent(
      preparedIntent.idempotencyKey,
      OUTCOME_TRANSITION_OPERATION,
      preparedIntent.payload,
      toJsonValue(transitionReceipt),
    );
    return parseTransitionReceipt(completedIntent.result);
  }
}

/** Reports whether a stored transition plan belongs to the current request. */
function sameTransitionRequest(
  payload: JsonValue,
  requestPayload: JsonValue,
): boolean {
  try {
    return (
      digestJson(parseTransitionPlan(payload).request) ===
      digestJson(requestPayload)
    );
  } catch {
    return false;
  }
}

/** Parses a provider-owned frozen transition plan. */
function parseTransitionPlan(value: JsonValue): OutcomeTransitionPlan {
  /** Closed JSON record for the persisted transition plan. */
  const planRecord = objectValue(value, "Outcome transition plan");
  if (planRecord.schema !== "outcome-transition-plan-v1") {
    throw new TypeError("Outcome transition plan schema is invalid");
  }
  /** Closed JSON record for the plan's conditional Task mutation. */
  const mutationRecord = objectValue(
    planRecord.mutation,
    "Outcome transition mutation",
  );
  /** Replacement Task properties carried by the frozen mutation. */
  const nextProperties = objectValue(
    mutationRecord.nextProperties,
    "Outcome transition properties",
  );
  return {
    mutation: {
      expectedVersion: stringValue(
        mutationRecord.expectedVersion,
        "Outcome transition expectedVersion",
      ),
      idempotencyKey: stringValue(
        mutationRecord.idempotencyKey,
        "Outcome transition mutation idempotencyKey",
      ),
      nextBody:
        mutationRecord.nextBody === null
          ? null
          : stringValue(mutationRecord.nextBody, "Outcome transition nextBody"),
      nextProperties,
      nextStatus:
        mutationRecord.nextStatus === null
          ? null
          : stringValue(
              mutationRecord.nextStatus,
              "Outcome transition nextStatus",
            ),
      taskId: stringValue(mutationRecord.taskId, "Outcome transition taskId"),
    },
    request: planRecord.request ?? null,
    schema: planRecord.schema,
    targetStatus: stringValue(
      planRecord.targetStatus,
      "Outcome transition targetStatus",
    ),
  };
}

/** Parses a completed ordinary transition receipt. */
function parseTransitionReceipt(value: JsonValue): OutcomeTransitionReceipt {
  /** Closed JSON record returned by the completed provider intent. */
  const receiptRecord = objectValue(value, "Outcome transition receipt");
  if (
    receiptRecord.kind !== "task_transition" ||
    receiptRecord.humanSlotId !== null
  ) {
    throw new TypeError("Outcome transition receipt is invalid");
  }
  return {
    humanSlotId: null,
    kind: "task_transition",
    targetStatus: stringValue(
      receiptRecord.targetStatus,
      "Outcome transition receipt targetStatus",
    ),
    taskVersion: stringValue(
      receiptRecord.taskVersion,
      "Outcome transition receipt taskVersion",
    ),
  };
}

/** Returns a required JSON object. */
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

/** Returns a required non-empty string. */
function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}
