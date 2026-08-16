/** Composes one explicit Agent assignment through dispatch, effects, outcome routing, and cleanup. */
import type { EnvironmentConfig } from "../config/environment.js";
import { canonicalize } from "../core/canonical-json.js";
import {
  activateDefinitions,
  type ActivatedDefinition,
} from "../core/definition-activation.js";
import { digestJson, sha256 } from "../core/digest.js";
import {
  finalizeExplicitAssignment,
  prepareSelection,
  promoteExplicitAssignment,
  type ActivationRuntime,
  type AssignmentPromotion,
  type ExplicitAssignment,
  type SelectionContext,
} from "../core/selection-coordinator.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type { ResourceMutation, TaskSnapshot } from "../domain/records.js";
import type { ExternalEffectExecution } from "../effects/contracts.js";
import { finalizeRequest } from "../effects/external-effect-broker.js";
import {
  OutcomeTransitionBroker,
  type BlockedOutcomeResolution,
  type OutcomeTransitionReceipt,
  type OrdinaryTransitionInput,
} from "../human/outcome-transition-broker.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { AgentResult } from "../runtime/contracts.js";
import {
  dispatchActivatedAgent,
  verifyLiveAssignment,
  type DispatchResult,
} from "../runtime/dispatcher.js";
import type { ResolvedRuntimeEnvironment } from "../runtime/environment.js";
import { withSingleHostExecutionLock } from "./single-host-execution-lock.js";

/** Inputs available while a trusted host prepares one assigned Agent run. */
export interface AgentExecutionPreparationInput {
  /** Activated Agent and immutable Resource graph selected for the run. */
  readonly activated: ActivatedDefinition;
  /** Provider environment definition without credential values. */
  readonly config: EnvironmentConfig;
  /** Completed provider-backed assignment used by runtime authorization. */
  readonly promotion: AssignmentPromotion;
  /** Provider boundary used by the trusted host. */
  readonly provider: AgentTaskProvider;
  /** Task snapshot bound into the assignment. */
  readonly task: TaskSnapshot;
}

/** Trusted host bindings that supply environment-specific runtime and effects. */
export interface AgentExecutionBindings {
  /** Capabilities, intents, profiles, and model pairs actually installed by this host. */
  readonly activationRuntime: ActivationRuntime;
  /** Releases host-owned resources after the run attempt. */
  close?(): Promise<void>;
  /** Executes proposed effects through the host's durable effect broker. */
  executeEffects(input: {
    /** Absolute deadline shared by the effect sequence. */
    readonly deadlineAt: number;
    /** Completed Agent result whose proposed intents are executed in order. */
    readonly result: AgentResult;
  }): Promise<readonly ExternalEffectExecution[]>;
  /** Supplies human-recovery content for a declared human-resolution outcome. */
  humanResolution?(input: {
    /** Agent result requesting human resolution. */
    readonly result: AgentResult;
    /** Task being transitioned. */
    readonly task: TaskSnapshot;
  }): Promise<BlockedOutcomeResolution>;
  /** Prepares the exact runtime and trusted additional input for dispatch. */
  prepare(input: AgentExecutionPreparationInput): Promise<{
    /** Trusted host input added to the immutable run context. */
    readonly additionalInput: JsonObject;
    /** Environment-resolved runtime adapters. */
    readonly runtime: ResolvedRuntimeEnvironment;
  }>;
  /** Extracts optional review/test cycle evidence from a validated Agent result. */
  remediationCycle?(input: {
    /** Agent result whose evidence may advance one remediation guard. */
    readonly result: AgentResult;
    /** Task being transitioned. */
    readonly task: TaskSnapshot;
  }): Promise<Pick<OrdinaryTransitionInput, "reviewCycle" | "testCycle">>;
}

/** Factory input exposed to an explicitly selected trusted host module. */
export interface AgentExecutionHostFactoryInput {
  /** Parsed environment definition. */
  readonly config: EnvironmentConfig;
  /** Provider owned by Agent Task Manager. */
  readonly provider: AgentTaskProvider;
}

