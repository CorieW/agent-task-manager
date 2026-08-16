/** Creates resolvable human requests and consumes each verified response exactly once. */
import { canonicalize } from "../core/canonical-json.js";
import { digestJson, sha256 } from "../core/digest.js";
import { taskPropertiesWithStatus } from "../core/task-properties.js";
import { toJsonValue } from "../domain/json.js";
import type {
  ErrorMutation,
  ResourceMutation,
  TaskSnapshot,
} from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type {
  HumanConsumptionRecord,
  HumanInteractionSlot,
  HumanSlotBaselineRecord,
} from "./contracts.js";
import {
  humanConsumptionResourceKey,
  humanSlotResourceKey,
  parseHumanConsumptionResource,
  parseHumanSlotBaselineResource,
  serializeHumanSlotBaseline,
} from "./resource-codec.js";
import {
  appendHumanInteractionSlot,
  createHumanInteractionSlot,
  parseHumanInteractionSlots,
  renderHumanInteractionSlot,
  verifyAllowedHumanDelta,
  type NewHumanInteractionSlot,
} from "./slot-codec.js";

/** Describes a durable human-interaction request and its allowed workflow routes. */
export interface HumanRequestInput extends NewHumanInteractionSlot {
  /** Failure captured by human request input. */
  readonly error: Omit<
    ErrorMutation,
    "idempotencyKey" | "relatedTaskId"
  > | null;
  /** Task status frozen before the human request was materialized. */
  readonly expectedTaskStatus?: string;
  /** Task version frozen before the human request was materialized. */
  readonly expectedTaskVersion?: string;
  /** Names the Task status that owns the unanswered slot. */
  readonly waitingStatus: string;
}

/** Reports the verified Task state after a human request is installed. */
export interface HumanRequestReceipt {
  /** The immutable slot baseline presented to the human. */
  readonly slot: HumanInteractionSlot;
  /** Confirms the waiting status observed after the write. */
  readonly status: string;
  /** Opaque version token for task. */
  readonly taskVersion: string;
}

/** Implements human recovery manager and its boundary checks. */
export class HumanRecoveryManager {
  /** Creates a recovery manager over the authoritative provider. */
  public constructor(
    /** Conditional Task writes and durable Resource records. */ private readonly provider: AgentTaskProvider,
  ) {}

