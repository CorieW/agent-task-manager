// Applies provider-defined outcome routes while enforcing blocker-first human recovery.
import { taskPropertiesWithStatus } from "./task-properties.js";
import { routeOutcome } from "./outcome-router.js";
import type { ErrorMutation, SubAgentDefinition } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { HumanRecoveryManager } from "../human/recovery-manager.js";

export interface BlockedOutcomeResolution {
  readonly createdAt: string;
  readonly error: Omit<ErrorMutation, "idempotencyKey" | "relatedTaskId">;
  readonly generation: number;
  readonly prompt: string;
  readonly requestedBy: string;
  readonly resumeStatus: string;
}

export interface OutcomeTransitionInput {
  readonly blockedResolution: BlockedOutcomeResolution | null;
  readonly definition: SubAgentDefinition;
  readonly idempotencyKey: string;
  readonly outcome: string;
  readonly taskId: string;
}

export interface OutcomeTransitionReceipt {
  readonly humanSlotId: string | null;
  readonly kind: "human_resolution" | "task_transition";
  readonly targetStatus: string;
  readonly taskVersion: string;
}

export class OutcomeTransitionBroker {
  private readonly humanRecovery: HumanRecoveryManager;

  public constructor(private readonly provider: AgentTaskProvider) {
    this.humanRecovery = new HumanRecoveryManager(provider);
  }

  public async apply(input: OutcomeTransitionInput): Promise<OutcomeTransitionReceipt> {
    const task = await this.provider.getTaskSnapshot(input.taskId);
    if (task.archived) throw new Error("Cannot route an outcome for an archived Task");
    const statuses = await this.provider.listTaskStatusOptions();
    const targetStatus = routeOutcome({
      currentStatus: task.status,
      definition: input.definition,
      outcome: input.outcome,
      validStatuses: statuses,
    });

    if (input.outcome === "blocked") {
      if (input.blockedResolution === null) throw new Error("Blocked outcomes require a durable human resolution request");
      const request = await this.humanRecovery.requestResolution({
        createdAt: input.blockedResolution.createdAt,
        error: input.blockedResolution.error,
        generation: input.blockedResolution.generation,
        prompt: input.blockedResolution.prompt,
        requestedBy: input.blockedResolution.requestedBy,
        resumeStatus: input.blockedResolution.resumeStatus,
        taskId: input.taskId,
        waitingStatus: targetStatus,
      });
      return { humanSlotId: request.slot.slotId, kind: "human_resolution", targetStatus: request.status, taskVersion: request.taskVersion };
    }

    if (input.blockedResolution !== null) throw new Error("Only blocked outcomes may carry a human resolution request");
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
