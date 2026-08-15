// Applies provider-defined outcome routes while enforcing blocker-first human recovery.
import { routeOutcome } from "../core/outcome-router.js";
import { taskPropertiesWithStatus } from "../core/task-properties.js";
import type { ErrorMutation, SubAgentDefinition } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { HumanRecoveryManager } from "./recovery-manager.js";

export interface BlockedOutcomeResolution {
  readonly createdAt: string;
  readonly error: Omit<ErrorMutation, "idempotencyKey" | "relatedTaskId">;
  readonly generation: number;
  readonly prompt: string;
  readonly requestedBy: string;
  readonly resumeStatus: string;
}

interface OutcomeTransitionBase {
  readonly definition: Pick<SubAgentDefinition, "humanResolutionOutcomes" | "transitions">;
  readonly outcome: string;
  readonly taskId: string;
}

export interface HumanResolutionTransitionInput extends OutcomeTransitionBase {
  readonly kind: "human_resolution";
  readonly resolution: BlockedOutcomeResolution;
}

export interface OrdinaryTransitionInput extends OutcomeTransitionBase {
  readonly idempotencyKey: string;
  readonly kind: "task_transition";
}

export type OutcomeTransitionInput = HumanResolutionTransitionInput | OrdinaryTransitionInput;
export type OutcomeTransitionReceipt = {
  readonly humanSlotId: string;
  readonly kind: "human_resolution";
  readonly targetStatus: string;
  readonly taskVersion: string;
} | {
  readonly humanSlotId: null;
  readonly kind: "task_transition";
  readonly targetStatus: string;
  readonly taskVersion: string;
};

export class OutcomeTransitionBroker {
  private readonly humanRecovery: HumanRecoveryManager;

  public constructor(private readonly provider: AgentTaskProvider) {
    this.humanRecovery = new HumanRecoveryManager(provider);
  }

  public async apply(input: OutcomeTransitionInput): Promise<OutcomeTransitionReceipt> {
    const task = await this.provider.getTaskSnapshot(input.taskId);
    if (task.archived) throw new Error("Cannot route an outcome for an archived Task");
    const statuses = await this.provider.listTaskStatusOptions();
    const targetStatus = routeOutcome({ currentStatus: task.status, definition: input.definition, outcome: input.outcome, validStatuses: statuses });
    const requiresHumanResolution = input.definition.humanResolutionOutcomes.includes(input.outcome);

    if (input.kind === "human_resolution") {
      if (!requiresHumanResolution) throw new Error(`Outcome ${input.outcome} is not declared as a human-resolution outcome`);
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
      return { humanSlotId: request.slot.slotId, kind: "human_resolution", targetStatus: request.status, taskVersion: request.taskVersion };
    }

    if (requiresHumanResolution) throw new Error(`Outcome ${input.outcome} requires a durable human resolution request`);
    if (targetStatus === task.status) return { humanSlotId: null, kind: "task_transition", targetStatus, taskVersion: task.version };
    await this.provider.applyTaskMutation({
      expectedVersion: task.version,
      idempotencyKey: input.idempotencyKey,
      nextBody: null,
      nextProperties: taskPropertiesWithStatus(task.properties, targetStatus),
      nextStatus: targetStatus,
      taskId: task.id,
    });
    const updated = await this.provider.getTaskSnapshot(task.id);
    if (updated.status !== targetStatus) throw new Error("Outcome transition did not verify");
    return { humanSlotId: null, kind: "task_transition", targetStatus, taskVersion: updated.version };
  }
}
