/** Owns the durable request, checkpoint, and terminal-report boundary for managed execution. */
import type { EnvironmentConfig } from "../config/environment.js";
import { canonicalize } from "../core/canonical-json.js";
import { digestJson, sha256 } from "../core/digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type { ResourceMutation } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type {
  AssignmentPromotion,
  ExplicitAssignment,
  SelectionContext,
} from "../core/selection-coordinator.js";
import type { OutcomeTransitionReceipt } from "../human/outcome-transition-broker.js";
import type { AgentResult } from "../runtime/contracts.js";

/** Request fields required to address and bind one execution journal. */
export interface ExecutionJournalRequest {
  /** Agent definition selected for the run. */
  readonly agentId: string;
  /** Assignment depth bound into the operation payload. */
  readonly assignmentDepth: number;
  /** Environment definition bound by digest and identity. */
  readonly config: EnvironmentConfig;
  /** Lease expiry bound into the exact request. */
  readonly expiresAt: string;
  /** Stable caller key addressing the logical execution. */
  readonly operationKey: string;
  /** Provider storing the journal records. */
  readonly provider: AgentTaskProvider;
  /** Task explicitly assigned to the Agent. */
  readonly taskId: string;
}

/** Terminal report for a successfully routed Agent run. */
export interface AgentExecutionReport {
  /** Agent definition that ran. */
  readonly agentId: string;
  /** Digest of the immutable compiled run context. */
  readonly contextDigest: string;
  /** Applied effect identities in proposal order. */
  readonly effectIds: readonly string[];
  /** Stable operation key supplied by the caller. */
  readonly operationKey: string;
  /** Validated Agent outcome. */
  readonly outcome: string;
  /** Digest of the validated Agent result. */
  readonly resultDigest: string;
  /** Stable run owner derived from the operation key. */
  readonly runId: string;
  /** Wire schema for the report. */
  readonly schema: "agent-execution-report-v1";
  /** Task processed by the run. */
  readonly taskId: string;
  /** Durable outcome-transition receipt. */
  readonly transition: OutcomeTransitionReceipt;
}

/** Durable checkpoints spanning preparation through terminal outcome routing. */
export interface AgentExecutionCheckpoint {
  /** Frozen explicit assignment prepared before any lease acquisition. */
  readonly assignment: ExplicitAssignment;
  /** Applied effect identities, or null before the effect sequence is durable. */
  readonly effectIds: readonly string[] | null;
  /** Completed assignment authorizing this execution, or null before promotion. */
  readonly promotion: AssignmentPromotion | null;
  /** Immutable validated Agent result, or null before dispatch completes. */
  readonly result: AgentResult | null;
  /** Digest of the immutable caller request bound to the operation key. */
  readonly requestDigest: string;
  /** Wire schema for execution checkpoints. */
  readonly schema: "agent-execution-checkpoint-v1";
  /** Immutable selection basis used to replay promotion after interruption. */
  readonly selectionContext: SelectionContext;
  /** Durable outcome receipt, or null before routing completes. */
  readonly transition: OutcomeTransitionReceipt | null;
}

/** Stable operation name used by the provider's terminal execution journal. */
export const EXECUTION_OPERATION = "agent_execution";

/** Builds the immutable provider payload bound to an execution operation key. */
export function executionRequestPayload(
  request: ExecutionJournalRequest,
): JsonValue {
  return toJsonValue({
    agentId: request.agentId,
    assignmentDepth: request.assignmentDepth,
    configDigest: digestJson(toJsonValue(request.config)),
    environmentId: request.config.environmentId,
    expiresAt: request.expiresAt,
    operationKey: request.operationKey,
    taskId: request.taskId,
  });
}

/** Addresses the provider operation that owns terminal execution replay. */
export function executionIntentId(request: ExecutionJournalRequest): string {
  return `agent-execution:${digestJson(
    toJsonValue({
      environmentId: request.config.environmentId,
      operationKey: request.operationKey,
    }),
  )}`;
}

/** Confirms an existing terminal operation belongs to the caller's exact request. */
export function assertExecutionIntent(
  operation: string,
  actualPayload: JsonValue,
  expectedPayload: JsonValue,
): void {
  if (
    operation !== EXECUTION_OPERATION ||
    digestJson(actualPayload) !== digestJson(expectedPayload)
  )
    throw new Error(
      "Execution operation key was reused with a different request",
    );
}

/** Loads and validates the last durable execution phase, if one exists. */
export async function readExecutionCheckpoint(
  provider: AgentTaskProvider,
  request: ExecutionJournalRequest,
  requestDigest: string,
): Promise<AgentExecutionCheckpoint | null> {
  const key = executionCheckpointKey(request);
  const resource = await provider.getOptionalResource(key);
  if (resource === null) return null;
  if (
    resource.key !== key ||
    resource.kind !== "system/intent" ||
    resource.state !== "active" ||
    resource.version !== "v1" ||
    resource.dependencies.length !== 0 ||
    resource.digest !== sha256(resource.body)
  )
    throw new Error("Agent execution checkpoint Resource is invalid");
  const checkpoint = parseExecutionCheckpoint(JSON.parse(resource.body));
  if (checkpoint.requestDigest !== requestDigest)
    throw new Error(
      "Execution operation key was reused with a different request",
    );
  return checkpoint;
}

