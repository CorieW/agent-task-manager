/** Provider-neutral bounded provider-neutral task candidate queries loaded from Resources contract. */
import { digestJson } from "./digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type {
  AgentDefinition,
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

/** Maximum number of workflow statuses accepted by one Task query. */
const MAX_STATUS_PREDICATE_VALUES = 20;

/** Bounded Task-selection query loaded from an immutable Resource. */
export interface TaskQueryContract {
  /** Statuses that count as complete when evaluating Task dependencies. */
  readonly dependencySatisfiedStatuses: readonly string[];
  /** Maximum provider summaries to return, inclusive from 1 through 100. */
  readonly limit: number;
  /** Exact provider-neutral field matches used to select candidate Tasks. */
  readonly predicate: JsonObject;
  /** Schema discriminator for the serialized representation. */
  readonly schema: "task-query-v1";
}

/** Deterministically ordered Task summaries bound to their source query. */
export interface CandidateSet {
  /** SHA-256 digest of the candidate-set query and summaries. */
  readonly digest: string;
  /** SHA-256 digest of canonical query content. */
  readonly queryDigest: string;
  /** Detached summaries ordered by Task ID. */
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

  /** Dependency statuses validated independently of the selection predicate. */
  const dependencySatisfiedStatuses = stringArray(
    value.dependencySatisfiedStatuses,
    "dependencySatisfiedStatuses",
  );

  /** Closed predicate whose entries are validated before provider use. */
  const predicate = objectValue(value.predicate, "Task query predicate");
  for (const [key, expected] of Object.entries(predicate)) {
    if (!TASK_QUERY_FIELDS.has(key))
      throw new TypeError(`Task query predicate field is unsupported: ${key}`);
    if (key === "status" && Array.isArray(expected)) {
      /** Classifies the shared bounded status-array constraints. */
      const issue = statusPredicateIssue(expected);
      if (issue === "invalid_value")
        throw new TypeError(
          "Task query predicate status must contain non-empty strings",
        );
      if (issue === "duplicate")
        throw new TypeError("Task query predicate status contains duplicates");
      if (issue === "empty")
        throw new TypeError(
          "Task query predicate status must contain at least one value",
        );
      if (issue === "too_many")
        throw new TypeError(
          `Task query predicate status cannot exceed ${MAX_STATUS_PREDICATE_VALUES} values`,
        );
      continue;
    }
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
    dependencySatisfiedStatuses,
    limit: value.limit as number,
    predicate,
    schema: value.schema,
  };
}

/** Reports whether a Task summary satisfies a validated Task-query predicate. */
export function taskSummaryMatchesPredicate(
  summary: TaskSummary,
  predicate: JsonObject,
): boolean {
  return Object.entries(predicate).every(([key, expected]) => {
    /** Summary field compared with the predicate's expected value. */
    const actualValue = summary[key as keyof TaskSummary];
    if (!Array.isArray(expected)) return Object.is(actualValue, expected);
    /** Classifies the same bounded status-array constraints at this direct boundary. */
    const issue = statusPredicateIssue(expected);
    if (key !== "status" || issue !== null) {
      throw new TypeError(`Unsupported task predicate: ${key}`);
    }
    return (expected as readonly string[]).some((candidate) =>
      Object.is(actualValue, candidate),
    );
  });
}

/** Constrains a Task query to the definition's candidate-summary budget. */
export function taskQueryForDefinition(
  contract: TaskQueryContract,
  definition: AgentDefinition,
): TaskQuery {
  if (contract.limit > definition.selection.maxCandidateSummaries)
    throw new Error(
      "Task query exceeds the definition candidate-summary limit",
    );
  return {
    cursor: null,
    dependencySatisfiedStatuses: contract.dependencySatisfiedStatuses,
    limit: contract.limit,
    predicate: contract.predicate,
  };
}

/** Sorts Task summaries and binds them to the task-query digest. */
export function finalizeCandidateSet(
  contract: TaskQueryContract,
  summaries: readonly TaskSummary[],
): CandidateSet {
  /** Detached summaries ordered deterministically before digest construction. */
  const orderedSummaries = [...summaries].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  /** Digest binding the complete canonical Task-query contract. */
  const queryDigest = digestJson(toJsonValue(contract));
  return {
    digest: digestJson(
      toJsonValue({ queryDigest, summaries: orderedSummaries }),
    ),
    queryDigest,
    summaries: orderedSummaries.map((summary) => structuredClone(summary)),
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

/** Enumerates failures of the shared bounded status-array contract. */
type StatusPredicateIssue =
  "duplicate" | "empty" | "invalid_value" | "too_many";

/** Classifies a status-array predicate without choosing boundary-specific errors. */
function statusPredicateIssue(
  values: readonly JsonValue[],
): StatusPredicateIssue | null {
  if (values.some((value) => typeof value !== "string" || value === ""))
    return "invalid_value";
  if (new Set(values).size !== values.length) return "duplicate";
  if (values.length === 0) return "empty";
  if (values.length > MAX_STATUS_PREDICATE_VALUES) return "too_many";
  return null;
}
