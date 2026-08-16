/** Read-only human/lease inspection and explicit provider reconciliation entry points. */
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

/** Provider-neutral human slot inspection contract. */
export interface HumanSlotInspection {
  /** Indicates whether baseline valid. */
  readonly baselineValid: boolean;
  /** Lifecycle state for consumption. */
  readonly consumptionState: HumanConsumptionRecord["state"] | "none";
  /** Discriminates the kind variant. */
  readonly kind: HumanInteractionSlot["kind"];
  /** Lifecycle state for response. */
  readonly responseState: "blank" | "completed";
  /** Stable identifier for slot id. */
  readonly slotId: string;
}

/** Provider-neutral human recovery inspection contract. */
export interface HumanRecoveryInspection {
  /** Indicates whether archived. */
  readonly archived: boolean;
  /** Ordered the slots used by this contract. */
  readonly slots: readonly HumanSlotInspection[];
  /** Current workflow status. */
  readonly status: string;
  /** Stable identifier for task id. */
  readonly taskId: string;
  /** Opaque version token for task. */
  readonly taskVersion: string;
}

/** Provider-neutral agent activity inspection contract. */
export interface AgentActivityInspection {
  /** Current Agent activity projection. */
  readonly activity: Awaited<ReturnType<AgentTaskProvider["getAgentActivity"]>>;
  /** Ordered lease projection accepted by agent activity inspection. */
  readonly leaseProjection: Awaited<
    ReturnType<AgentTaskProvider["getLeaseProjection"]>
  >;
  /** Ordered the leases used by this contract. */
  readonly leases: readonly LeaseSnapshot[];
  /** Stable identifier for agent id. */
  readonly agentId: string;
}

/** Builds a read-only inspection of human recovery. */
export async function inspectHumanRecovery(
  provider: AgentTaskProvider,
  taskId: string,
): Promise<HumanRecoveryInspection> {
  /** Result of `provider.getTaskSnapshot`, retained for the inspect human recovery operation. */
  const task = await provider.getTaskSnapshot(taskId);
  /** Result of `parseHumanInteractionSlots`, retained for the inspect human recovery operation. */
  const slots = parseHumanInteractionSlots(task.body);
  /** Result of `provider.getOptionalResource`, retained for the inspect human recovery operation. */
  const inspected: HumanSlotInspection[] = [];
  for (const slot of slots) {
    /** Result of `provider.getOptionalResource`, retained for the inspect human recovery operation. */
    const baseline = await provider.getOptionalResource(
      humanSlotResourceKey(slot.slotId),
    );
    /** Mutable flag tracking baseline valid during the inspect human recovery operation. */
    let baselineValid = false;
    if (baseline !== null) {
      try {
        parseHumanSlotBaselineResource(baseline, slot.slotId);
        baselineValid = true;
      } catch {
        baselineValid = false;
      }
    }
    /** Result of `provider.getOptionalResource`, retained for the inspect human recovery operation. */
    const consumption = await provider.getOptionalResource(
      humanConsumptionResourceKey(slot.slotId),
    );
    /** Result of `parseHumanConsumptionResource`, retained for the inspect human recovery operation. */
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
  /** Basis snapshot used consistently during the reconcile activity operation. */
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
  /** Result of `provider.getAgentActivity`, retained for the inspect agent activity operation. */
  const activity = await provider.getAgentActivity(agentId);
  /** Result of `provider.getLeaseProjection`, retained for the inspect agent activity operation. */
  const leaseProjection = await provider.getLeaseProjection(agentId);
  /** Ids snapshot used consistently during the inspect agent activity operation. */
  const ids = [
    ...new Set([
      ...leaseProjection.runLeaseIds,
      ...leaseProjection.taskLeaseIds,
    ]),
  ].sort();
  /** Result of `Promise.all`, retained for the inspect agent activity operation. */
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