/** Factory exported by a trusted execution-host module. */
export type AgentExecutionHostFactory = (
  input: AgentExecutionHostFactoryInput,
) => AgentExecutionBindings | Promise<AgentExecutionBindings>;

/** Stable request for one explicit Agent assignment. */
export interface AgentExecutionRequest {
  /** Agent definition selected by the human or an authorized coordinator. */
  readonly agentId: string;
  /** Assignment depth, starting at zero for a human request. */
  readonly assignmentDepth: number;
  /** Parsed provider/runtime environment definition. */
  readonly config: EnvironmentConfig;
  /** Timestamp after which the assignment leases are invalid. */
  readonly expiresAt: string;
  /** Stable key used to resume the same logical run. */
  readonly operationKey: string;
  /** Provider used for every authoritative read and mutation. */
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

/** Durable checkpoints for a resumable execution after assignment promotion. */
interface AgentExecutionCheckpoint {
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
const EXECUTION_OPERATION = "agent_execution";

/** Runs one explicit assignment through every trusted manager-owned boundary. */
export async function runExplicitAgentTask(input: {
  /** Environment-specific runtime and effect bindings. */
  readonly bindings: AgentExecutionBindings;
  /** Stable execution request. */
  readonly request: AgentExecutionRequest;
}): Promise<AgentExecutionReport> {
  const { bindings, request } = input;
  let primaryError: unknown;
  try {
    validateRequestShape(request);
    const lockIdentity = `execution-${sha256(
      `${request.config.environmentId}\0${request.operationKey}`,
    )}`;
    return await withSingleHostExecutionLock(lockIdentity, () =>
      runLocked(bindings, request),
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (bindings.close !== undefined) {
      try {
        await bindings.close();
      } catch (closeError) {
        if (primaryError === undefined) throw closeError;
        throw new AggregateError(
          [primaryError, closeError],
          "Agent execution failed and host cleanup also failed",
          { cause: primaryError },
        );
      }
    }
  }
}

/** Advances or replays one execution while its same-host claim is held. */
async function runLocked(
  bindings: AgentExecutionBindings,
  request: AgentExecutionRequest,
): Promise<AgentExecutionReport> {
  const runId = `run-${sha256(request.operationKey)}`;
  const requestPayload = executionRequestPayload(request);
  const requestDigest = digestJson(requestPayload);
  const intentId = executionIntentId(request);
  const existingIntent = await request.provider.getOperationIntent(intentId);
  if (existingIntent?.state === "applied") {
    assertExecutionIntent(
      existingIntent.operation,
      existingIntent.payload,
      requestPayload,
    );
    return parseExecutionReport(existingIntent.result);
  }
  if (existingIntent === null) validateFutureExpiry(request.expiresAt);
  const intent = await request.provider.beginOperationIntent(
    intentId,
    EXECUTION_OPERATION,
    requestPayload,
  );
  if (intent.state === "applied") return parseExecutionReport(intent.result);

  let checkpoint = await readExecutionCheckpoint(
    request.provider,
    request,
    requestDigest,
  );
  if (checkpoint !== null && checkpoint.transition !== null)
    return completeExecution(
      request,
      runId,
      intentId,
      requestPayload,
      checkpoint,
    );

  const activatedDefinitions = await activateDefinitions({
    ...bindings.activationRuntime,
    definitionIds: [request.agentId],
    provider: request.provider,
  });
  const activated = activatedDefinitions[0];
  if (activated === undefined)
    throw new Error(`Agent definition is unavailable: ${request.agentId}`);

  if (checkpoint === null) {
    validateFutureExpiry(request.expiresAt);
    const selectionContext = await prepareSelection(
      request.provider,
      activated.resolved,
      activatedDefinitions,
    );
    const assignment = finalizeExplicitAssignment({
      authorityId: runId,
      idempotencyKey: `${request.operationKey}:assignment`,
      schema: "explicit-assignment-v1",
      selectionBasisDigest: selectionContext.basisDigest,
      targetAgentId: request.agentId,
      targetAgentRevision: activated.resolved.definition.revision,
      taskId: request.taskId,
    });
    checkpoint = {
      assignment,
      effectIds: null,
      promotion: null,
      requestDigest,
      result: null,
      schema: "agent-execution-checkpoint-v1",
      selectionContext,
      transition: null,
    };
    await writeExecutionCheckpoint(request.provider, request, checkpoint);
  }

  if (
    checkpoint.assignment.targetAgentId !== request.agentId ||
    checkpoint.assignment.taskId !== request.taskId ||
    checkpoint.assignment.authorityId !== runId
  )
    throw new Error(
      "Execution checkpoint assignment conflicts with the request",
    );

  if (checkpoint.promotion === null) {
    validateFutureExpiry(request.expiresAt);
    const promotion = await promoteExplicitAssignment({
      activationRuntime: bindings.activationRuntime,
      assignment: checkpoint.assignment,
      assignmentDepth: request.assignmentDepth,
      expiresAt: request.expiresAt,
      ownerId: runId,
      provider: request.provider,
      resolvedTarget: activated.resolved,
      selectionContext: checkpoint.selectionContext,
    });
    checkpoint = { ...checkpoint, promotion };
    await writeExecutionCheckpoint(request.provider, request, checkpoint);
  }
  const promotion = requiredCheckpointValue(checkpoint.promotion, "promotion");

  if (checkpoint.result === null) {
    const task = await exactPromotedTask(
      request.provider,
      promotion,
      activated,
      bindings.activationRuntime,
    );
    const prepared = await bindings.prepare({
      activated,
      config: request.config,
      promotion,
      provider: request.provider,
      task,
    });
    const dispatched = await dispatchActivatedAgent({
      activated,
      activationRuntime: bindings.activationRuntime,
      additionalInput: prepared.additionalInput,
      promotion,
      provider: request.provider,
      runtime: prepared.runtime,
    });
    checkpoint = { ...checkpoint, result: dispatched.result };
    await writeExecutionCheckpoint(request.provider, request, checkpoint);
  }
  const result = requiredCheckpointValue(checkpoint.result, "Agent result");

  if (checkpoint.effectIds === null) {
    await exactPromotedTask(
      request.provider,
      promotion,
      activated,
      bindings.activationRuntime,
    );
    const effects = await bindings.executeEffects({
      deadlineAt:
        Date.now() + activated.resolved.definition.deadlineSeconds * 1_000,
      result,
    });
    assertAppliedEffects(result, effects);
    checkpoint = {
      ...checkpoint,
      effectIds: effects.map((effect) => effect.request.effectId),
    };
    await writeExecutionCheckpoint(request.provider, request, checkpoint);
  }

  if (checkpoint.transition === null) {
    const task = await exactPromotedTask(
      request.provider,
      promotion,
      activated,
      bindings.activationRuntime,
    );
    const dispatched = {
      contextDigest: result.contextDigest,
      result,
    };
    const transition = await applyOutcome({
      activated,
      bindings,
      dispatched,
      operationKey: request.operationKey,
      promotion,
      provider: request.provider,
      task,
      taskId: request.taskId,
    });
    checkpoint = { ...checkpoint, transition };
    await writeExecutionCheckpoint(request.provider, request, checkpoint);
  }

  return completeExecution(
    request,
    runId,
    intentId,
    requestPayload,
    checkpoint,
  );
}

/** Completes idempotent lease cleanup and persists the terminal report. */
async function completeExecution(
  request: AgentExecutionRequest,
  runId: string,
  intentId: string,
  requestPayload: JsonValue,
  checkpoint: AgentExecutionCheckpoint,
): Promise<AgentExecutionReport> {
  const promotion = requiredCheckpointValue(checkpoint.promotion, "promotion");
  const result = requiredCheckpointValue(checkpoint.result, "Agent result");
  await releaseAssignment(request.provider, promotion, request.operationKey);
  const effectIds = requiredCheckpointValue(
    checkpoint.effectIds,
    "effect receipts",
  );
  const transition = requiredCheckpointValue(
    checkpoint.transition,
    "outcome transition",
  );
  const report: AgentExecutionReport = {
    agentId: request.agentId,
    contextDigest: result.contextDigest,
    effectIds,
    operationKey: request.operationKey,
    outcome: result.outcome,
    resultDigest: result.digest,
    runId,
    schema: "agent-execution-report-v1",
    taskId: request.taskId,
    transition,
  };
  const completed = await request.provider.completeOperationIntent(
    intentId,
    EXECUTION_OPERATION,
    requestPayload,
    toJsonValue(report),
  );
  return parseExecutionReport(completed.result);
}

/** Returns a completed checkpoint field or rejects corrupt phase ordering. */
function requiredCheckpointValue<T>(value: T | null, label: string): T {
  if (value === null)
    throw new Error(`Agent execution checkpoint is missing ${label}`);
  return value;
}

/** Builds the immutable provider payload bound to an execution operation key. */
function executionRequestPayload(request: AgentExecutionRequest): JsonValue {
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
function executionIntentId(request: AgentExecutionRequest): string {
  return `agent-execution:${digestJson(
    toJsonValue({
      environmentId: request.config.environmentId,
      operationKey: request.operationKey,
    }),
  )}`;
}

/** Addresses the mutable, forward-only execution checkpoint Resource. */
function executionCheckpointKey(request: AgentExecutionRequest): string {
  return `agent-execution/${sha256(executionIntentId(request))}`;
}

/** Confirms an existing terminal operation belongs to the caller's exact request. */
function assertExecutionIntent(
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
async function readExecutionCheckpoint(
  provider: AgentTaskProvider,
  request: AgentExecutionRequest,
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
async function writeExecutionCheckpoint(
  provider: AgentTaskProvider,
  request: AgentExecutionRequest,
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

/** Parses a terminal report returned by the provider operation journal. */
function parseExecutionReport(value: JsonValue): AgentExecutionReport {
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

/** Revalidates the full assignment and returns its exact promoted Task basis. */
async function exactPromotedTask(
  provider: AgentTaskProvider,
  promotion: AssignmentPromotion,
  activated: ActivatedDefinition,
  activationRuntime: ActivationRuntime,
): Promise<TaskSnapshot> {
  await verifyLiveAssignment({
    activated,
    activationRuntime,
    promotion,
    provider,
  });
  return provider.getTaskSnapshot(promotion.taskId);
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

/** Applies the provider-defined result route after every proposed effect is durable. */
async function applyOutcome(input: {
  readonly activated: ActivatedDefinition;
  readonly bindings: AgentExecutionBindings;
  readonly dispatched: Pick<DispatchResult, "contextDigest" | "result">;
  readonly operationKey: string;
  readonly promotion: AssignmentPromotion;
  readonly provider: AgentTaskProvider;
  readonly task: TaskSnapshot;
  readonly taskId: string;
}): Promise<OutcomeTransitionReceipt> {
  const definition = input.activated.resolved.definition;
  const broker = new OutcomeTransitionBroker(input.provider);
  if (
    definition.humanResolutionOutcomes.includes(input.dispatched.result.outcome)
  ) {
    if (input.bindings.humanResolution === undefined)
      throw new Error(
        "Execution host cannot materialize the required human resolution",
      );
    const resolution = await input.bindings.humanResolution({
      result: input.dispatched.result,
      task: input.task,
    });
    await exactPromotedTask(
      input.provider,
      input.promotion,
      input.activated,
      input.bindings.activationRuntime,
    );
    return broker.apply({
      definition,
      expectedTaskStatus: input.promotion.taskStatus,
      expectedTaskVersion: input.promotion.taskVersion,
      kind: "human_resolution",
      outcome: input.dispatched.result.outcome,
      resolution,
      taskId: input.taskId,
    });
  }
  const cycle =
    (await input.bindings.remediationCycle?.({
      result: input.dispatched.result,
      task: input.task,
    })) ?? {};
  await exactPromotedTask(
    input.provider,
    input.promotion,
    input.activated,
    input.bindings.activationRuntime,
  );
  return broker.apply({
    definition,
    expectedTaskStatus: input.promotion.taskStatus,
    expectedTaskVersion: input.promotion.taskVersion,
    idempotencyKey: `${input.operationKey}:outcome:${input.dispatched.result.digest}`,
    kind: "task_transition",
    outcome: input.dispatched.result.outcome,
    taskId: input.taskId,
    ...cycle,
  });
}

/** Requires one durable applied execution for every proposed intent. */
function assertAppliedEffects(
  result: AgentResult,
  effects: readonly ExternalEffectExecution[],
): void {
  if (effects.length !== result.proposedIntents.length)
    throw new Error(
      "Execution host did not return one effect execution per proposed intent",
    );
  for (const [index, effect] of effects.entries()) {
    const intent = result.proposedIntents[index];
    if (intent === undefined)
      throw new Error(`External effect ${index} has no matching intent`);
    const expectedRequest = finalizeRequest({
      kind: intent.kind,
      payload: intent.payload,
      source: {
        contextDigest: result.contextDigest,
        definitionDigest: result.definitionDigest,
        intentIndex: index,
        resultDigest: result.digest,
        runId: result.runId,
      },
    });
    if (effect.state !== "applied" || effect.receipt === null)
      throw new Error(`External effect ${index} did not reach applied state`);
    if (
      canonicalize(toJsonValue(effect.request)) !==
      canonicalize(toJsonValue(expectedRequest))
    )
      throw new Error(
        `External effect ${index} does not match the Agent result`,
      );
    if (
      effect.receipt.schema !== "external-effect-receipt-v1" ||
      effect.receipt.effectId !== expectedRequest.effectId ||
      effect.receipt.state !== "applied" ||
      effect.receipt.handlerId === "" ||
      effect.receipt.handlerVersion === ""
    )
      throw new Error(`External effect ${index} receipt is invalid`);
  }
}

/** Releases both exact assignment leases and reconciles the Agent projection. */
async function releaseAssignment(
  provider: AgentTaskProvider,
  promotion: AssignmentPromotion,
  operationKey: string,
): Promise<void> {
  for (const leaseId of [promotion.taskLeaseId, promotion.runLeaseId]) {
    const lease = await provider.getLeaseSnapshot(leaseId);
    if (lease === null || lease.ownerId !== promotion.ownerId)
      throw new Error(
        `Assignment lease is unavailable for release: ${leaseId}`,
      );
    if (!lease.released)
      await provider.releaseLease({
        expectedVersion: lease.version,
        leaseId,
        ownerId: promotion.ownerId,
      });
  }
  const reconciled = await provider.reconcileAgentActivity(
    promotion.targetAgentId,
    `${operationKey}:activity`,
  );
  if (reconciled.state !== "applied")
    throw new Error("Agent activity did not reconcile after lease release");
}

/** Rejects malformed execution requests before the first provider access. */
function validateRequestShape(request: AgentExecutionRequest): void {
  for (const [label, value] of [
    ["Agent ID", request.agentId],
    ["Operation key", request.operationKey],
    ["Task ID", request.taskId],
  ] as const)
    if (value === "") throw new TypeError(`${label} is required`);
  if (
    !Number.isSafeInteger(request.assignmentDepth) ||
    request.assignmentDepth < 0
  )
    throw new TypeError("Assignment depth must be a non-negative integer");
  const milliseconds = Date.parse(request.expiresAt);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== request.expiresAt
  )
    throw new TypeError(
      "Assignment expiry must be a canonical UTC ISO timestamp",
    );
}

/** Rejects a canonical expiry that cannot authorize a new execution stage. */
function validateFutureExpiry(expiresAt: string): void {
  if (Date.parse(expiresAt) <= Date.now())
    throw new TypeError("Assignment expiry must be in the future");
}
