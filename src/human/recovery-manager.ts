// Creates resolvable human requests and consumes each verified response exactly once.
import { canonicalize } from "../core/canonical-json.js";
import { digestJson, sha256 } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ErrorMutation, ResourceMutation, TaskSnapshot } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { HumanConsumptionRecord, HumanInteractionSlot } from "./contracts.js";
import { appendHumanInteractionSlot, createHumanInteractionSlot, parseHumanInteractionSlots, renderHumanInteractionSlot, verifyAllowedHumanDelta, type NewHumanInteractionSlot } from "./slot-codec.js";

export interface HumanRequestInput extends NewHumanInteractionSlot {
  readonly error: Omit<ErrorMutation, "idempotencyKey" | "relatedTaskId"> | null;
  readonly waitingStatus: string;
}

export interface HumanRequestReceipt {
  readonly slot: HumanInteractionSlot;
  readonly status: string;
  readonly taskVersion: string;
}

export class HumanRecoveryManager {
  public constructor(private readonly provider: AgentTaskProvider) {}

  public async request(input: HumanRequestInput): Promise<HumanRequestReceipt> {
    if (input.kind === "resolution" && input.error === null) throw new Error("Human resolution requests require a stable Error");
    const statuses = await this.provider.listTaskStatusOptions(); requireStatuses(statuses, [input.waitingStatus, ...Object.values(input.routes)]);
    const slot = createHumanInteractionSlot(input); let task = await this.provider.getTaskSnapshot(slot.taskId); if (task.archived) throw new Error("Cannot request human interaction for an archived Task");
    await this.writeSlotBaseline(slot);
    if (input.error !== null) await this.provider.createOrUpdateError({ ...input.error, idempotencyKey: `human-error:${slot.slotId}:${digestJson(toJsonValue(input.error))}`, relatedTaskId: slot.taskId });
    const existingSlot = parseHumanInteractionSlots(task.body).find((candidate) => candidate.slotId === slot.slotId);
    if (existingSlot !== undefined) {
      if (existingSlot.response === null && canonicalize(toJsonValue(existingSlot)) !== canonicalize(toJsonValue(slot))) throw new Error("Existing human slot conflicts with its baseline");
      if (existingSlot.response !== null) verifyAllowedHumanDelta(slot, existingSlot);
    }
    const nextBody = existingSlot === undefined ? appendHumanInteractionSlot(task.body, slot) : task.body;
    if (nextBody !== task.body) {
      await this.provider.applyTaskMutation({ expectedVersion: task.version, idempotencyKey: `human-request:${slot.slotId}:slot`, nextBody, nextProperties: task.properties, nextStatus: null, taskId: task.id });
      task = await this.provider.getTaskSnapshot(task.id); verifyTaskSlot(task, slot.slotId);
    }
    if (task.status !== input.waitingStatus) {
      await this.provider.applyTaskMutation({ expectedVersion: task.version, idempotencyKey: `human-request:${slot.slotId}:status`, nextBody: null, nextProperties: task.properties, nextStatus: input.waitingStatus, taskId: task.id });
      task = await this.provider.getTaskSnapshot(task.id);
    }
    if (task.status !== input.waitingStatus) throw new Error("Human request waiting status did not verify");
    verifyTaskSlot(task, slot.slotId); return { slot, status: task.status, taskVersion: task.version };
  }

  public async requestResolution(input: Omit<HumanRequestInput, "error" | "kind" | "routes" | "sourceErrorKey"> & { readonly error: Omit<ErrorMutation, "idempotencyKey" | "relatedTaskId">; readonly resumeStatus: string }): Promise<HumanRequestReceipt> {
    return this.request({ ...input, kind: "resolution", routes: { resume: input.resumeStatus }, sourceErrorKey: input.error.errorKey });
  }

  public async consume(taskId: string, slotId: string): Promise<HumanConsumptionRecord> {
    const baseline = await this.readSlotBaseline(slotId); if (baseline.taskId !== taskId) throw new Error("Human slot belongs to another Task");
    let task = await this.provider.getTaskSnapshot(taskId); const edited = requiredSlot(task, slotId); const authority = verifyAllowedHumanDelta(baseline, edited);
    const key = consumptionKey(slotId); let consumption = await this.readConsumption(key);
    if (consumption === null) {
      consumption = { appliedTaskVersion: null, authority, schema: "human-consumption-v1", sourceStatus: task.status, state: "pending", taskId };
      await this.writeConsumption(key, consumption);
    } else { verifyConsumption(consumption, authority, taskId); }
    if (consumption.state === "applied") return consumption;
    if (task.status !== authority.targetStatus) {
      if (task.status !== consumption.sourceStatus) throw new Error("Task status changed outside the human authority");
      const currentAuthority = verifyAllowedHumanDelta(baseline, requiredSlot(task, slotId)); if (currentAuthority.responseDigest !== authority.responseDigest) throw new Error("Human response changed during consumption");
      await this.provider.applyTaskMutation({ expectedVersion: task.version, idempotencyKey: `human-consume:${slotId}:${authority.responseDigest}`, nextBody: null, nextProperties: task.properties, nextStatus: authority.targetStatus, taskId });
      task = await this.provider.getTaskSnapshot(taskId);
    }
    if (task.status !== authority.targetStatus) throw new Error("Human response transition did not verify");
    const applied: HumanConsumptionRecord = { ...consumption, appliedTaskVersion: task.version, state: "applied" }; await this.writeConsumption(key, applied); return applied;
  }

