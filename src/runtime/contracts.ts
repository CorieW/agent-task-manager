// Defines immutable, digest-bound context, runtime receipts, and agent results.
import { digestJson } from "../core/digest.js";
import { toJsonValue, type JsonObject, type JsonValue } from "../domain/json.js";
import type { CapabilityGrant } from "../core/capability-compiler.js";
import type { ResourceRecord, TaskSnapshot } from "../domain/records.js";
import { validateJsonSchemaValue } from "./json-schema.js";

export interface RuntimeCapabilityReceipt {
  readonly controlPlaneSeparated: true;
  readonly credentialExposedToTools: false;
  readonly executableDigest: string;
  readonly executableVersion: string;
  readonly filesystemPolicyDigest: string;
  readonly model: string;
  readonly modelTransportDigest: string;
  readonly networkPolicyDigest: string;
  readonly reasoning: string;
  readonly runnerProfile: string;
  readonly schema: "runtime-capability-receipt-v1";
  readonly toolEnvironmentDigest: string;
  readonly toolProcessTreeEnforced: true;
}

export interface RunContextCore {
  readonly activationDigest: string;
  readonly capabilityGrant: CapabilityGrant;
  readonly definitionDigest: string;
  readonly input: JsonObject;
  readonly resourcePins: readonly { readonly digest: string; readonly key: string; readonly version: string }[];
  readonly resources: readonly { readonly body: string; readonly key: string; readonly kind: string }[];
  readonly runId: string;
  readonly runtimeReceipt: RuntimeCapabilityReceipt;
  readonly schema: "run-context-v1";
  readonly task: TaskSnapshot;
}

export interface RunContext extends RunContextCore { readonly digest: string; }

export interface AgentResultCore {
  readonly contextDigest: string;
  readonly definitionDigest: string;
  readonly outcome: string;
  readonly payload: JsonObject;
  readonly proposedIntents: readonly { readonly kind: string; readonly payload: JsonObject }[];
  readonly runId: string;
  readonly schema: "agent-result-v1";
}
export interface AgentResult extends AgentResultCore { readonly digest: string; }

export function finalizeRunContext(core: RunContextCore): RunContext { return { ...structuredClone(core), digest: digestJson(toJsonValue(core)) }; }
export function finalizeAgentResult(core: AgentResultCore): AgentResult { return { ...structuredClone(core), digest: digestJson(toJsonValue(core)) }; }

export function parseAgentResult(input: {
  readonly allowedIntents: readonly string[];
  readonly context: RunContext;
  readonly outputSchema: JsonObject;
  readonly raw: string;
}): AgentResult {
  const value = objectValue(toJsonValue(JSON.parse(input.raw)), "Agent result");
  assertExactKeys(value, ["contextDigest", "definitionDigest", "digest", "outcome", "payload", "proposedIntents", "runId", "schema"], "Agent result");
  if (value.schema !== "agent-result-v1") throw new TypeError("Agent result schema is invalid");
  const parsed = value as unknown as AgentResult;
  const { digest: _digest, ...core } = parsed;
  if (finalizeAgentResult(core).digest !== parsed.digest) throw new TypeError("Agent result digest is invalid");
  if (parsed.runId !== input.context.runId || parsed.contextDigest !== input.context.digest || parsed.definitionDigest !== input.context.definitionDigest) {
    throw new Error("Agent result does not match its immutable run context");
  }
  const issues = validateJsonSchemaValue(input.outputSchema, parsed.payload);
  if (issues.length > 0) throw new TypeError(`Agent payload is invalid:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`);
  if (!Array.isArray(parsed.proposedIntents)) throw new TypeError("Agent result proposedIntents must be an array");
  const allowed = new Set(input.allowedIntents);
  for (const [index, intent] of parsed.proposedIntents.entries()) {
    if (!isIntent(intent) || !allowed.has(intent.kind)) throw new Error(`Agent result intent ${index} is not authorized`);
  }
  return structuredClone(parsed);
}

export function resourceContext(records: readonly ResourceRecord[]): RunContextCore["resources"] {
  return records.map(({ body, key, kind }) => ({ body, key, kind })).sort((left, right) => left.key.localeCompare(right.key));
}

function isIntent(value: unknown): value is AgentResult["proposedIntents"][number] {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as { kind?: unknown }).kind === "string" && isJsonObject((value as { payload?: JsonValue }).payload);
}
function isJsonObject(value: JsonValue | undefined): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function objectValue(value: JsonValue | undefined, label: string): JsonObject { if (!isJsonObject(value)) throw new TypeError(`${label} must be an object`); return value; }
function assertExactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) throw new TypeError(`${label} has unexpected or missing fields`);
}
