// Creates resolvable human requests and consumes each verified response exactly once.
import { canonicalize } from "../core/canonical-json.js";
import { digestJson, sha256 } from "../core/digest.js";
import { taskPropertiesWithStatus } from "../core/task-properties.js";
import { toJsonValue } from "../domain/json.js";
import type { ErrorMutation, ResourceMutation, TaskSnapshot } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { HumanConsumptionRecord, HumanInteractionSlot, HumanSlotBaselineRecord } from "./contracts.js";
import { humanConsumptionResourceKey, humanSlotResourceKey, parseHumanConsumption, parseHumanConsumptionResource, parseHumanSlotBaselineResource, serializeHumanSlotBaseline } from "./resource-codec.js";
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
    const existingSlot = parseHumanInteractionSlots(task.body).find((candidate) => candidate.slotId === slot.slotId);
    if (existingSlot !== undefined) {
      if (existingSlot.response === null && canonicalize(toJsonValue(existingSlot)) !== canonicalize(toJsonValue(slot))) throw new Error("Existing human slot conflicts with its baseline");
      if (existingSlot.response !== null) verifyAllowedHumanDelta(slot, existingSlot);
    }
    const nextBody = existingSlot === undefined ? appendHumanInteractionSlot(task.body, slot) : task.body;
    const baselineProperties = taskPropertiesWithStatus(task.properties, input.waitingStatus);
    await this.writeSlotBaseline({
      schema: "human-slot-baseline-v2",
      slot,
      taskArchived: task.archived,
      taskBodyDigest: sha256(normalizeText(nextBody)),
      taskProperties: baselineProperties,
      taskPropertiesDigest: digestJson(baselineProperties),
      waitingStatus: input.waitingStatus,
    });
    if (input.error !== null) await this.provider.createOrUpdateError({ ...input.error, idempotencyKey: `human-error:${slot.slotId}:${digestJson(toJsonValue(input.error))}`, relatedTaskId: slot.taskId });
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
    const baseline = await this.readSlotBaseline(slotId); if (baseline.slot.taskId !== taskId) throw new Error("Human slot belongs to another Task");
    let task = await this.provider.getTaskSnapshot(taskId); const edited = requiredSlot(task, slotId); const authority = verifyAllowedHumanDelta(baseline.slot, edited);
    const key = humanConsumptionResourceKey(slotId); let consumption = await this.readConsumption(slotId);
    if (consumption === null) {
      if (task.status !== baseline.waitingStatus) throw new Error("Task is not in the human slot's waiting status");
      verifyTaskBasis(baseline, task, edited);
      consumption = { appliedTaskVersion: null, authority, schema: "human-consumption-v1", sourceStatus: baseline.waitingStatus, sourceTaskVersion: task.version, state: "pending", taskId };
      await this.writeConsumption(key, consumption);
    } else { verifyConsumption(consumption, authority, taskId); }
    if (consumption.state === "applied") return consumption;
    verifyTaskBasis(baseline, task, edited);
    if (task.status !== consumption.sourceStatus && task.status !== authority.targetStatus) throw new Error("Task status changed outside the human authority");
    const currentEdited = requiredSlot(task, slotId); const currentAuthority = verifyAllowedHumanDelta(baseline.slot, currentEdited); if (currentAuthority.responseDigest !== authority.responseDigest) throw new Error("Human response changed during consumption");
    verifyTaskBasis(baseline, task, currentEdited);
    await this.provider.applyTaskMutation({ expectedVersion: consumption.sourceTaskVersion, idempotencyKey: `human-consume:${slotId}:${authority.responseDigest}`, nextBody: null, nextProperties: baseline.taskProperties, nextStatus: authority.targetStatus, taskId });
    task = await this.provider.getTaskSnapshot(taskId);
    if (task.status !== authority.targetStatus) throw new Error("Human response transition did not verify");
    const applied: HumanConsumptionRecord = { ...consumption, appliedTaskVersion: task.version, state: "applied" }; await this.writeConsumption(key, applied); return applied;
  }

  private async writeSlotBaseline(record: HumanSlotBaselineRecord): Promise<void> {
    const body = serializeHumanSlotBaseline(record);
    const key = humanSlotResourceKey(record.slot.slotId);
    const existing = await this.provider.getOptionalResource(key);
    if (existing !== null) {
      const parsed = parseHumanSlotBaselineResource(existing, record.slot.slotId);
      if (serializeHumanSlotBaseline(parsed) !== body) throw new Error("Human slot baseline is immutable");
      return;
    }
    await this.put({ body, dependencies: [], digest: sha256(body), idempotencyKey: `human-slot:${record.slot.slotId}:${sha256(body)}`, key, kind: "system/human-interaction-slot", state: "active", version: "v2" });
  }
  private async readSlotBaseline(slotId: string): Promise<HumanSlotBaselineRecord> { const resource = await this.provider.getOptionalResource(humanSlotResourceKey(slotId)); if (resource === null) throw new Error("Human slot baseline Resource is missing"); return parseHumanSlotBaselineResource(resource, slotId); }
  private async readConsumption(slotId: string): Promise<HumanConsumptionRecord | null> { const resource = await this.provider.getOptionalResource(humanConsumptionResourceKey(slotId)); return resource === null ? null : parseHumanConsumptionResource(resource, slotId); }
  private async writeConsumption(key: string, record: HumanConsumptionRecord): Promise<void> { const body = canonicalize(toJsonValue(record)); await this.put({ body, dependencies: [], digest: sha256(body), idempotencyKey: `${key}:${record.state}:${sha256(body)}`, key, kind: "system/human-consumption", state: "active", version: "v1" }); }
  private async put(record: ResourceMutation): Promise<void> { await this.provider.putResource(record); const verified = await this.provider.getOptionalResource(record.key); if (verified === null || verified.digest !== record.digest || verified.body !== record.body) throw new Error(`Human recovery Resource did not verify: ${record.key}`); }
}

