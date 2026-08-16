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

/** Defines the data and behavior required by blocked outcome resolution. */
export interface BlockedOutcomeResolution {
  /** Records the canonical timestamp for created. */
  readonly createdAt: string;
  /** Provides error to blocked outcome resolution. */
  readonly error: Omit<ErrorMutation, "idempotencyKey" | "relatedTaskId">;
  /** Provides generation to blocked outcome resolution. */
  readonly generation: number;
  /** Provides prompt to blocked outcome resolution. */
  readonly prompt: string;
  /** Identifies the actor that requested resolution. */
  readonly requestedBy: string;
  /** Records the current resume status for workflow decisions. */
  readonly resumeStatus: string;
}

/** Defines the data and behavior required by outcome transition base. */
interface OutcomeTransitionBase {
  /** Provides definition to outcome transition base. */
  readonly definition: Pick<
    AgentDefinition,
    "humanResolutionOutcomes" | "transitions"
  >;
  /** Records the current outcome for workflow decisions. */
  readonly outcome: string;
  /** Identifies task. */
  readonly taskId: string;
}

/** Defines the data and behavior required by human resolution transition input. */
export interface HumanResolutionTransitionInput extends OutcomeTransitionBase {
  /** Discriminates the kind variant. */
  readonly kind: "human_resolution";
  /** Provides resolution to human resolution transition input. */
  readonly resolution: BlockedOutcomeResolution;
}

/** Defines the data and behavior required by ordinary transition input. */
export interface OrdinaryTransitionInput extends OutcomeTransitionBase {
  /** Identifies idempotency. */
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
      /** Identifies human slot. */
      readonly humanSlotId: string;
      /** Discriminates the kind variant. */
      readonly kind: "human_resolution";
      /** Records the current target status for workflow decisions. */
      readonly targetStatus: string;
      /** Records the task version used for compatibility checks. */
      readonly taskVersion: string;
    }
  | {
      /** Identifies human slot. */
      readonly humanSlotId: null;
      /** Discriminates the kind variant. */
      readonly kind: "task_transition";
      /** Records the current target status for workflow decisions. */
      readonly targetStatus: string;
      /** Records the task version used for compatibility checks. */
      readonly taskVersion: string;
    };

/** Durable plan that freezes a state-dependent ordinary transition for replay. */
interface OutcomeTransitionPlan {
  /** Exact conditional Task mutation derived from the source snapshot. */
  readonly mutation: ConditionalTaskMutation;
  /** Canonical caller request used to reject changed-input key reuse. */
  readonly request: JsonValue;
  /** Identifies the durable plan format. */
  readonly schema: "outcome-transition-plan-v1";
  /** Status selected from the source snapshot and definition route. */
  readonly targetStatus: string;
}

/** Stable provider operation used for durable transition-plan replay. */
const OUTCOME_TRANSITION_OPERATION = "outcome_transition";

/** Implements outcome transition broker and its boundary checks. */
export class OutcomeTransitionBroker {
  /** Provides human recovery to outcome transition broker. */
  private readonly humanRecovery: HumanRecoveryManager;

  /** Creates outcome transition broker with its required collaborators. */
  public constructor(
    /** Provides provider to outcome transition broker. */ private readonly provider: AgentTaskProvider,
  ) {
    this.humanRecovery = new HumanRecoveryManager(provider);
  }