  /** Installs a human slot and moves its Task to the requested waiting status. */
  public async request(input: HumanRequestInput): Promise<HumanRequestReceipt> {
    if (input.kind === "resolution" && input.error === null)
      throw new Error("Human resolution requests require a stable Error");
    /** Provider-declared statuses for route validation. */
    const statuses = await this.provider.listTaskStatusOptions();
    requireStatuses(statuses, [
      input.waitingStatus,
      ...Object.values(input.routes),
    ]);

    /** Materializes the immutable slot baseline from the request. */
    const slot = createHumanInteractionSlot(input);
    /** Mutable state recording the Task snapshot across conditional body and status writes. */
    let task = await this.provider.getTaskSnapshot(slot.taskId);
    if (task.archived)
      throw new Error("Cannot request human interaction for an archived Task");
    /** Detects retries against an already-installed slot. */
    const existingSlot = parseHumanInteractionSlots(task.body).find(
      (candidate) => candidate.slotId === slot.slotId,
    );
    if (
      existingSlot === undefined &&
      ((input.expectedTaskVersion !== undefined &&
        task.version !== input.expectedTaskVersion) ||
        (input.expectedTaskStatus !== undefined &&
          task.status !== input.expectedTaskStatus))
    )
      throw new Error("Task changed before the human request was installed");
    if (existingSlot !== undefined) {
      if (
        existingSlot.response === null &&
        canonicalize(toJsonValue(existingSlot)) !==
          canonicalize(toJsonValue(slot))
      )
        throw new Error("Existing human slot conflicts with its baseline");
      if (existingSlot.response !== null)
        verifyAllowedHumanDelta(slot, existingSlot);
    }

    /** Preserves an existing slot or appends the new canonical slot once. */
    const nextBody =
      existingSlot === undefined
        ? appendHumanInteractionSlot(task.body, slot)
        : task.body;
    /** Freezes all non-human Task properties at the waiting status. */
    const baselineProperties = taskPropertiesWithStatus(
      task.properties,
      input.waitingStatus,
    );

    await this.writeSlotBaseline({
      schema: "human-slot-baseline-v2",
      slot,
      taskArchived: task.archived,
      taskBodyDigest: sha256(normalizeText(nextBody)),
      taskProperties: baselineProperties,
      taskPropertiesDigest: digestJson(baselineProperties),
      waitingStatus: input.waitingStatus,
    });

    if (input.error !== null)
      await this.provider.createOrUpdateError({
        ...input.error,
        idempotencyKey: `human-error:${slot.slotId}:${digestJson(toJsonValue(input.error))}`,
        relatedTaskId: slot.taskId,
      });

    if (nextBody !== task.body) {
      await this.provider.applyTaskMutation({
        expectedVersion: task.version,
        idempotencyKey: `human-request:${slot.slotId}:slot`,
        nextBody,
        nextProperties: task.properties,
        nextStatus: null,
        taskId: task.id,
      });
      task = await this.provider.getTaskSnapshot(task.id);
      verifyTaskSlot(task, slot.slotId);
    }

    if (task.status !== input.waitingStatus) {
      await this.provider.applyTaskMutation({
        expectedVersion: task.version,
        idempotencyKey: `human-request:${slot.slotId}:status`,
        nextBody: null,
        nextProperties: task.properties,
        nextStatus: input.waitingStatus,
        taskId: task.id,
      });
      task = await this.provider.getTaskSnapshot(task.id);
    }

    if (task.status !== input.waitingStatus)
      throw new Error("Human request waiting status did not verify");
    verifyTaskSlot(task, slot.slotId);
    return { slot, status: task.status, taskVersion: task.version };
  }

  /** Installs a resolution slot whose sole route resumes the supplied status. */
  public async requestResolution(
    input: Omit<
      HumanRequestInput,
      "error" | "kind" | "routes" | "sourceErrorKey"
    > & {
      /** Failure captured by request resolution. */
      readonly error: Omit<ErrorMutation, "idempotencyKey" | "relatedTaskId">;
      /** Names the status restored after verified consumption. */
      readonly resumeStatus: string;
    },
  ): Promise<HumanRequestReceipt> {
    return this.request({
      ...input,
      kind: "resolution",
      routes: { resume: input.resumeStatus },
      sourceErrorKey: input.error.errorKey,
    });
  }