function verifyConsumption(record: HumanConsumptionRecord, authority: HumanConsumptionRecord["authority"], taskId: string): void { if (record.taskId !== taskId || canonicalize(toJsonValue(record.authority)) !== canonicalize(toJsonValue(authority))) throw new Error("Human consumption identity conflicts with the current response"); }
function verifyTaskSlot(task: TaskSnapshot, slotId: string): void { requiredSlot(task, slotId); }
function requiredSlot(task: TaskSnapshot, slotId: string): HumanInteractionSlot { const matches = parseHumanInteractionSlots(task.body).filter((slot) => slot.slotId === slotId); if (matches.length !== 1) throw new Error(`Task must contain exactly one human slot: ${slotId}`); return matches[0]!; }
function requireStatuses(valid: readonly string[], requested: readonly string[]): void { const known = new Set(valid); for (const status of requested) if (!known.has(status)) throw new Error(`Human interaction route is not a valid Task status: ${status}`); }
function verifyTaskBasis(baseline: HumanSlotBaselineRecord, task: TaskSnapshot, edited: HumanInteractionSlot): void {
  if (task.archived !== baseline.taskArchived) throw new Error("Human response changed Task archive state");
  const rendered = renderHumanInteractionSlot(edited);
  const occurrences = normalizeText(task.body).split(rendered).length - 1;
  if (occurrences !== 1) throw new Error("Human response changed the canonical slot representation");
  const maskedBody = normalizeText(task.body).replace(rendered, renderHumanInteractionSlot(baseline.slot));
  if (sha256(maskedBody) !== baseline.taskBodyDigest) throw new Error("Human response changed unrelated Task body content");
  const maskedProperties = taskPropertiesWithStatus(task.properties, baseline.waitingStatus);
  if (digestJson(maskedProperties) !== baseline.taskPropertiesDigest) throw new Error("Human response changed unrelated Task properties");
}
function normalizeText(value: string): string { return value.replace(/\r\n?/gu, "\n").normalize("NFC"); }

export { parseHumanConsumption as parseConsumption } from "./resource-codec.js";
