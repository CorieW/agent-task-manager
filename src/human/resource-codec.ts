// Encodes and validates provider-backed human slot baselines and consumption records.
import { canonicalize } from "../core/canonical-json.js";
import { sha256 } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { ResourceRecord } from "../domain/records.js";
import type { HumanAuthority, HumanConsumptionRecord, HumanInteractionSlot, HumanSlotBaselineRecord } from "./contracts.js";
import { parseHumanInteractionSlots, renderHumanInteractionSlot } from "./slot-codec.js";

export function humanSlotResourceKey(slotId: string): string { return `human-slot/${slotId}`; }
export function humanConsumptionResourceKey(slotId: string): string { return `human-consumption/${slotId}`; }

export function serializeHumanSlotBaseline(record: HumanSlotBaselineRecord): string {
  return canonicalize(toJsonValue(parseHumanSlotBaseline(record)));
}

export function parseHumanSlotBaselineResource(resource: ResourceRecord, slotId: string): HumanSlotBaselineRecord {
  assertResource(resource, humanSlotResourceKey(slotId), "system/human-interaction-slot", "v2");
  const baseline = parseHumanSlotBaseline(JSON.parse(resource.body) as unknown);
  if (baseline.slot.slotId !== slotId) throw new TypeError("Human slot baseline identity is invalid");
  return baseline;
}

export function parseHumanConsumptionResource(resource: ResourceRecord, slotId: string): HumanConsumptionRecord {
  assertResource(resource, humanConsumptionResourceKey(slotId), "system/human-consumption", "v1");
  const consumption = parseHumanConsumption(JSON.parse(resource.body) as unknown);
  if (consumption.authority.slotId !== slotId) throw new TypeError("Human consumption identity is invalid");
  return consumption;
}

export function parseHumanConsumption(value: unknown): HumanConsumptionRecord {
  const found = record(value, "Human consumption");
  closed(found, ["appliedTaskVersion", "authority", "schema", "sourceStatus", "state", "taskId"]);
  if (found.schema !== "human-consumption-v1" || (found.state !== "pending" && found.state !== "applied") || !text(found.sourceStatus) || !text(found.taskId) || (found.appliedTaskVersion !== null && !text(found.appliedTaskVersion))) throw new TypeError("Human consumption fields are invalid");
  const authority = parseHumanAuthority(found.authority);
  if ((found.state === "pending" && found.appliedTaskVersion !== null) || (found.state === "applied" && !text(found.appliedTaskVersion))) throw new TypeError("Human consumption lifecycle is invalid");
  return { appliedTaskVersion: found.appliedTaskVersion as string | null, authority, schema: "human-consumption-v1", sourceStatus: found.sourceStatus, state: found.state, taskId: found.taskId };
}

function parseHumanSlotBaseline(value: unknown): HumanSlotBaselineRecord {
  const found = record(value, "Human slot baseline");
  closed(found, ["schema", "slot", "taskBodyDigest", "taskPropertiesDigest", "waitingStatus"]);
  if (found.schema !== "human-slot-baseline-v2" || !digest(found.taskBodyDigest) || !digest(found.taskPropertiesDigest) || !text(found.waitingStatus)) throw new TypeError("Human slot baseline fields are invalid");
  const slot = parseSlot(found.slot);
  if (slot.response !== null) throw new TypeError("Human slot baseline response must be blank");
  return { schema: "human-slot-baseline-v2", slot, taskBodyDigest: found.taskBodyDigest, taskPropertiesDigest: found.taskPropertiesDigest, waitingStatus: found.waitingStatus };
}

function parseSlot(value: unknown): HumanInteractionSlot {
  const rendered = renderHumanInteractionSlot(value as HumanInteractionSlot);
  const slots = parseHumanInteractionSlots(rendered);
  if (slots.length !== 1 || slots[0] === undefined) throw new TypeError("Human slot baseline must contain one slot");
  return slots[0];
}

function parseHumanAuthority(value: unknown): HumanAuthority {
  const found = record(value, "Human authority");
  closed(found, ["action", "responseDigest", "schema", "slotId", "targetStatus", "text"]);
  if (found.schema !== "human-authority-v1" || !digest(found.responseDigest) || !digest(found.slotId) || !text(found.action) || !text(found.targetStatus) || !text(found.text)) throw new TypeError("Human authority fields are invalid");
  return { action: found.action, responseDigest: found.responseDigest, schema: "human-authority-v1", slotId: found.slotId, targetStatus: found.targetStatus, text: found.text };
}

function assertResource(resource: ResourceRecord, key: string, kind: string, version: string): void {
  if (resource.key !== key || resource.kind !== kind || resource.state !== "active" || resource.version !== version || resource.digest !== sha256(resource.body)) throw new TypeError(`Human recovery Resource is invalid: ${key}`);
}
function record(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`); return value as Record<string, unknown>; }
function closed(value: Record<string, unknown>, fields: readonly string[]): void { if (Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) throw new TypeError("Human recovery object has unexpected or missing fields"); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function text(value: unknown): value is string { return typeof value === "string" && value !== ""; }