  /** Consumes one verified human response and applies its authorized transition once. */
  public async consume(
    taskId: string,
    slotId: string,
  ): Promise<HumanConsumptionRecord> {
    /** Loads the immutable machine-owned slot and Task baseline. */
    const baseline = await this.readSlotBaseline(slotId);
    if (baseline.slot.taskId !== taskId)
      throw new Error("Human slot belongs to another Task");

    /** Mutable state recording the Task snapshot across response verification and transition. */
    let task = await this.provider.getTaskSnapshot(taskId);
    /** Selects the human-edited slot from the current Task body. */
    const edited = requiredSlot(task, slotId);
    /** Derives the only status transition authorized by the response. */
    const authority = verifyAllowedHumanDelta(baseline.slot, edited);
    /** Addresses the durable exactly-once consumption record. */
    const key = humanConsumptionResourceKey(slotId);
    /** Loads a prior consumption attempt for crash-safe replay. */
    let consumption = await this.readConsumption(slotId);
    if (consumption === null) {
      if (task.status !== baseline.waitingStatus)
        throw new Error("Task is not in the human slot's waiting status");
      verifyTaskBasis(baseline, task, edited);
      consumption = {
        appliedTaskVersion: null,
        authority,
        schema: "human-consumption-v1",
        sourceStatus: baseline.waitingStatus,
        sourceTaskVersion: task.version,
        state: "pending",
        taskId,
      };
      await this.writeConsumption(key, consumption);
    } else {
      verifyConsumption(consumption, authority, taskId);
    }

    if (consumption.state === "applied") return consumption;
    verifyTaskBasis(baseline, task, edited);
    if (
      task.status !== consumption.sourceStatus &&
      task.status !== authority.targetStatus
    )
      throw new Error("Task status changed outside the human authority");

    /** Re-reads the edited slot before mutation to detect authority drift. */
    const currentEdited = requiredSlot(task, slotId);
    /** Rebuilds authority from the current response for digest comparison. */
    const currentAuthority = verifyAllowedHumanDelta(
      baseline.slot,
      currentEdited,
    );
    if (currentAuthority.responseDigest !== authority.responseDigest)
      throw new Error("Human response changed during consumption");
    verifyTaskBasis(baseline, task, currentEdited);

    await this.provider.applyTaskMutation({
      expectedVersion: consumption.sourceTaskVersion,
      idempotencyKey: `human-consume:${slotId}:${authority.responseDigest}`,
      nextBody: null,
      nextProperties: baseline.taskProperties,
      nextStatus: authority.targetStatus,
      taskId,
    });
    task = await this.provider.getTaskSnapshot(taskId);
    if (task.status !== authority.targetStatus)
      throw new Error("Human response transition did not verify");

    /** Finalizes the consumption record with the verified Task version. */
    const applied: HumanConsumptionRecord = {
      ...consumption,
      appliedTaskVersion: task.version,
      state: "applied",
    };
    await this.writeConsumption(key, applied);
    return applied;
  }

  /** Persists an immutable slot baseline, accepting only exact replay. */
  private async writeSlotBaseline(
    record: HumanSlotBaselineRecord,
  ): Promise<void> {
    /** Serializes the baseline into its canonical Resource body. */
    const body = serializeHumanSlotBaseline(record);
    /** Derives the stable Resource key from the slot identity. */
    const key = humanSlotResourceKey(record.slot.slotId);
    /** Detects retries before creating a new baseline Resource. */
    const existing = await this.provider.getOptionalResource(key);
    if (existing !== null) {
      /** Parses the existing Resource before exact replay comparison. */
      const parsed = parseHumanSlotBaselineResource(
        existing,
        record.slot.slotId,
      );
      if (serializeHumanSlotBaseline(parsed) !== body)
        throw new Error("Human slot baseline is immutable");
      return;
    }

    await this.putAndVerifyResource({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: `human-slot:${record.slot.slotId}:${sha256(body)}`,
      key,
      kind: "system/human-interaction-slot",
      state: "active",
      version: "v2",
    });
  }

  /** Reads and validates the immutable baseline for a human slot. */
  private async readSlotBaseline(
    slotId: string,
  ): Promise<HumanSlotBaselineRecord> {
    /** Loads the provider record addressed by the slot identity. */
    const resource = await this.provider.getOptionalResource(
      humanSlotResourceKey(slotId),
    );
    if (resource === null)
      throw new Error("Human slot baseline Resource is missing");
    return parseHumanSlotBaselineResource(resource, slotId);
  }

  /** Reads a prior consumption record when one has been reserved. */
  private async readConsumption(
    slotId: string,
  ): Promise<HumanConsumptionRecord | null> {
    /** Loads the provider record addressed by the consumption identity. */
    const resource = await this.provider.getOptionalResource(
      humanConsumptionResourceKey(slotId),
    );
    return resource === null
      ? null
      : parseHumanConsumptionResource(resource, slotId);
  }

