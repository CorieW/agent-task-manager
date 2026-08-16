/** Defines bounded provider-neutral task candidate queries loaded from Resources. */
import { digestJson } from "./digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type {
  SubAgentDefinition,
  TaskQuery,
  TaskSummary,
} from "../domain/records.js";

/** Exact fields allowed in a Task query Resource. */
const TASK_QUERY_FIELDS = new Set([
  "archived",
  "id",
  "priority",
  "status",
  "title",
  "version",
]);

/** Canonical fields for task query contract. */
export interface TaskQueryContract {
  /** Dependency satisfied statuses included in task query contract. */
  readonly dependencySatisfiedStatuses: readonly string[];
  /** Limit for task query contract. */
  readonly limit: number;
  /** Predicate for task query contract. */
  readonly predicate: JsonObject;
  /** Schema discriminator for the serialized representation. */
  readonly schema: "task-query-v1";
}

/** Canonical fields for candidate set. */
export interface CandidateSet {
  /** SHA-256 digest of the candidate-set query and summaries. */
  readonly digest: string;
  /** SHA-256 digest of canonical query content. */
  readonly queryDigest: string;
  /** Summaries included in candidate set. */
  readonly summaries: readonly TaskSummary[];
}

/** Parses a bounded provider-neutral Task query Resource. */
export function parseTaskQueryContract(body: string): TaskQueryContract {
  /** JSON-decoded input before structural validation. */
  const raw: unknown = JSON.parse(body);
  /** Object currently undergoing field-level validation. */
  const value = objectValue(toJsonValue(raw), "Task query");
  assertExactKeys(
    value,
    ["dependencySatisfiedStatuses", "limit", "predicate", "schema"],
    "Task query",
  );
  if (value.schema !== "task-query-v1")
    throw new TypeError("Task query schema is invalid");
  if (
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > 100
  )
    throw new TypeError("Task query limit must be from 1 to 100");
  /** Statuses used during parse task query contract. */
  const statuses = stringArray(
    value.dependencySatisfiedStatuses,
    "dependencySatisfiedStatuses",
  );
  /** Predicate used during parse task query contract. */
  const predicate = objectValue(value.predicate, "Task query predicate");
  for (const [key, expected] of Object.entries(predicate)) {
    if (!TASK_QUERY_FIELDS.has(key))
      throw new TypeError(`Task query predicate field is unsupported: ${key}`);
    if (
      expected !== null &&
      typeof expected !== "boolean" &&
      typeof expected !== "number" &&
      typeof expected !== "string"
    ) {
      throw new TypeError(`Task query predicate ${key} must be a scalar`);
    }
  }
  return {
    dependencySatisfiedStatuses: statuses,
    limit: value.limit as number,
    predicate,
    schema: value.schema,
  };
}

/** Constrains a Task query to the definition's candidate-summary budget. */
export function taskQueryForDefinition(
  contract: TaskQueryContract,
  definition: SubAgentDefinition,
): TaskQuery {
  if (contract.limit > definition.selection.maxCandidateSummaries)
    throw new Error(
      "Task query exceeds the definition candidate-summary limit",
    );
  return { cursor: null, limit: contract.limit, predicate: contract.predicate };
}

/** Sorts Task summaries and binds them to the task-query digest. */
export function finalizeCandidateSet(
  contract: TaskQueryContract,
  summaries: readonly TaskSummary[],
): CandidateSet {
  /** Ordered arranged in deterministic order. */
  const ordered = [...summaries].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  /** Canonical digest of query. */
  const queryDigest = digestJson(toJsonValue(contract));
  return {
    digest: digestJson(toJsonValue({ queryDigest, summaries: ordered })),
    queryDigest,
    summaries: ordered.map((summary) => structuredClone(summary)),
  };
}

/** Rejects objects with missing or unexpected fields. */
function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    throw new TypeError(`${label} has unexpected or missing fields`);
}
/** Requires a field value to be a non-array JSON object. */
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new TypeError(`${label} must be an object`);
  return value;
}
/** Requires an array containing only strings. */
function stringArray(
  value: JsonValue | undefined,
  label: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item === "")
  )
    throw new TypeError(`${label} must contain non-empty strings`);
  if (new Set(value).size !== value.length)
    throw new TypeError(`${label} contains duplicates`);
  return value as string[];
}
