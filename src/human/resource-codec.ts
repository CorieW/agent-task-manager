/** Encodes and validates provider-backed human slot baselines and consumption records. */
import { canonicalize } from "../core/canonical-json.js";
import { digestJson, isSha256Digest, sha256 } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { OperationRecord } from "../domain/records.js";
import type {
  HumanAuthority,
  HumanConsumptionRecord,
  HumanSlotBaselineRecord,
} from "./contracts.js";
import { parseHumanInteractionSlot } from "./slot-codec.js";

/** Builds the deterministic provider key for this durable record. */
export function humanRequestOperationKey(slotId: string): string {
  return `human/request/${slotId}`;
}

/** Builds the deterministic provider key for this durable record. */
export function humanConsumptionOperationKey(slotId: string): string {
  return `human/consumption/${slotId}`;
}

/** Serializes human slot baseline into its canonical representation. */
export function serializeHumanSlotBaseline(
  record: HumanSlotBaselineRecord,
): string {
  return canonicalize(toJsonValue(parseHumanSlotBaseline(record)));
}

/** Parses and validates a human-request baseline Operation. */
export function parseHumanRequestOperation(
  operation: OperationRecord,
  slotId: string,
): HumanSlotBaselineRecord {
  assertOperation(
    operation,
    humanRequestOperationKey(slotId),
    "human/request-baseline",
    "v2",
  );
  /** Immutable baseline decoded from operational storage. */
  const baseline = parseHumanSlotBaseline(
    JSON.parse(operation.body) as unknown,
  );
  if (baseline.slot.slotId !== slotId)
    throw new TypeError("Human slot baseline identity is invalid");
  return baseline;
}

/** Parses and validates a human-response consumption Operation. */
export function parseHumanConsumptionOperation(
  operation: OperationRecord,
  slotId: string,
): HumanConsumptionRecord {
  assertOperation(
    operation,
    humanConsumptionOperationKey(slotId),
    "human/consumption",
    "v1",
  );
  /** Exactly-once consumption state decoded from operational storage. */
  const consumption = parseHumanConsumption(
    JSON.parse(operation.body) as unknown,
  );
  if (consumption.authority.slotId !== slotId)
    throw new TypeError("Human consumption identity is invalid");
  return consumption;
}

/** Parses and validates human consumption. */
export function parseHumanConsumption(value: unknown): HumanConsumptionRecord {
  /** Parsed candidate awaiting parse human consumption validation. */
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
  /** Parsed candidate awaiting parse human slot baseline validation. */
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
  /** Parsed candidate awaiting parse human authority validation. */
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

/** Rejects input that does not satisfy the Operation contract. */
function assertOperation(
  operation: OperationRecord,
  key: string,
  kind: string,
  version: string,
): void {
  if (
    operation.key !== key ||
    operation.kind !== kind ||
    operation.state !== "active" ||
    operation.version !== version ||
    operation.digest !== sha256(operation.body)
  )
    throw new TypeError(`Human recovery Operation is invalid: ${key}`);
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

/** Returns whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
