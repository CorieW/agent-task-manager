/** Creates resolvable human requests and consumes each verified response exactly once. */
import { canonicalize } from "../core/canonical-json.js";
import { digestJson, sha256 } from "../core/digest.js";
import { taskPropertiesWithStatus } from "../core/task-properties.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type {
  ErrorMutation,
  OperationMutation,
  TaskSnapshot,
} from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type {
  HumanConsumptionRecord,
  HumanInteractionSlot,
  HumanSlotBaselineRecord,
} from "./contracts.js";
import {
  humanConsumptionOperationKey,
  humanRequestOperationKey,
  parseHumanConsumptionOperation,
  parseHumanRequestOperation,
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
  /** Complete Task body to install before appending the human slot. */
  readonly nextTaskBody?: string;
  /** Complete Task properties to install with the human slot. */
  readonly nextTaskProperties?: JsonObject;
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
    /** Conditional Task writes and durable operational records. */ private readonly provider: AgentTaskProvider,
  ) {}

  /** Installs a human slot and moves its Task to the requested waiting status. */
  public async request(input: HumanRequestInput): Promise<HumanRequestReceipt> {
    if (input.kind === "resolution" && input.error === null)
      throw new Error("Human resolution requests require a stable Error");
    /** Provider-declared statuses for route validation. */
    const statuses = await this.provider.listTaskStatusOptions();
    /** Task properties whose values are projections of other manager-owned records. */
    const derivedPropertyNames =
      await this.provider.listDerivedTaskPropertyNames();
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
        ? appendHumanInteractionSlot(input.nextTaskBody ?? task.body, slot)
        : task.body;
    /** Task properties including any manager-owned role output. */
    const nextProperties = input.nextTaskProperties ?? task.properties;
    /** Baseline properties including manager-owned updates made with this request. */
    const updatedBaselineProperties = taskPropertiesWithStatus(
      withoutDerivedProperties(nextProperties, derivedPropertyNames),
      input.waitingStatus,
    );

    await this.writeSlotBaseline(
      {
        schema: "human-slot-baseline-v2",
        slot,
        taskArchived: task.archived,
        taskBodyDigest: sha256(normalizeText(nextBody)),
        taskProperties: updatedBaselineProperties,
        taskPropertiesDigest: digestJson(updatedBaselineProperties),
        waitingStatus: input.waitingStatus,
      },
      derivedPropertyNames,
    );

    if (input.error !== null)
      await this.provider.createOrUpdateError({
        ...input.error,
        idempotencyKey: `human-error:${slot.slotId}:${digestJson(toJsonValue(input.error))}`,
        relatedTaskId: slot.taskId,
      });

    if (
      nextBody !== task.body ||
      digestJson(nextProperties) !== digestJson(task.properties)
    ) {
      await this.provider.applyTaskMutation({
        expectedVersion: task.version,
        idempotencyKey: `human-request:${slot.slotId}:slot`,
        nextBody,
        nextProperties,
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
    /** Task properties allowed to change as manager-owned projections advance. */
    const derivedPropertyNames =
      await this.provider.listDerivedTaskPropertyNames();

    /** Mutable state recording the Task snapshot across response verification and transition. */
    let task = await this.provider.getTaskSnapshot(taskId);
    /** Selects the human-edited slot from the current Task body. */
    const edited = requiredSlot(task, slotId);
    /** Derives the only status transition authorized by the response. */
    const authority = verifyAllowedHumanDelta(baseline.slot, edited);
    /** Addresses the durable exactly-once consumption record. */
    const key = humanConsumptionOperationKey(slotId);
    /** Loads a prior consumption attempt for crash-safe replay. */
    let consumption = await this.readConsumption(slotId);
    if (consumption === null) {
      if (task.status !== baseline.waitingStatus)
        throw new Error("Task is not in the human slot's waiting status");
      verifyTaskBasis(baseline, task, edited, derivedPropertyNames);
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
    verifyTaskBasis(baseline, task, edited, derivedPropertyNames);
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
    verifyTaskBasis(baseline, task, currentEdited, derivedPropertyNames);

    await this.provider.applyTaskMutation({
      expectedVersion: consumption.sourceTaskVersion,
      idempotencyKey: `human-consume:${slotId}:${authority.responseDigest}`,
      nextBody: null,
      nextProperties: withoutDerivedProperties(
        baseline.taskProperties,
        derivedPropertyNames,
      ),
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
    derivedPropertyNames: readonly string[],
  ): Promise<void> {
    /** Serializes the baseline into its canonical Operation body. */
    const body = serializeHumanSlotBaseline(record);
    /** Derives the stable Operation key from the slot identity. */
    const key = humanRequestOperationKey(record.slot.slotId);
    /** Detects retries before creating a new baseline Operation. */
    const existing = await this.provider.getOptionalOperation(key);
    if (existing !== null) {
      /** Parses the existing Operation before exact replay comparison. */
      const parsed = parseHumanRequestOperation(existing, record.slot.slotId);
      if (!sameHumanSlotBaseline(parsed, record, derivedPropertyNames))
        throw new Error("Human slot baseline is immutable");
      return;
    }

    await this.putAndVerifyOperation({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: `human-slot:${record.slot.slotId}:${sha256(body)}`,
      key,
      kind: "human/request-baseline",
      state: "active",
      version: "v2",
    });
  }

  /** Reads and validates the immutable baseline for a human slot. */
  private async readSlotBaseline(
    slotId: string,
  ): Promise<HumanSlotBaselineRecord> {
    /** Loads the provider record addressed by the slot identity. */
    const operation = await this.provider.getOptionalOperation(
      humanRequestOperationKey(slotId),
    );
    if (operation === null)
      throw new Error("Human request baseline Operation is missing");
    return parseHumanRequestOperation(operation, slotId);
  }

  /** Reads a prior consumption record when one has been reserved. */
  private async readConsumption(
    slotId: string,
  ): Promise<HumanConsumptionRecord | null> {
    /** Loads the provider record addressed by the consumption identity. */
    const operation = await this.provider.getOptionalOperation(
      humanConsumptionOperationKey(slotId),
    );
    return operation === null
      ? null
      : parseHumanConsumptionOperation(operation, slotId);
  }

  /** Persists and verifies a pending or applied consumption record. */
  private async writeConsumption(
    key: string,
    record: HumanConsumptionRecord,
  ): Promise<void> {
    /** Canonicalizes the record for stable hashing and replay. */
    const body = canonicalize(toJsonValue(record));
    await this.putAndVerifyOperation({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: `${key}:${record.state}:${sha256(body)}`,
      key,
      kind: "human/consumption",
      state: "active",
      version: "v1",
    });
  }

  /** Writes operational state and verifies its body and digest by read-back. */
  private async putAndVerifyOperation(
    record: OperationMutation,
  ): Promise<void> {
    await this.provider.putOperation(record);

    /** The authoritative post-write Operation used for verification. */
    const verified = await this.provider.getOptionalOperation(record.key);
    if (
      verified === null ||
      verified.digest !== record.digest ||
      verified.body !== record.body
    )
      throw new Error(`Human recovery operation did not verify: ${record.key}`);
  }
}

/** Compares immutable baselines while ignoring provider ordering of identity sets. */
function sameHumanSlotBaseline(
  left: HumanSlotBaselineRecord,
  right: HumanSlotBaselineRecord,
  derivedPropertyNames: readonly string[],
): boolean {
  /** Canonical left-hand properties with unordered identity collections normalized. */
  const leftProperties = normalizePropertyCollections(
    withoutDerivedProperties(left.taskProperties, derivedPropertyNames),
  );
  /** Canonical right-hand properties with unordered identity collections normalized. */
  const rightProperties = normalizePropertyCollections(
    withoutDerivedProperties(right.taskProperties, derivedPropertyNames),
  );
  return (
    canonicalize(
      toJsonValue({
        ...left,
        taskProperties: leftProperties,
        taskPropertiesDigest: digestJson(leftProperties),
      }),
    ) ===
    canonicalize(
      toJsonValue({
        ...right,
        taskProperties: rightProperties,
        taskPropertiesDigest: digestJson(rightProperties),
      }),
    )
  );
}

/** Normalizes set-like Task property collections without reordering ordinary arrays. */
function normalizePropertyCollections(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    /** Recursively normalized collection entries used for stable comparison. */
    const normalized = value.map(normalizePropertyCollections);
    if (normalized.every((item) => typeof item === "string"))
      return [...normalized].sort();
    if (
      normalized.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof item.id === "string",
      )
    )
      return [...normalized].sort((left, right) => {
        if (
          left === null ||
          right === null ||
          Array.isArray(left) ||
          Array.isArray(right) ||
          typeof left !== "object" ||
          typeof right !== "object" ||
          typeof left.id !== "string" ||
          typeof right.id !== "string"
        )
          return 0;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
    return normalized;
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizePropertyCollections(item),
      ]),
    );
  return value;
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
  /** Stores matches used by required slot. */
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
  derivedPropertyNames: readonly string[],
): void {
  if (task.archived !== baseline.taskArchived)
    throw new Error("Human response changed Task archive state");
  /** Stores rendered used by verify task basis. */
  const rendered = renderHumanInteractionSlot(edited);
  /** Number of exact managed-slot occurrences in the canonical task body. */
  const occurrences = normalizeText(task.body).split(rendered).length - 1;
  if (occurrences !== 1)
    throw new Error("Human response changed the canonical slot representation");
  /** Canonical task body with the managed slot removed for basis hashing. */
  const maskedBody = normalizeText(task.body).replace(
    rendered,
    renderHumanInteractionSlot(baseline.slot),
  );
  if (sha256(maskedBody) !== baseline.taskBodyDigest)
    throw new Error("Human response changed unrelated Task body content");
  /** Stores masked properties used by verify task basis. */
  const maskedProperties = normalizePropertyCollections(
    taskPropertiesWithStatus(
      withoutDerivedProperties(task.properties, derivedPropertyNames),
      baseline.waitingStatus,
    ),
  );
  /** Baseline properties after removing provider-derived projections from older records. */
  const protectedBaseline = normalizePropertyCollections(
    withoutDerivedProperties(baseline.taskProperties, derivedPropertyNames),
  );
  if (digestJson(maskedProperties) !== digestJson(protectedBaseline)) {
    /** Property names that changed outside the designated human-response field. */
    const changed = differingPropertyNames(
      maskedProperties as JsonObject,
      protectedBaseline as JsonObject,
    );
    throw new Error(
      `Human response changed unrelated Task properties: ${changed.join(", ")}`,
    );
  }
}

/** Omits Task properties whose values are derived from authoritative state elsewhere. */
function withoutDerivedProperties(
  properties: JsonObject,
  derivedPropertyNames: readonly string[],
): JsonObject {
  /** Derived-property names excluded from human-authored Task comparisons and writes. */
  const excluded = new Set(derivedPropertyNames);
  return Object.fromEntries(
    Object.entries(properties).filter(([name]) => !excluded.has(name)),
  );
}

/** Returns top-level Task property names whose normalized values differ. */
function differingPropertyNames(
  left: JsonObject,
  right: JsonObject,
): readonly string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(
      (name) =>
        Object.hasOwn(left, name) !== Object.hasOwn(right, name) ||
        canonicalize(left[name] ?? null) !== canonicalize(right[name] ?? null),
    )
    .sort();
}

/** Normalizes the value into its canonical boundary representation. */
function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}

export { parseHumanConsumption as parseConsumption } from "./resource-codec.js";
