/** Provider-neutral immutable, digest-bound context, runtime receipts, and agent results contract. */
import { digestJson, isSha256Digest } from "../core/digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type { CapabilityGrant } from "../core/capability-compiler.js";
import type { ResourceRecord, TaskSnapshot } from "../domain/records.js";
import { validateJsonSchemaValue } from "../core/json-schema.js";

/** Durable receipt returned by runtime capability. */
export interface RuntimeCapabilityReceipt {
  /** Indicates whether control plane separated. */
  readonly controlPlaneSeparated: true;
  /** Credential exposed to tools dependency consumed by runtime capability receipt. */
  readonly credentialExposedToTools: false;
  /** SHA-256 digest of canonical executable. */
  readonly executableDigest: string;
  /** Opaque version token for executable. */
  readonly executableVersion: string;
  /** SHA-256 digest of canonical filesystem policy. */
  readonly filesystemPolicyDigest: string;
  /** Stable identifier for isolation adapter id. */
  readonly isolationAdapterId: string;
  /** Model dependency consumed by runtime capability receipt. */
  readonly model: string;
  /** SHA-256 digest of canonical model transport. */
  readonly modelTransportDigest: string;
  /** Stable identifier for model transport adapter id. */
  readonly modelTransportAdapterId: string;
  /** SHA-256 digest of canonical network policy. */
  readonly networkPolicyDigest: string;
  /** Reasoning dependency consumed by runtime capability receipt. */
  readonly reasoning: string;
  /** Stable identifier for run id. */
  readonly runId: string;
  /** Runner profile dependency consumed by runtime capability receipt. */
  readonly runnerProfile: string;
  /** Stable identifier for runner adapter id. */
  readonly runnerAdapterId: string;
  /** Version tag for the runtime capability receipt representation. */
  readonly schema: "runtime-capability-receipt-v1";
  /** SHA-256 digest of canonical tool environment. */
  readonly toolEnvironmentDigest: string;
  /** SHA-256 digest of canonical tool policy. */
  readonly toolPolicyDigest: string;
  /** Indicates whether tool process tree enforced. */
  readonly toolProcessTreeEnforced: true;
  /** SHA-256 digest of canonical runtime environment. */
  readonly runtimeEnvironmentDigest: string;
}

/** Provider-neutral run context core contract. */
export interface RunContextCore {
  /** SHA-256 digest of canonical activation. */
  readonly activationDigest: string;
  /** Capability grant dependency consumed by run context core. */
  readonly capabilityGrant: CapabilityGrant;
  /** SHA-256 digest of canonical definition. */
  readonly definitionDigest: string;
  /** Input dependency consumed by run context core. */
  readonly input: JsonObject;
  /** Resource pins dependency consumed by run context core. */
  readonly resourcePins: readonly {
    /** SHA-256 digest binding the canonical content. */
    readonly digest: string;
    /** Ordered key accepted by run context core. */
    readonly key: string;
    /** Ordered version used by compatibility checks. */
    readonly version: string;
  }[];
  /** Resources table data-source identifier. */
  readonly resources: readonly {
    /** Canonical body content. */
    readonly body: string;
    /** Ordered key accepted by run context core. */
    readonly key: string;
    /** Discriminates the kind variant. */
    readonly kind: string;
  }[];
  /** Stable identifier for run id. */
  readonly runId: string;
  /** Runtime receipt dependency consumed by run context core. */
  readonly runtimeReceipt: RuntimeCapabilityReceipt;
  /** Version tag for the run context core representation. */
  readonly schema: "run-context-v1";
  /** Task dependency consumed by run context core. */
  readonly task: TaskSnapshot;
}

/** Provider-neutral run context contract. */
export interface RunContext extends RunContextCore {
  /** SHA-256 digest binding the canonical content. */
  readonly digest: string;
}

/** Provider-neutral agent result core contract. */
export interface AgentResultCore {
  /** SHA-256 digest of canonical context. */
  readonly contextDigest: string;
  /** SHA-256 digest of canonical definition. */
  readonly definitionDigest: string;
  /** Observed task outcome. */
  readonly outcome: string;
  /** Validated effect payload. */
  readonly payload: JsonObject;
  /** Ordered proposed intents accepted by agent result core. */
  readonly proposedIntents: readonly {
    /** Discriminates the kind variant. */
    readonly kind: string;
    /** Ordered payload accepted by agent result core. */
    readonly payload: JsonObject;
  }[];
  /** Stable identifier for run id. */
  readonly runId: string;
  /** Version tag for the agent result core representation. */
  readonly schema: "agent-result-v1";
}

/** Outcome returned by agent. */
export interface AgentResult extends AgentResultCore {
  /** SHA-256 digest binding the canonical content. */
  readonly digest: string;
}

/** Immutable context identity required to validate an Agent result. */
export interface AgentResultContextBinding {
  /** SHA-256 digest of the immutable context supplied to the Agent. */
  readonly digest: string;
  /** SHA-256 digest of the resolved Agent definition and Resource graph. */
  readonly definitionDigest: string;
  /** Stable run identity copied into the Agent result. */
  readonly runId: string;
}

/** Finalizes run context with its canonical digest and fields. */
export function finalizeRunContext(core: RunContextCore): RunContext {
  return { ...structuredClone(core), digest: digestJson(toJsonValue(core)) };
}

/** Finalizes agent result with its canonical digest and fields. */
export function finalizeAgentResult(core: AgentResultCore): AgentResult {
  return { ...structuredClone(core), digest: digestJson(toJsonValue(core)) };
}

