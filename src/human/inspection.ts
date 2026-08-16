/** Provides read-only human/lease inspection and explicit provider reconciliation entry points. */
import { digestJson } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { LeaseSnapshot } from "../domain/records.js";
import type { ReconciliationResult, WriteReceipt } from "../domain/provider.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type {
  HumanConsumptionRecord,
  HumanInteractionSlot,
} from "./contracts.js";
import { HumanRecoveryManager } from "./recovery-manager.js";
import {
  humanConsumptionResourceKey,
  humanSlotResourceKey,
  parseHumanConsumptionResource,
  parseHumanSlotBaselineResource,
} from "./resource-codec.js";
import { parseHumanInteractionSlots } from "./slot-codec.js";

/** Defines the data and behavior required by human slot inspection. */
export interface HumanSlotInspection {
  /** Indicates whether baseline valid. */
  readonly baselineValid: boolean;
  /** Records the current consumption state for workflow decisions. */
  readonly consumptionState: HumanConsumptionRecord["state"] | "none";
  /** Discriminates the kind variant. */
  readonly kind: HumanInteractionSlot["kind"];
  /** Records the current response state for workflow decisions. */
  readonly responseState: "blank" | "completed";
  /** Identifies slot. */
  readonly slotId: string;
}
/** Defines the data and behavior required by human recovery inspection. */
export interface HumanRecoveryInspection {
  /** Indicates whether archived. */
  readonly archived: boolean;
  /** Lists the slots accepted by this contract. */
  readonly slots: readonly HumanSlotInspection[];
  /** Records the current status for workflow decisions. */
  readonly status: string;
  /** Identifies task. */
  readonly taskId: string;
  /** Records the task version used for compatibility checks. */
  readonly taskVersion: string;
}

/** Defines the data and behavior required by agent activity inspection. */
export interface AgentActivityInspection {
  /** Provides activity to agent activity inspection. */
  readonly activity: Awaited<ReturnType<AgentTaskProvider["getAgentActivity"]>>;
  /** Provides lease projection to agent activity inspection. */
  readonly leaseProjection: Awaited<
    ReturnType<AgentTaskProvider["getLeaseProjection"]>
  >;
  /** Lists the leases accepted by this contract. */
  readonly leases: readonly LeaseSnapshot[];
  /** Identifies agent. */
  readonly agentId: string;
}

/** Builds a read-only inspection of human recovery. */
export async function inspectHumanRecovery(
  provider: AgentTaskProvider,
  taskId: string,
): Promise<HumanRecoveryInspection> {
  /** Stores task used by inspect human recovery. */
  const task = await provider.getTaskSnapshot(taskId);
  /** Stores slots used by inspect human recovery. */
  const slots = parseHumanInteractionSlots(task.body);
  /** Stores inspected used by inspect human recovery. */
  const inspected: HumanSlotInspection[] = [];
  for (const slot of slots) {
    /** Stores baseline used by inspect human recovery. */
    const baseline = await provider.getOptionalResource(
      humanSlotResourceKey(slot.slotId),
    );
    /** Stores baseline valid used by inspect human recovery. */
    let baselineValid = false;
    if (baseline !== null) {
      try {
        parseHumanSlotBaselineResource(baseline, slot.slotId);
        baselineValid = true;
      } catch {
        baselineValid = false;
      }
    }
    /** Stores consumption used by inspect human recovery. */
    const consumption = await provider.getOptionalResource(
      humanConsumptionResourceKey(slot.slotId),
    );
    /** Stores consumption state used by inspect human recovery. */
    let consumptionState: HumanSlotInspection["consumptionState"] = "none";
    if (consumption !== null) {
      consumptionState = parseHumanConsumptionResource(
        consumption,
        slot.slotId,
      ).state;
    }
    inspected.push({
      baselineValid,
      consumptionState,
      kind: slot.kind,
      responseState: slot.response === null ? "blank" : "completed",
      slotId: slot.slotId,
    });
  }
  return {
    archived: task.archived,
    slots: inspected.sort((left, right) =>
      left.slotId.localeCompare(right.slotId),
    ),
    status: task.status,
    taskId,
    taskVersion: task.version,
  };
}

/** Reconciles human response from observed state without blind replay. */
export async function reconcileHumanResponse(
  provider: AgentTaskProvider,
  taskId: string,
  slotId: string,
): Promise<HumanConsumptionRecord> {
  return new HumanRecoveryManager(provider).consume(taskId, slotId);
}

/** Reconciles activity from observed state without blind replay. */
export async function reconcileActivity(
  provider: AgentTaskProvider,
  agentId: string,
): Promise<ReconciliationResult> {
  /** Stores basis used by reconcile activity. */
  const basis = {
    activity: await provider.getAgentActivity(agentId),
    projection: await provider.getLeaseProjection(agentId),
    agentId,
  };
  return provider.reconcileAgentActivity(
    agentId,
    `manual-activity:${digestJson(toJsonValue(basis))}`,
  );
}

/** Builds a read-only inspection of agent activity. */
export async function inspectAgentActivity(
  provider: AgentTaskProvider,
  agentId: string,
): Promise<AgentActivityInspection> {
  /** Stores activity used by inspect agent activity. */
  const activity = await provider.getAgentActivity(agentId);
  /** Stores lease projection used by inspect agent activity. */
  const leaseProjection = await provider.getLeaseProjection(agentId);
  /** Stores ids used by inspect agent activity. */
  const ids = [
    ...new Set([
      ...leaseProjection.runLeaseIds,
      ...leaseProjection.taskLeaseIds,
    ]),
  ].sort();
  /** Stores leases used by inspect agent activity. */
  const leases = await Promise.all(
    ids.map((leaseId) => provider.getLeaseSnapshot(leaseId)),
  );
  if (leases.some((lease) => lease === null))
    throw new Error("Lease changed during activity inspection");
  return {
    activity,
    leaseProjection,
    leases: leases as LeaseSnapshot[],
    agentId,
  };
}

/** Builds a read-only inspection of lease. */
export async function inspectLease(
  provider: AgentTaskProvider,
  leaseId: string,
): Promise<LeaseSnapshot | null> {
  return provider.getLeaseSnapshot(leaseId);
}

/** Reconciles lease from observed state without blind replay. */
export async function reconcileLease(
  provider: AgentTaskProvider,
  leaseId: string,
  ownerId: string,
  expectedVersion: string,
): Promise<WriteReceipt> {
  return provider.releaseLease({ expectedVersion, leaseId, ownerId });
}
