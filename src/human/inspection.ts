// Provides read-only human/lease inspection and explicit provider reconciliation entry points.
import { digestJson } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { ReconciliationResult, WriteReceipt } from "../domain/provider.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { HumanConsumptionRecord, HumanInteractionSlot } from "./contracts.js";
import { HumanRecoveryManager } from "./recovery-manager.js";
import { humanConsumptionResourceKey, humanSlotResourceKey, parseHumanConsumptionResource, parseHumanSlotBaselineResource } from "./resource-codec.js";
import { parseHumanInteractionSlots } from "./slot-codec.js";

export interface HumanSlotInspection {
  readonly baselineValid: boolean;
  readonly consumptionState: HumanConsumptionRecord["state"] | "none";
  readonly kind: HumanInteractionSlot["kind"];
  readonly responseState: "blank" | "completed";
  readonly slotId: string;
}
export interface HumanRecoveryInspection {
  readonly archived: boolean;
  readonly slots: readonly HumanSlotInspection[];
  readonly status: string;
  readonly taskId: string;
  readonly taskVersion: string;
}

export interface SubAgentActivityInspection {
  readonly activity: Awaited<ReturnType<AgentTaskProvider["getSubAgentActivity"]>>;
  readonly leaseProjection: Awaited<ReturnType<AgentTaskProvider["getLeaseProjection"]>>;
  readonly subAgentId: string;
}

export async function inspectHumanRecovery(provider: AgentTaskProvider, taskId: string): Promise<HumanRecoveryInspection> {
  const task = await provider.getTaskSnapshot(taskId);
  const slots = parseHumanInteractionSlots(task.body);
  const inspected: HumanSlotInspection[] = [];
  for (const slot of slots) {
    const baseline = await provider.getOptionalResource(humanSlotResourceKey(slot.slotId));
    let baselineValid = false;
    if (baseline !== null) {
      try { parseHumanSlotBaselineResource(baseline, slot.slotId); baselineValid = true; }
      catch { baselineValid = false; }
    }
    const consumption = await provider.getOptionalResource(humanConsumptionResourceKey(slot.slotId));
    let consumptionState: HumanSlotInspection["consumptionState"] = "none";
    if (consumption !== null) {
      consumptionState = parseHumanConsumptionResource(consumption, slot.slotId).state;
    }
    inspected.push({ baselineValid, consumptionState, kind: slot.kind, responseState: slot.response === null ? "blank" : "completed", slotId: slot.slotId });
  }
  return { archived: task.archived, slots: inspected.sort((left, right) => left.slotId.localeCompare(right.slotId)), status: task.status, taskId, taskVersion: task.version };
}

export async function reconcileHumanResponse(provider: AgentTaskProvider, taskId: string, slotId: string): Promise<HumanConsumptionRecord> {
  return new HumanRecoveryManager(provider).consume(taskId, slotId);
}

export async function reconcileActivity(provider: AgentTaskProvider, subAgentId: string): Promise<ReconciliationResult> {
  const basis = {
    activity: await provider.getSubAgentActivity(subAgentId),
    projection: await provider.getLeaseProjection(subAgentId),
    subAgentId,
  };
  return provider.reconcileSubAgentActivity(subAgentId, `manual-activity:${digestJson(toJsonValue(basis))}`);
}

export async function inspectSubAgentActivity(provider: AgentTaskProvider, subAgentId: string): Promise<SubAgentActivityInspection> {
  return { activity: await provider.getSubAgentActivity(subAgentId), leaseProjection: await provider.getLeaseProjection(subAgentId), subAgentId };
}

export async function reconcileLease(provider: AgentTaskProvider, leaseId: string, ownerId: string): Promise<WriteReceipt> {
  return provider.releaseLease({ leaseId, ownerId });
}
