/** Defines immutable, digest-bound context, runtime receipts, and agent results. */
import { digestJson } from "../core/digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type { CapabilityGrant } from "../core/capability-compiler.js";
import type { ResourceRecord, TaskSnapshot } from "../domain/records.js";
import { validateJsonSchemaValue } from "../core/json-schema.js";

/** Defines the data and behavior required by runtime capability receipt. */
export interface RuntimeCapabilityReceipt {
  /** Indicates whether control plane separated. */
  readonly controlPlaneSeparated: true;
  /** Provides credential exposed to tools to runtime capability receipt. */
  readonly credentialExposedToTools: false;
  /** Stores the SHA-256 digest of executable. */
  readonly executableDigest: string;
  /** Records the executable version used for compatibility checks. */
  readonly executableVersion: string;
  /** Stores the SHA-256 digest of filesystem policy. */
  readonly filesystemPolicyDigest: string;
  /** Identifies isolation adapter. */
  readonly isolationAdapterId: string;
  /** Provides model to runtime capability receipt. */
  readonly model: string;
  /** Stores the SHA-256 digest of model transport. */
  readonly modelTransportDigest: string;
  /** Identifies model transport adapter. */
  readonly modelTransportAdapterId: string;
  /** Stores the SHA-256 digest of network policy. */
  readonly networkPolicyDigest: string;
  /** Provides reasoning to runtime capability receipt. */
  readonly reasoning: string;
  /** Identifies run. */
  readonly runId: string;
  /** Provides runner profile to runtime capability receipt. */
  readonly runnerProfile: string;
  /** Identifies runner adapter. */
  readonly runnerAdapterId: string;
  /** Version tag for the runtime capability receipt representation. */
  readonly schema: "runtime-capability-receipt-v1";
  /** Stores the SHA-256 digest of tool environment. */
  readonly toolEnvironmentDigest: string;
  /** Stores the SHA-256 digest of tool policy. */
  readonly toolPolicyDigest: string;
  /** Indicates whether tool process tree enforced. */
  readonly toolProcessTreeEnforced: true;
  /** Stores the SHA-256 digest of runtime environment. */
  readonly runtimeEnvironmentDigest: string;
}

/** Defines the data and behavior required by run context core. */
export interface RunContextCore {
  /** Stores the SHA-256 digest of activation. */
  readonly activationDigest: string;
  /** Provides capability grant to run context core. */
  readonly capabilityGrant: CapabilityGrant;
  /** Stores the SHA-256 digest of definition. */
  readonly definitionDigest: string;
  /** Provides input to run context core. */
  readonly input: JsonObject;
  /** Provides resource pins to run context core. */
  readonly resourcePins: readonly {
    /** Provides digest to run context core. */
    readonly digest: string;
    /** Provides key to run context core. */
    readonly key: string;
    /** Records the version used for compatibility checks. */
    readonly version: string;
  }[];
  /** Provides resources to run context core. */
  readonly resources: readonly {
    /** Provides body to run context core. */
    readonly body: string;
    /** Provides key to run context core. */
    readonly key: string;
    /** Discriminates the kind variant. */
    readonly kind: string;
  }[];
  /** Identifies run. */
  readonly runId: string;
  /** Provides runtime receipt to run context core. */
  readonly runtimeReceipt: RuntimeCapabilityReceipt;
  /** Version tag for the run context core representation. */
  readonly schema: "run-context-v1";
  /** Provides task to run context core. */
  readonly task: TaskSnapshot;
}

/** Defines the data and behavior required by run context. */
export interface RunContext extends RunContextCore {
  /** Provides digest to run context. */
  readonly digest: string;
}

/** Defines the data and behavior required by agent result core. */
export interface AgentResultCore {
  /** Stores the SHA-256 digest of context. */
  readonly contextDigest: string;
  /** Stores the SHA-256 digest of definition. */
  readonly definitionDigest: string;
  /** Records the current outcome for workflow decisions. */
  readonly outcome: string;
  /** Provides payload to agent result core. */
  readonly payload: JsonObject;
  /** Provides proposed intents to agent result core. */
  readonly proposedIntents: readonly {
    /** Discriminates the kind variant. */
    readonly kind: string;
    /** Provides payload to agent result core. */
    readonly payload: JsonObject;
  }[];
  /** Identifies run. */
  readonly runId: string;
  /** Version tag for the agent result core representation. */
  readonly schema: "agent-result-v1";
}
/** Defines the data and behavior required by agent result. */
export interface AgentResult extends AgentResultCore {
  /** Provides digest to agent result. */
  readonly digest: string;
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
  /** Lists effect kinds authorized by the capability grant. */
  readonly allowedIntents: readonly string[];
  /** Lists outcomes allowed by the active definition. */
  readonly allowedOutcomes: readonly string[];
  /** Provides context to parse agent result. */
  readonly context: RunContext;
  /** Version tag for the parse agent result representation. */
  readonly outputSchema: JsonObject;
  /** Provides raw to parse agent result. */
  readonly raw: string;
  /** Ordered effect-intent subsequences required for selected outcomes. */
  readonly requiredIntentSequenceByOutcome?: Readonly<
    Record<string, readonly string[]>
  >;
}): AgentResult {
  /** Contains the parsed agent-result object under validation. */
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
  /** Stores parsed used by parse agent result. */
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
  /** Tracks unique allowed values. */
  const allowed = new Set(input.allowedIntents);
  for (const [index, intent] of parsed.proposedIntents.entries()) {
    if (!allowed.has(intent.kind))
      throw new Error(`Agent result intent ${index} is not authorized`);
  }
  /** Reads the ordered intent subsequence required by the selected outcome. */
  const requiredSequence =
    input.requiredIntentSequenceByOutcome?.[parsed.outcome] ?? [];
  /** Tracks the next required intent kind while scanning proposed intents. */
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
    if (
      key.endsWith("Digest") &&
      (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    )
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
  /** Stores intent used by assert intent shape. */
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
  /** Holds the validated result returned by require digest. */
  const result = requireString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result))
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
