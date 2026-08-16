/** Owns the closed wire contract shared by Agent-context producers and consumers. */
import type { JsonObject } from "../domain/json.js";

/** Wire schema for every persisted Agent context. */
export const AGENT_CONTEXT_SCHEMA = "agent-context-v1" as const;

/** Catalog entry supplied to a parent Agent before it proposes a child wave. */
export interface AgentContextCatalogEntry {
  /** Digest of the immutable context body. */
  readonly contextDigest: string;
  /** Provider Resource key containing the context. */
  readonly contextResource: string;
  /** Resource version pinned by the child-wave request. */
  readonly contextVersion: string;
  /** Child Agent definition represented by the context. */
  readonly definitionId: string;
}

/** Canonical body persisted for one child Agent context. */
export interface AgentContextBody {
  /** Child assignment depth derived from the authorized parent run. */
  readonly assignmentDepth: number;
  /** Parent Agent activation authorizing delegation. */
  readonly parentActivationDigest: string;
  /** Digest of the resolved parent definition and its Resource graph. */
  readonly parentDefinitionDigest: string;
  /** Parent Agent definition that owns the delegation. */
  readonly parentDefinitionId: string;
  /** Live parent run identity that owns this context. */
  readonly parentRunId: string;
  /** Wire schema for this context. */
  readonly schema: typeof AGENT_CONTEXT_SCHEMA;
  /** Immutable Task snapshot delegated to the child. */
  readonly task: JsonObject;
  /** Task identity repeated for closed authority checks. */
  readonly taskId: string;
  /** Task version frozen by the parent assignment. */
  readonly taskVersion: string;
  /** Child activation selected for this context. */
  readonly targetActivationDigest: string;
  /** Child definition digest selected for this context. */
  readonly targetDefinitionDigest: string;
  /** Child definition authorized to consume this exact context. */
  readonly targetDefinitionId: string;
  /** Exact child Resource pins validated during activation. */
  readonly targetResourcePins: readonly JsonObject[];
}

/** Parses the closed, run-bound child-context body before driver exposure. */
export function parseAgentContextBody(value: unknown): AgentContextBody {
  /** Closed top-level record validated before any nested authority data. */
  const record = objectValue(value, "Agent context");
  exactKeys(record, [
    "assignmentDepth",
    "parentActivationDigest",
    "parentDefinitionDigest",
    "parentDefinitionId",
    "parentRunId",
    "schema",
    "targetActivationDigest",
    "targetDefinitionDigest",
    "targetDefinitionId",
    "targetResourcePins",
    "task",
    "taskId",
    "taskVersion",
  ]);
  if (
    record.schema !== AGENT_CONTEXT_SCHEMA ||
    !Number.isSafeInteger(record.assignmentDepth) ||
    Number(record.assignmentDepth) < 1 ||
    !Array.isArray(record.targetResourcePins)
  )
    throw new TypeError("Agent context schema or assignment depth is invalid");

  /** Immutable Task snapshot delegated by the parent assignment. */
  const task = objectValue(record.task, "Agent context Task");
  /** Exact Resource revisions selected for the target Agent. */
  const pins = record.targetResourcePins.map((value, index) => {
    /** One closed Resource reference before field-level validation. */
    const pin = objectValue(value, `Agent context Resource pin ${index}`);
    exactKeys(pin, ["digest", "key", "version"]);
    return {
      digest: digestValue(pin.digest, `Agent context pin ${index} digest`),
      key: stringValue(pin.key, `Agent context pin ${index} key`),
      version: stringValue(pin.version, `Agent context pin ${index} version`),
    };
  });
  return {
    assignmentDepth: Number(record.assignmentDepth),
    parentActivationDigest: digestValue(
      record.parentActivationDigest,
      "Agent context parentActivationDigest",
    ),
    parentDefinitionDigest: digestValue(
      record.parentDefinitionDigest,
      "Agent context parentDefinitionDigest",
    ),
    parentDefinitionId: stringValue(
      record.parentDefinitionId,
      "Agent context parentDefinitionId",
    ),
    parentRunId: stringValue(record.parentRunId, "Agent context parentRunId"),
    schema: AGENT_CONTEXT_SCHEMA,
    targetActivationDigest: digestValue(
      record.targetActivationDigest,
      "Agent context targetActivationDigest",
    ),
    targetDefinitionDigest: digestValue(
      record.targetDefinitionDigest,
      "Agent context targetDefinitionDigest",
    ),
    targetDefinitionId: stringValue(
      record.targetDefinitionId,
      "Agent context targetDefinitionId",
    ),
    targetResourcePins: pins,
    task,
    taskId: stringValue(record.taskId, "Agent context taskId"),
    taskVersion: stringValue(record.taskVersion, "Agent context taskVersion"),
  };
}

/** Requires a non-array object at the Agent-context boundary. */
function objectValue(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as JsonObject;
}

/** Requires the exact keys of a closed Agent-context object. */
function exactKeys(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new TypeError("Child-agent record has unexpected or missing fields");
}

/** Requires a non-empty string. */
function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Requires a lowercase SHA-256 digest. */
function digestValue(value: unknown, label: string): string {
  /** Non-empty candidate narrowed before digest-format validation. */
  const result = stringValue(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result))
    throw new TypeError(`${label} must be a digest`);
  return result;
}