/** Persists and read-after-write verifies one forward execution checkpoint. */
export async function writeExecutionCheckpoint(
  provider: AgentTaskProvider,
  request: ExecutionJournalRequest,
  checkpoint: AgentExecutionCheckpoint,
): Promise<void> {
  const body = canonicalize(toJsonValue(checkpoint));
  const digest = sha256(body);
  const key = executionCheckpointKey(request);
  const mutation: ResourceMutation = {
    body,
    dependencies: [],
    digest,
    idempotencyKey: `agent-execution-checkpoint:${key}:${digest}`,
    key,
    kind: "system/intent",
    state: "active",
    version: "v1",
  };
  await provider.putResource(mutation);
  const verified = await provider.getOptionalResource(key);
  if (
    verified === null ||
    verified.body !== body ||
    verified.digest !== digest ||
    verified.kind !== mutation.kind ||
    verified.version !== mutation.version
  )
    throw new Error("Agent execution checkpoint did not verify");
}

/** Parses a terminal report returned by the provider operation journal. */
export function parseExecutionReport(value: JsonValue): AgentExecutionReport {
  const report = objectValue(value, "Agent execution report");
  exactKeys(report, [
    "agentId",
    "contextDigest",
    "effectIds",
    "operationKey",
    "outcome",
    "resultDigest",
    "runId",
    "schema",
    "taskId",
    "transition",
  ]);
  if (report.schema !== "agent-execution-report-v1")
    throw new TypeError("Agent execution report schema is invalid");
  for (const key of [
    "agentId",
    "operationKey",
    "outcome",
    "runId",
    "taskId",
  ] as const)
    stringValue(report[key], `Agent execution report ${key}`);
  for (const key of ["contextDigest", "resultDigest"] as const)
    digestValue(report[key], `Agent execution report ${key}`);
  if (
    !Array.isArray(report.effectIds) ||
    report.effectIds.some(
      (effectId) =>
        typeof effectId !== "string" || !/^[a-f0-9]{64}$/u.test(effectId),
    )
  )
    throw new TypeError("Agent execution report effectIds are invalid");
  objectValue(report.transition, "Agent execution report transition");
  return structuredClone(report) as unknown as AgentExecutionReport;
}

/** Addresses the mutable, forward-only execution checkpoint Resource. */
function executionCheckpointKey(request: ExecutionJournalRequest): string {
  return `agent-execution/${sha256(executionIntentId(request))}`;
}

/** Parses the manager-owned execution checkpoint closed representation. */
function parseExecutionCheckpoint(value: unknown): AgentExecutionCheckpoint {
  const record = objectValue(value, "Agent execution checkpoint");
  exactKeys(record, [
    "assignment",
    "effectIds",
    "promotion",
    "requestDigest",
    "result",
    "schema",
    "selectionContext",
    "transition",
  ]);
  if (record.schema !== "agent-execution-checkpoint-v1")
    throw new TypeError("Agent execution checkpoint schema is invalid");
  digestValue(record.requestDigest, "Execution checkpoint requestDigest");
  objectValue(record.assignment, "Execution checkpoint assignment");
  objectValue(record.selectionContext, "Execution checkpoint selectionContext");
  if (record.promotion !== null)
    objectValue(record.promotion, "Execution checkpoint promotion");
  if (record.result !== null) {
    const result = objectValue(record.result, "Execution checkpoint result");
    digestValue(result.digest, "Execution checkpoint result digest");
    const { digest: _digest, ...core } = result;
    if (digestJson(toJsonValue(core)) !== result.digest)
      throw new TypeError("Execution checkpoint result digest is invalid");
  }
  if (
    record.effectIds !== null &&
    (!Array.isArray(record.effectIds) ||
      record.effectIds.some(
        (effectId) =>
          typeof effectId !== "string" || !/^[a-f0-9]{64}$/u.test(effectId),
      ))
  )
    throw new TypeError("Execution checkpoint effectIds are invalid");
  if (record.transition !== null)
    objectValue(record.transition, "Execution checkpoint transition");
  return structuredClone(record) as unknown as AgentExecutionCheckpoint;
}

/** Requires a non-array object at a persisted JSON boundary. */
function objectValue(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as JsonObject;
}

/** Requires the exact keys of a manager-owned closed object. */
function exactKeys(value: JsonObject, expected: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    throw new TypeError("Agent execution record has unexpected fields");
}

/** Requires a non-empty string. */
function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Requires a lowercase SHA-256 digest. */
function digestValue(value: unknown, label: string): string {
  const digest = stringValue(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest))
    throw new TypeError(`${label} must be a digest`);
  return digest;
}
