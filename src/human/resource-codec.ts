/** Encodes and validates provider-backed human slot baselines and consumption records. */
import { canonicalize } from "../core/canonical-json.js";
import { digestJson, sha256 } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ResourceRecord } from "../domain/records.js";
import type {
  HumanAuthority,
  HumanConsumptionRecord,
  HumanSlotBaselineRecord,
} from "./contracts.js";
import { parseHumanInteractionSlot } from "./slot-codec.js";

/** Builds the deterministic provider key for this durable record. */
export function humanSlotResourceKey(slotId: string): string {
  return `human-slot/${slotId}`;
}
/** Builds the deterministic provider key for this durable record. */
export function humanConsumptionResourceKey(slotId: string): string {
  return `human-consumption/${slotId}`;
}

/** Serializes human slot baseline into its canonical representation. */
export function serializeHumanSlotBaseline(
  record: HumanSlotBaselineRecord,
): string {
  return canonicalize(toJsonValue(parseHumanSlotBaseline(record)));
}

/** Parses and validates human slot baseline resource. */
export function parseHumanSlotBaselineResource(
  resource: ResourceRecord,
  slotId: string,
): HumanSlotBaselineRecord {
  assertResource(
    resource,
    humanSlotResourceKey(slotId),
    "system/human-interaction-slot",
    "v2",
  );
  /** Stores baseline used by parse human slot baseline resource. */
  const baseline = parseHumanSlotBaseline(JSON.parse(resource.body) as unknown);
  if (baseline.slot.slotId !== slotId)
    throw new TypeError("Human slot baseline identity is invalid");
  return baseline;
}

/** Parses and validates human consumption resource. */
export function parseHumanConsumptionResource(
  resource: ResourceRecord,
  slotId: string,
): HumanConsumptionRecord {
  assertResource(
    resource,
    humanConsumptionResourceKey(slotId),
    "system/human-consumption",
    "v1",
  );
  /** Stores consumption used by parse human consumption resource. */
  const consumption = parseHumanConsumption(
    JSON.parse(resource.body) as unknown,
  );
  if (consumption.authority.slotId !== slotId)
    throw new TypeError("Human consumption identity is invalid");
  return consumption;
}

/** Parses and validates human consumption. */
export function parseHumanConsumption(value: unknown): HumanConsumptionRecord {
  /** Holds the parsed value being validated by parse human consumption. */
  const found = record(value, "Human consumption");
  closed(found, [
    "appliedTaskVersion",
    "authority",
    "schema",
    "sourceStatus",
    "sourceTaskVersion",
    "state",
    "taskId",
  ]);
  if (
    found.schema !== "human-consumption-v1" ||
    (found.state !== "pending" && found.state !== "applied") ||
    !isNonEmptyString(found.sourceStatus) ||
    !isNonEmptyString(found.sourceTaskVersion) ||
    !isNonEmptyString(found.taskId) ||
    (found.appliedTaskVersion !== null &&
      !isNonEmptyString(found.appliedTaskVersion))
  )
    throw new TypeError("Human consumption fields are invalid");
  /** Stores authority used by parse human consumption. */
  const authority = parseHumanAuthority(found.authority);
  if (
    (found.state === "pending" && found.appliedTaskVersion !== null) ||
    (found.state === "applied" && !isNonEmptyString(found.appliedTaskVersion))
  )
    throw new TypeError("Human consumption lifecycle is invalid");
  return {
    appliedTaskVersion: found.appliedTaskVersion as string | null,
    authority,
    schema: "human-consumption-v1",
    sourceStatus: found.sourceStatus,
    sourceTaskVersion: found.sourceTaskVersion,
    state: found.state,
    taskId: found.taskId,
  };
}

/** Parses and validates human slot baseline. */
function parseHumanSlotBaseline(value: unknown): HumanSlotBaselineRecord {
  /** Holds the parsed value being validated by parse human slot baseline. */
  const found = record(value, "Human slot baseline");
  closed(found, [
    "schema",
    "slot",
    "taskArchived",
    "taskBodyDigest",
    "taskProperties",
    "taskPropertiesDigest",
    "waitingStatus",
  ]);
  /** Stores task properties used by parse human slot baseline. */
  const taskProperties = jsonObject(
    found.taskProperties,
    "Human slot Task properties",
  );
  if (
    found.schema !== "human-slot-baseline-v2" ||
    typeof found.taskArchived !== "boolean" ||
    !isSha256Digest(found.taskBodyDigest) ||
    !isSha256Digest(found.taskPropertiesDigest) ||
    digestJson(taskProperties) !== found.taskPropertiesDigest ||
    !isNonEmptyString(found.waitingStatus)
  )
    throw new TypeError("Human slot baseline fields are invalid");
  /** Stores slot used by parse human slot baseline. */
  const slot = parseHumanInteractionSlot(found.slot);
  if (slot.response !== null)
    throw new TypeError("Human slot baseline response must be blank");
  return {
    schema: "human-slot-baseline-v2",
    slot,
    taskArchived: found.taskArchived,
    taskBodyDigest: found.taskBodyDigest,
    taskProperties,
    taskPropertiesDigest: found.taskPropertiesDigest,
    waitingStatus: found.waitingStatus,
  };
}

/** Parses and validates human authority. */
function parseHumanAuthority(value: unknown): HumanAuthority {
  /** Holds the parsed value being validated by parse human authority. */
  const found = record(value, "Human authority");
  closed(found, [
    "action",
    "responseDigest",
    "schema",
    "slotId",
    "targetStatus",
    "text",
  ]);
  if (
    found.schema !== "human-authority-v1" ||
    !isSha256Digest(found.responseDigest) ||
    !isSha256Digest(found.slotId) ||
    !isNonEmptyString(found.action) ||
    !isNonEmptyString(found.targetStatus) ||
    !isNonEmptyString(found.text)
  )
    throw new TypeError("Human authority fields are invalid");
  return {
    action: found.action,
    responseDigest: found.responseDigest,
    schema: "human-authority-v1",
    slotId: found.slotId,
    targetStatus: found.targetStatus,
    text: found.text,
  };
}

/** Rejects input that does not satisfy the resource contract. */
function assertResource(
  resource: ResourceRecord,
  key: string,
  kind: string,
  version: string,
): void {
  if (
    resource.key !== key ||
    resource.kind !== kind ||
    resource.state !== "active" ||
    resource.version !== version ||
    resource.digest !== sha256(resource.body)
  )
    throw new TypeError(`Human recovery Resource is invalid: ${key}`);
}
/** Validates and returns the required object representation. */
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}
/** Validates and returns a non-array JSON object. */
function jsonObject(value: unknown, label: string): JsonObject {
  return record(toJsonValue(value), label) as JsonObject;
}
/** Rejects objects whose keys differ from the expected closed shape. */
function closed(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0"))
    throw new TypeError(
      "Human recovery object has unexpected or missing fields",
    );
}
/** Returns whether a value is a lowercase SHA-256 digest. */
function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
/** Returns whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