  /** Applies an authorized outcome transition or creates its human-recovery request. */
  public async apply(
    input: OutcomeTransitionInput,
  ): Promise<OutcomeTransitionReceipt> {
    /** Replays an ordinary transition before consulting mutable Task state. */
    const requested =
      input.kind === "task_transition" ? toJsonValue(input) : null;
    if (input.kind === "task_transition" && requested !== null) {
      const prior = await this.provider.getOperationIntent(
        input.idempotencyKey,
      );
      if (prior !== null) return this.applyPreparedTransition(prior, requested);
    }
    /** Stores task used by apply. */
    const task = await this.provider.getTaskSnapshot(input.taskId);
    if (task.archived)
      throw new Error("Cannot route an outcome for an archived Task");
    /** Stores statuses used by apply. */
    const statuses = await this.provider.listTaskStatusOptions();
    /** Stores target status used by apply. */
    const targetStatus = routeOutcome({
      currentStatus: task.status,
      definition: input.definition,
      outcome: input.outcome,
      validStatuses: statuses,
    });
    /** Stores requires human resolution used by apply. */
    const requiresHumanResolution =
      input.definition.humanResolutionOutcomes.includes(input.outcome);

    if (input.kind === "human_resolution") {
      if (!requiresHumanResolution)
        throw new Error(
          `Outcome ${input.outcome} is not declared as a human-resolution outcome`,
        );
      /** Stores request used by apply. */
      const request = await this.humanRecovery.requestResolution({
        createdAt: input.resolution.createdAt,
        error: input.resolution.error,
        generation: input.resolution.generation,
        prompt: input.resolution.prompt,
        requestedBy: input.resolution.requestedBy,
        resumeStatus: input.resolution.resumeStatus,
        taskId: input.taskId,
        waitingStatus: targetStatus,
      });
      return {
        humanSlotId: request.slot.slotId,
        kind: "human_resolution",
        targetStatus: request.status,
        taskVersion: request.taskVersion,
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
      targetStatus === task.status &&
      input.reviewCycle === undefined &&
      input.testCycle === undefined
    )
      return {
        humanSlotId: null,
        kind: "task_transition",
        targetStatus,
        taskVersion: task.version,
      };

    /** Replays a previously prepared transition before deriving new cycle state. */
    if (requested === null)
      throw new Error("Ordinary transition request was not prepared");

    /** Advances remediation state in the same conditional write as the status transition. */
    const nextTaskProperties =
      input.reviewCycle !== undefined
        ? advanceReviewCycle(
            task.properties,
            input.reviewCycle.findingKeys,
            input.reviewCycle.policy,
          ).nextProperties
        : input.testCycle !== undefined
          ? advanceTestCycle(
              task.properties,
              input.testCycle.failureKeys,
              input.testCycle.policy,
            ).nextProperties
          : task.properties;
    const plan: OutcomeTransitionPlan = {
      mutation: {
        expectedVersion: task.version,
        idempotencyKey: `${input.idempotencyKey}:task`,
        nextBody: null,
        nextProperties: taskPropertiesWithStatus(
          nextTaskProperties,
          targetStatus,
        ),
        nextStatus: targetStatus,
        taskId: task.id,
      },
      request: requested,
      schema: "outcome-transition-plan-v1",
      targetStatus,
    };
    /** Persists the exact state-dependent mutation before it can be applied. */
    let prepared: ProviderOperationIntent;
    try {
      prepared = await this.provider.beginOperationIntent(
        input.idempotencyKey,
        OUTCOME_TRANSITION_OPERATION,
        toJsonValue(plan),
      );
    } catch (error) {
      /** Resolves an exact concurrent request against the winning frozen plan. */
      const concurrent = await this.provider.getOperationIntent(
        input.idempotencyKey,
      );
      if (
        concurrent === null ||
        !sameTransitionRequest(concurrent.payload, requested)
      ) {
        throw error;
      }
      prepared = concurrent;
    }
    return this.applyPreparedTransition(prepared, requested);
  }

  /** Applies or replays one frozen transition plan. */
  private async applyPreparedTransition(
    intent: ProviderOperationIntent,
    requested: JsonValue,
  ): Promise<OutcomeTransitionReceipt> {
    if (intent.operation !== OUTCOME_TRANSITION_OPERATION) {
      throw new Error(
        `Idempotency key ${intent.idempotencyKey} was reused with a different operation or payload`,
      );
    }
    const plan = parseTransitionPlan(intent.payload);
    if (digestJson(plan.request) !== digestJson(requested)) {
      throw new Error(
        `Idempotency key ${intent.idempotencyKey} was reused with a different operation or payload`,
      );
    }
    if (intent.state === "applied") {
      return parseTransitionReceipt(intent.result);
    }
    const write = await this.provider.applyTaskMutation(plan.mutation);
    const receipt: OutcomeTransitionReceipt = {
      humanSlotId: null,
      kind: "task_transition",
      targetStatus: plan.targetStatus,
      taskVersion: write.observedVersion,
    };
    const completed = await this.provider.completeOperationIntent(
      intent.idempotencyKey,
      OUTCOME_TRANSITION_OPERATION,
      intent.payload,
      toJsonValue(receipt),
    );
    return parseTransitionReceipt(completed.result);
  }
}

/** Reports whether a stored transition plan belongs to the current request. */
function sameTransitionRequest(
  payload: JsonValue,
  requested: JsonValue,
): boolean {
  try {
    return (
      digestJson(parseTransitionPlan(payload).request) === digestJson(requested)
    );
  } catch {
    return false;
  }
}

/** Parses a provider-owned frozen transition plan. */
function parseTransitionPlan(value: JsonValue): OutcomeTransitionPlan {
  const object = objectValue(value, "Outcome transition plan");
  if (object.schema !== "outcome-transition-plan-v1") {
    throw new TypeError("Outcome transition plan schema is invalid");
  }
  const mutation = objectValue(object.mutation, "Outcome transition mutation");
  const nextProperties = objectValue(
    mutation.nextProperties,
    "Outcome transition properties",
  );
  return {
    mutation: {
      expectedVersion: stringValue(
        mutation.expectedVersion,
        "Outcome transition expectedVersion",
      ),
      idempotencyKey: stringValue(
        mutation.idempotencyKey,
        "Outcome transition mutation idempotencyKey",
      ),
      nextBody:
        mutation.nextBody === null
          ? null
          : stringValue(mutation.nextBody, "Outcome transition nextBody"),
      nextProperties,
      nextStatus:
        mutation.nextStatus === null
          ? null
          : stringValue(mutation.nextStatus, "Outcome transition nextStatus"),
      taskId: stringValue(mutation.taskId, "Outcome transition taskId"),
    },
    request: object.request ?? null,
    schema: object.schema,
    targetStatus: stringValue(
      object.targetStatus,
      "Outcome transition targetStatus",
    ),
  };
}

/** Parses a completed ordinary transition receipt. */
function parseTransitionReceipt(value: JsonValue): OutcomeTransitionReceipt {
  const object = objectValue(value, "Outcome transition receipt");
  if (object.kind !== "task_transition" || object.humanSlotId !== null) {
    throw new TypeError("Outcome transition receipt is invalid");
  }
  return {
    humanSlotId: null,
    kind: "task_transition",
    targetStatus: stringValue(
      object.targetStatus,
      "Outcome transition receipt targetStatus",
    ),
    taskVersion: stringValue(
      object.taskVersion,
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