  /** Persists and verifies a pending or applied consumption record. */
  private async writeConsumption(
    key: string,
    record: HumanConsumptionRecord,
  ): Promise<void> {
    /** Canonicalizes the record for stable hashing and replay. */
    const body = canonicalize(toJsonValue(record));
    await this.putAndVerifyResource({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: `${key}:${record.state}:${sha256(body)}`,
      key,
      kind: "system/human-consumption",
      state: "active",
      version: "v1",
    });
  }

  /** Writes a Resource and verifies its body and digest by read-back. */
  private async putAndVerifyResource(record: ResourceMutation): Promise<void> {
    await this.provider.putSystemResource(record);

    /** The authoritative post-write Resource for verification. */
    const verified = await this.provider.getOptionalResource(record.key);
    if (
      verified === null ||
      verified.digest !== record.digest ||
      verified.body !== record.body
    )
      throw new Error(`Human recovery Resource did not verify: ${record.key}`);
  }
}

/** Verifies that a replayed consumption belongs to the same response and Task. */
function verifyConsumption(
  record: HumanConsumptionRecord,
  authority: HumanConsumptionRecord["authority"],
  taskId: string,
): void {
  if (
    record.taskId !== taskId ||
    canonicalize(toJsonValue(record.authority)) !==
      canonicalize(toJsonValue(authority))
  )
    throw new Error(
      "Human consumption identity conflicts with the current response",
    );
}

/** Verifies task slot against authoritative state. */
function verifyTaskSlot(task: TaskSnapshot, slotId: string): void {
  requiredSlot(task, slotId);
}

/** Returns d slot or throws when invalid or absent. */
function requiredSlot(
  task: TaskSnapshot,
  slotId: string,
): HumanInteractionSlot {
  /** Result of `parseHumanInteractionSlots`, retained for the required slot operation. */
  const matches = parseHumanInteractionSlots(task.body).filter(
    (slot) => slot.slotId === slotId,
  );
  if (matches.length !== 1)
    throw new Error(`Task must contain exactly one human slot: ${slotId}`);
  return matches[0]!;
}

/** Returns statuses or throws when invalid or absent. */
function requireStatuses(
  valid: readonly string[],
  requested: readonly string[],
): void {
  /** Seen known values used to reject duplicates. */
  const known = new Set(valid);
  for (const status of requested)
    if (!known.has(status))
      throw new Error(
        `Human interaction route is not a valid Task status: ${status}`,
      );
}

/** Verifies task basis against authoritative state. */
function verifyTaskBasis(
  baseline: HumanSlotBaselineRecord,
  task: TaskSnapshot,
  edited: HumanInteractionSlot,
): void {
  if (task.archived !== baseline.taskArchived)
    throw new Error("Human response changed Task archive state");
  /** Result of `renderHumanInteractionSlot`, retained for the verify task basis operation. */
  const rendered = renderHumanInteractionSlot(edited);
  /** Result of `normalizeText`, retained for the verify task basis operation. */
  const occurrences = normalizeText(task.body).split(rendered).length - 1;
  if (occurrences !== 1)
    throw new Error("Human response changed the canonical slot representation");
  /** Result of `normalizeText`, retained for the verify task basis operation. */
  const maskedBody = normalizeText(task.body).replace(
    rendered,
    renderHumanInteractionSlot(baseline.slot),
  );
  if (sha256(maskedBody) !== baseline.taskBodyDigest)
    throw new Error("Human response changed unrelated Task body content");
  /** Result of `taskPropertiesWithStatus`, retained for the verify task basis operation. */
  const maskedProperties = taskPropertiesWithStatus(
    task.properties,
    baseline.waitingStatus,
  );
  if (digestJson(maskedProperties) !== baseline.taskPropertiesDigest)
    throw new Error("Human response changed unrelated Task properties");
}

/** Normalizes the value into its canonical boundary representation. */
function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}

export { parseHumanConsumption as parseConsumption } from "./resource-codec.js";
