/** Applies provider-defined outcome routes while enforcing blocker-first human recovery. */
import { routeOutcome } from "../core/outcome-router.js";
import { taskPropertiesWithStatus } from "../core/task-properties.js";
import type { ErrorMutation, AgentDefinition } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { HumanRecoveryManager } from "./recovery-manager.js";
import {
  advanceReviewCycle,
  type ReviewCyclePolicy,
} from "./review-cycle-guard.js";

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
    if (targetStatus === task.status && input.reviewCycle === undefined)
      return {
        humanSlotId: null,
        kind: "task_transition",
        targetStatus,
        taskVersion: task.version,
      };
    /** Advances review state in the same conditional write as the status transition. */
    const nextTaskProperties =
      input.reviewCycle === undefined
        ? task.properties
        : advanceReviewCycle(
            task.properties,
            input.reviewCycle.findingKeys,
            input.reviewCycle.policy,
          ).nextProperties;
    await this.provider.applyTaskMutation({
      expectedVersion: task.version,
      idempotencyKey: input.idempotencyKey,
      nextBody: null,
      nextProperties: taskPropertiesWithStatus(
        nextTaskProperties,
        targetStatus,
      ),
      nextStatus: targetStatus,
      taskId: task.id,
    });
    /** Stores updated used by apply. */
    const updated = await this.provider.getTaskSnapshot(task.id);
    if (updated.status !== targetStatus)
      throw new Error("Outcome transition did not verify");
    return {
      humanSlotId: null,
      kind: "task_transition",
      targetStatus,
      taskVersion: updated.version,
    };
  }
}
