/** Validates the closed task-selection result exchanged with provider-defined selectors. */
import { digestJson } from "./digest.js";
import { toJsonValue, type JsonObject, type JsonValue } from "../domain/json.js";
import type { SubAgentDefinition } from "../domain/records.js";

const SELECTION_KEYS = [
  "candidateSetDigest",
  "digest",
  "idempotencyKey",
  "mode",
  "outcome",
  "rationaleDigest",
  "schema",
  "selectionBasisDigest",
  "selectorRevision",
  "selectorRunId",
  "selectorSubAgentId",
  "targetSubAgentId",
  "targetSubAgentRevision",
  "taskId",
] as const;

export interface TaskSelectionResultCore {
  readonly candidateSetDigest: string;
  readonly idempotencyKey: string;
  readonly mode: "coordinator" | "explicit" | "self";
  readonly outcome: "assignment" | "no_work";
  readonly rationaleDigest: string | null;
  readonly schema: "task-selection-result-v1";
  readonly selectionBasisDigest: string;
  readonly selectorRevision: number;
  readonly selectorRunId: string;
  readonly selectorSubAgentId: string;
  readonly targetSubAgentId: string | null;
  readonly targetSubAgentRevision: number | null;
  readonly taskId: string | null;
}

export interface TaskSelectionResult extends TaskSelectionResultCore {
  readonly digest: string;
}

export function finalizeTaskSelectionResult(core: TaskSelectionResultCore): TaskSelectionResult {
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

export function parseTaskSelectionResult(value: JsonValue): TaskSelectionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Task selection result must be an object");
  }
  const record = value as JsonObject;
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.join("\0") !== [...SELECTION_KEYS].sort().join("\0")) {
    throw new TypeError("Task selection result has unknown or missing fields");
  }
  if (record.schema !== "task-selection-result-v1") throw new TypeError("Invalid selection schema");
  if (!(["coordinator", "explicit", "self"] as const).includes(record.mode as never)) {
    throw new TypeError("Invalid selection mode");
  }
  if (!(["assignment", "no_work"] as const).includes(record.outcome as never)) {
    throw new TypeError("Invalid selection outcome");
  }
  for (const key of [
    "candidateSetDigest",
    "digest",
    "idempotencyKey",
    "selectionBasisDigest",
    "selectorRunId",
    "selectorSubAgentId",
  ] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new TypeError(`${key} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(record.selectorRevision) || (record.selectorRevision as number) < 1) {
    throw new TypeError("selectorRevision must be a positive integer");
  }
  const assigned = record.outcome === "assignment";
  for (const key of ["targetSubAgentId", "taskId", "rationaleDigest"] as const) {
    if (assigned ? typeof record[key] !== "string" || record[key] === "" : record[key] !== null) {
      throw new TypeError(`${key} does not match the selection outcome`);
    }
  }
  if (
    assigned
      ? !Number.isInteger(record.targetSubAgentRevision) ||
        (record.targetSubAgentRevision as number) < 1
      : record.targetSubAgentRevision !== null
  ) {
    throw new TypeError("targetSubAgentRevision does not match the selection outcome");
  }
  const result = record as unknown as TaskSelectionResult;
  const { digest: _digest, ...core } = result;
  if (finalizeTaskSelectionResult(core).digest !== result.digest) {
    throw new TypeError("Task selection result digest does not match its content");
  }
  if (result.mode === "self" && result.outcome === "assignment" && result.targetSubAgentId !== result.selectorSubAgentId) {
    throw new TypeError("Self-selection must target the selecting definition");
  }
  return structuredClone(result);
}

export function assertSelectionAuthority(
  result: TaskSelectionResult,
  selector: SubAgentDefinition,
  target: SubAgentDefinition | null,
): void {
  if (result.selectorSubAgentId !== selector.id || result.selectorRevision !== selector.revision) {
    throw new Error("Selection result does not match the selector definition revision");
  }
  if (result.mode !== selector.selection.mode) {
    throw new Error("Selection result mode does not match the selector definition");
  }
  if (result.mode === "coordinator" && !selector.capabilities.includes("dispatch.coordinate")) {
    throw new Error("Selector is not authorized to coordinate assignments");
  }
  if (result.outcome === "no_work") return;
  if (target === null || result.targetSubAgentId !== target.id || result.targetSubAgentRevision !== target.revision) {
    throw new Error("Selection result does not match the target definition revision");
  }
  if (!target.selection.acceptsAssignmentsFrom.includes(result.mode)) {
    throw new Error(`Target does not accept ${result.mode} assignments`);
  }
}
