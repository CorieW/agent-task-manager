/** Validates the closed task-selection result exchanged with provider-defined selectors. */
import { digestJson } from "./digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type { SubAgentDefinition } from "../domain/records.js";

/** Exact fields allowed in a Task selection result. */
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

/** Canonical fields for task selection result core. */
export interface TaskSelectionResultCore {
  /** SHA-256 digest of canonical candidate set content. */
  readonly candidateSetDigest: string;
  /** Key that identifies retries of the same logical operation. */
  readonly idempotencyKey: string;
  /** Mode for task selection result core. */
  readonly mode: "coordinator" | "explicit" | "self";
  /** Outcome for task selection result core. */
  readonly outcome: "assignment" | "no_work";
  /** SHA-256 digest of canonical rationale content. */
  readonly rationaleDigest: string | null;
  /** Schema discriminator for the serialized representation. */
  readonly schema: "task-selection-result-v1";
  /** SHA-256 digest of canonical selection basis content. */
  readonly selectionBasisDigest: string;
  /** Selector revision for task selection result core. */
  readonly selectorRevision: number;
  /** Stable identifier for selector run. */
  readonly selectorRunId: string;
  /** Stable identifier for selector sub-agent. */
  readonly selectorSubAgentId: string;
  /** Stable identifier for target sub-agent. */
  readonly targetSubAgentId: string | null;
  /** Target sub-agent revision for task selection result core. */
  readonly targetSubAgentRevision: number | null;
  /** Stable identifier for task. */
  readonly taskId: string | null;
}

/** Result of task selection. */
export interface TaskSelectionResult extends TaskSelectionResultCore {
  /** SHA-256 digest of the Task selection result fields. */
  readonly digest: string;
}

/** Attaches a canonical digest to a Task selection result. */
export function finalizeTaskSelectionResult(
  core: TaskSelectionResultCore,
): TaskSelectionResult {
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

/** Parses a Task selection result and verifies its canonical digest. */
export function parseTaskSelectionResult(
  value: JsonValue,
): TaskSelectionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Task selection result must be an object");
  }
  /** Record used during parse task selection result. */
  const record = value as JsonObject;
  /** Actual keys arranged in deterministic order. */
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.join("\0") !== [...SELECTION_KEYS].sort().join("\0")) {
    throw new TypeError("Task selection result has unknown or missing fields");
  }
  if (record.schema !== "task-selection-result-v1")
    throw new TypeError("Invalid selection schema");
  if (
    !(["coordinator", "explicit", "self"] as const).includes(
      record.mode as never,
    )
  ) {
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
  if (
    !Number.isInteger(record.selectorRevision) ||
    (record.selectorRevision as number) < 1
  ) {
    throw new TypeError("selectorRevision must be a positive integer");
  }
  /** Assigned used during parse task selection result. */
  const assigned = record.outcome === "assignment";
  for (const key of [
    "targetSubAgentId",
    "taskId",
    "rationaleDigest",
  ] as const) {
    if (
      assigned
        ? typeof record[key] !== "string" || record[key] === ""
        : record[key] !== null
    ) {
      throw new TypeError(`${key} does not match the selection outcome`);
    }
  }
  if (
    assigned
      ? !Number.isInteger(record.targetSubAgentRevision) ||
        (record.targetSubAgentRevision as number) < 1
      : record.targetSubAgentRevision !== null
  ) {
    throw new TypeError(
      "targetSubAgentRevision does not match the selection outcome",
    );
  }
  /** Result produced by parse task selection result. */
  const result = record as unknown as TaskSelectionResult;
  /** Digest and core used during parse task selection result. */
  const { digest: _digest, ...core } = result;
  if (finalizeTaskSelectionResult(core).digest !== result.digest) {
    throw new TypeError(
      "Task selection result digest does not match its content",
    );
  }
  if (
    result.mode === "self" &&
    result.outcome === "assignment" &&
    result.targetSubAgentId !== result.selectorSubAgentId
  ) {
    throw new TypeError("Self-selection must target the selecting definition");
  }
  return structuredClone(result);
}

/** Rejects selections that exceed the selector or target definition authority. */
export function assertSelectionAuthority(
  result: TaskSelectionResult,
  selector: SubAgentDefinition,
  target: SubAgentDefinition | null,
): void {
  if (
    result.selectorSubAgentId !== selector.id ||
    result.selectorRevision !== selector.revision
  ) {
    throw new Error(
      "Selection result does not match the selector definition revision",
    );
  }
  if (result.mode !== selector.selection.mode) {
    throw new Error(
      "Selection result mode does not match the selector definition",
    );
  }
  if (
    result.mode === "coordinator" &&
    !selector.capabilities.includes("dispatch.coordinate")
  ) {
    throw new Error("Selector is not authorized to coordinate assignments");
  }
  if (result.outcome === "no_work") return;
  if (
    target === null ||
    result.targetSubAgentId !== target.id ||
    result.targetSubAgentRevision !== target.revision
  ) {
    throw new Error(
      "Selection result does not match the target definition revision",
    );
  }
  if (!target.selection.acceptsAssignmentsFrom.includes(result.mode)) {
    throw new Error(`Target does not accept ${result.mode} assignments`);
  }
}