/** Parses and validates agent result. */
export function parseAgentResult(input: {
  /** Ordered effect kinds authorized by the capability grant. */
  readonly allowedIntents: readonly string[];
  /** Ordered outcomes allowed by the active definition. */
  readonly allowedOutcomes: readonly string[];
  /** Immutable context identity consumed by Agent-result validation. */
  readonly context: AgentResultContextBinding;
  /** Version tag for the parse agent result representation. */
  readonly outputSchema: JsonObject;
  /** Ordered raw accepted by parse agent result. */
  readonly raw: string;
  /** Ordered effect-intent subsequences required for selected outcomes. */
  readonly requiredIntentSequenceByOutcome?: Readonly<
    Record<string, readonly string[]>
  >;
}): AgentResult {
  /** The parsed agent-result object under validation. */
  const value = objectValue(toJsonValue(JSON.parse(input.raw)), "Agent result");
  assertExactKeys(
    value,
    [
      "contextDigest",
      "definitionDigest",
      "digest",
      "outcome",
      "payload",
      "proposedIntents",
      "runId",
      "schema",
    ],
    "Agent result",
  );
  if (value.schema !== "agent-result-v1")
    throw new TypeError("Agent result schema is invalid");
  for (const key of ["contextDigest", "definitionDigest", "digest"] as const)
    requireDigest(value[key], `Agent result ${key}`);
  for (const key of ["outcome", "runId"] as const)
    requireString(value[key], `Agent result ${key}`);
  objectValue(value.payload, "Agent result payload");
  if (!Array.isArray(value.proposedIntents))
    throw new TypeError("Agent result proposedIntents must be an array");
  value.proposedIntents.forEach((intent, index) =>
    assertIntentShape(intent, index),
  );
  /** Parsed snapshot used consistently during the parse agent result operation. */
  const parsed = value as unknown as AgentResult;
  /** Groups the digest and core values used by parse agent result. */
  const { digest: _digest, ...core } = parsed;
  if (digestJson(toJsonValue(core)) !== parsed.digest)
    throw new TypeError("Agent result digest is invalid");
  if (
    parsed.runId !== input.context.runId ||
    parsed.contextDigest !== input.context.digest ||
    parsed.definitionDigest !== input.context.definitionDigest
  ) {
    throw new Error("Agent result does not match its immutable run context");
  }
  /** Collects agent-result schema-validation issues. */
  const issues = validateJsonSchemaValue(input.outputSchema, parsed.payload);
  if (issues.length > 0)
    throw new TypeError(
      `Agent payload is invalid:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`,
    );
  if (!input.allowedOutcomes.includes(parsed.outcome))
    throw new Error(
      `Agent result outcome is not authorized: ${parsed.outcome}`,
    );
  /** Seen allowed values used to reject duplicates. */
  const allowed = new Set(input.allowedIntents);
  for (const [index, intent] of parsed.proposedIntents.entries()) {
    if (!allowed.has(intent.kind))
      throw new Error(`Agent result intent ${index} is not authorized`);
  }
  /** Reads the ordered intent subsequence dependency consumed by the selected outcome. */
  const requiredSequence =
    input.requiredIntentSequenceByOutcome?.[parsed.outcome] ?? [];
  /** Mutable state recording the next required intent kind while scanning proposed intents. */
  let requiredIndex = 0;
  for (const intent of parsed.proposedIntents)
    if (intent.kind === requiredSequence[requiredIndex]) requiredIndex += 1;
  if (requiredIndex !== requiredSequence.length)
    throw new Error(
      `Agent result outcome ${parsed.outcome} is missing its required ordered intent sequence`,
    );
  return structuredClone(parsed);
}

/** Projects a resolved Resource into immutable run-context data. */
export function resourceContext(
  records: readonly ResourceRecord[],
): RunContextCore["resources"] {
  return records
    .map(({ body, key, kind }) => ({ body, key, kind }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** Rejects invalid runtime capability receipt before it crosses the boundary. */
export function validateRuntimeCapabilityReceipt(
  receipt: RuntimeCapabilityReceipt,
): void {
  if (
    receipt.controlPlaneSeparated !== true ||
    receipt.credentialExposedToTools !== false ||
    receipt.toolProcessTreeEnforced !== true
  ) {
    throw new Error(
      "Runtime receipt does not prove control-plane and tool-process isolation",
    );
  }
  for (const [key, value] of Object.entries(receipt)) {
    if (key.endsWith("Digest") && !isSha256Digest(value))
      throw new TypeError(`Runtime receipt ${key} is not a SHA-256 digest`);
  }
  for (const key of [
    "executableVersion",
    "isolationAdapterId",
    "model",
    "modelTransportAdapterId",
    "reasoning",
    "runId",
    "runnerAdapterId",
    "runnerProfile",
  ] as const) {
    if (receipt[key] === "")
      throw new TypeError(`Runtime receipt ${key} is required`);
  }
}

/** Rejects input that does not satisfy the intent shape contract. */
function assertIntentShape(value: JsonValue, index: number): void {
  /** Result of `objectValue`, retained for the assert intent shape operation. */
  const intent = objectValue(value, `Agent result intent ${index}`);
  assertExactKeys(intent, ["kind", "payload"], `Agent result intent ${index}`);
  requireString(intent.kind, `Agent result intent ${index} kind`);
  objectValue(intent.payload, `Agent result intent ${index} payload`);
}

/** Returns string or throws when invalid or absent. */
function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Returns digest or throws when invalid or absent. */
function requireDigest(value: JsonValue | undefined, label: string): string {
  /** Validated result returned by require digest. */
  const result = requireString(value, label);
  if (!isSha256Digest(result))
    throw new TypeError(`${label} must be a SHA-256 digest`);
  return result;
}

/** Returns whether a value is a non-array JSON object. */
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validates and returns a non-array JSON object. */
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

/** Rejects input that does not satisfy the exact keys contract. */
function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    throw new TypeError(`${label} has unexpected or missing fields`);
}
