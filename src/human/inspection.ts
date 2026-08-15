// Provides read-only human/lease inspection and explicit provider reconciliation entry points.
import { digestJson, sha256 } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { ReconciliationResult } from "../domain/provider.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { HumanConsumptionRecord, HumanInteractionSlot } from "./contracts.js";
import { HumanRecoveryManager, parseConsumption } from "./recovery-manager.js";
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

export async function inspectHumanRecovery(provider: AgentTaskProvider, taskId: string): Promise<HumanRecoveryInspection> {
  const task = await provider.getTaskSnapshot(taskId);
  const slots = parseHumanInteractionSlots(task.body);
  const inspected: HumanSlotInspection[] = [];
  for (const slot of slots) {
    const baseline = await provider.getOptionalResource(`human-slot/${slot.slotId}`);
    const baselineSlots = baseline === null ? [] : parseHumanInteractionSlots(baseline.body);
    const baselineSlot = baselineSlots[0];
    const baselineValid = baseline !== null
      && baseline.kind === "system/human-interaction-slot"
      && baseline.state === "active"
      && baseline.version === "v1"
      && baseline.digest === sha256(baseline.body)
      && baselineSlots.length === 1
      && baselineSlot?.slotId === slot.slotId
      && baselineSlot.response === null;
    const consumption = await provider.getOptionalResource(`human-consumption/${slot.slotId}`);
    let consumptionState: HumanSlotInspection["consumptionState"] = "none";
    if (consumption !== null) {
      if (consumption.kind !== "system/human-consumption" || consumption.state !== "active" || consumption.version !== "v1" || consumption.digest !== sha256(consumption.body)) {
        throw new Error(`Human consumption Resource is invalid: ${slot.slotId}`);
      }
      consumptionState = parseConsumption(JSON.parse(consumption.body) as unknown).state;
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