  private async writeSlotBaseline(slot: HumanInteractionSlot): Promise<void> { const body = renderHumanInteractionSlot(slot); await this.put({ body, dependencies: [], digest: sha256(body), idempotencyKey: `human-slot:${slot.slotId}:${sha256(body)}`, key: slotKey(slot.slotId), kind: "system/human-interaction-slot", state: "active", version: "v1" }); }
  private async readSlotBaseline(slotId: string): Promise<HumanInteractionSlot> { const resource = await this.provider.getOptionalResource(slotKey(slotId)); if (resource === null || resource.kind !== "system/human-interaction-slot" || resource.state !== "active" || resource.version !== "v1" || resource.digest !== sha256(resource.body)) throw new Error("Human slot baseline Resource is missing or invalid"); const slots = parseHumanInteractionSlots(resource.body); if (slots.length !== 1 || slots[0]?.slotId !== slotId || slots[0].response !== null) throw new Error("Human slot baseline is invalid"); return slots[0]; }
  private async readConsumption(key: string): Promise<HumanConsumptionRecord | null> { const resource = await this.provider.getOptionalResource(key); if (resource === null) return null; if (resource.kind !== "system/human-consumption" || resource.state !== "active" || resource.version !== "v1" || resource.digest !== sha256(resource.body)) throw new Error("Human consumption Resource is invalid"); return parseConsumption(JSON.parse(resource.body) as unknown); }
  private async writeConsumption(key: string, record: HumanConsumptionRecord): Promise<void> { const body = canonicalize(toJsonValue(record)); await this.put({ body, dependencies: [], digest: sha256(body), idempotencyKey: `${key}:${record.state}:${sha256(body)}`, key, kind: "system/human-consumption", state: "active", version: "v1" }); }
  private async put(record: ResourceMutation): Promise<void> { await this.provider.putResource(record); const verified = await this.provider.getOptionalResource(record.key); if (verified === null || verified.digest !== record.digest || verified.body !== record.body) throw new Error(`Human recovery Resource did not verify: ${record.key}`); }
}

export function parseConsumption(value: unknown): HumanConsumptionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Human consumption must be an object"); const found = value as Record<string, unknown>;
  if (Object.keys(found).sort().join("\0") !== ["appliedTaskVersion", "authority", "schema", "sourceStatus", "state", "taskId"].sort().join("\0") || found.schema !== "human-consumption-v1" || (found.state !== "pending" && found.state !== "applied") || typeof found.sourceStatus !== "string" || found.sourceStatus === "" || typeof found.taskId !== "string" || found.taskId === "" || (found.appliedTaskVersion !== null && typeof found.appliedTaskVersion !== "string")) throw new TypeError("Human consumption fields are invalid");
  const authority = humanAuthority(found.authority); if ((found.state === "pending" && found.appliedTaskVersion !== null) || (found.state === "applied" && (typeof found.appliedTaskVersion !== "string" || found.appliedTaskVersion === ""))) throw new TypeError("Human consumption lifecycle is invalid");
  return { appliedTaskVersion: found.appliedTaskVersion as string | null, authority, schema: "human-consumption-v1", sourceStatus: found.sourceStatus, state: found.state, taskId: found.taskId };
}

function humanAuthority(value: unknown): HumanConsumptionRecord["authority"] { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Human authority is invalid"); const found = value as Record<string, unknown>; if (Object.keys(found).sort().join("\0") !== ["action", "responseDigest", "schema", "slotId", "targetStatus", "text"].sort().join("\0") || found.schema !== "human-authority-v1" || !digest(found.responseDigest) || !digest(found.slotId) || !strings(found, ["action", "targetStatus", "text"])) throw new TypeError("Human authority fields are invalid"); return { action: found.action as string, responseDigest: found.responseDigest as string, schema: "human-authority-v1", slotId: found.slotId as string, targetStatus: found.targetStatus as string, text: found.text as string }; }
function verifyConsumption(record: HumanConsumptionRecord, authority: HumanConsumptionRecord["authority"], taskId: string): void { if (record.taskId !== taskId || canonicalize(toJsonValue(record.authority)) !== canonicalize(toJsonValue(authority))) throw new Error("Human consumption identity conflicts with the current response"); }
function verifyTaskSlot(task: TaskSnapshot, slotId: string): void { requiredSlot(task, slotId); }
function requiredSlot(task: TaskSnapshot, slotId: string): HumanInteractionSlot { const matches = parseHumanInteractionSlots(task.body).filter((slot) => slot.slotId === slotId); if (matches.length !== 1) throw new Error(`Task must contain exactly one human slot: ${slotId}`); return matches[0]!; }
function requireStatuses(valid: readonly string[], requested: readonly string[]): void { const known = new Set(valid); for (const status of requested) if (!known.has(status)) throw new Error(`Human interaction route is not a valid Task status: ${status}`); }
function slotKey(slotId: string): string { return `human-slot/${slotId}`; }
function consumptionKey(slotId: string): string { return `human-consumption/${slotId}`; }
function digest(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function strings(value: Record<string, unknown>, fields: readonly string[]): boolean { return fields.every((field) => typeof value[field] === "string" && value[field] !== ""); }
export function statusProperties(task: TaskSnapshot): JsonObject { return structuredClone(task.properties); }
