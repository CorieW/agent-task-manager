/** Defines bounded provider-neutral task candidate queries loaded from Resources. */
import { digestJson } from "./digest.js";
import { toJsonValue, type JsonObject, type JsonValue } from "../domain/json.js";
import type { SubAgentDefinition, TaskQuery, TaskSummary } from "../domain/records.js";

const TASK_QUERY_FIELDS = new Set(["archived", "id", "priority", "status", "title", "version"]);

export interface TaskQueryContract {
  readonly dependencySatisfiedStatuses: readonly string[];
  readonly limit: number;
  readonly predicate: JsonObject;
  readonly schema: "task-query-v1";
}

export interface CandidateSet {
  readonly digest: string;
  readonly queryDigest: string;
  readonly summaries: readonly TaskSummary[];
}

export function parseTaskQueryContract(body: string): TaskQueryContract {
  const raw: unknown = JSON.parse(body);
  const value = objectValue(toJsonValue(raw), "Task query");
  assertExactKeys(value, ["dependencySatisfiedStatuses", "limit", "predicate", "schema"], "Task query");
  if (value.schema !== "task-query-v1") throw new TypeError("Task query schema is invalid");
  if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100) throw new TypeError("Task query limit must be from 1 to 100");
  const statuses = stringArray(value.dependencySatisfiedStatuses, "dependencySatisfiedStatuses");
  const predicate = objectValue(value.predicate, "Task query predicate");
  for (const [key, expected] of Object.entries(predicate)) {
    if (!TASK_QUERY_FIELDS.has(key)) throw new TypeError(`Task query predicate field is unsupported: ${key}`);
    if (expected !== null && typeof expected !== "boolean" && typeof expected !== "number" && typeof expected !== "string") {
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

export function taskQueryForDefinition(
  contract: TaskQueryContract,
  definition: SubAgentDefinition,
): TaskQuery {
  if (contract.limit > definition.selection.maxCandidateSummaries) throw new Error("Task query exceeds the definition candidate-summary limit");
  return { cursor: null, limit: contract.limit, predicate: contract.predicate };
}

export function finalizeCandidateSet(
  contract: TaskQueryContract,
  summaries: readonly TaskSummary[],
): CandidateSet {
  const ordered = [...summaries].sort((left, right) => left.id.localeCompare(right.id));
  const queryDigest = digestJson(toJsonValue(contract));
  return {
    digest: digestJson(toJsonValue({ queryDigest, summaries: ordered })),
    queryDigest,
    summaries: ordered.map((summary) => structuredClone(summary)),
  };
}

function assertExactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) throw new TypeError(`${label} has unexpected or missing fields`);
}
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function stringArray(value: JsonValue | undefined, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) throw new TypeError(`${label} must contain non-empty strings`);
  if (new Set(value).size !== value.length) throw new TypeError(`${label} contains duplicates`);
  return value as string[];
}
