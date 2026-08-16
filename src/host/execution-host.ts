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
} from "../core/selection-coordinator.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type { TaskSnapshot } from "../domain/records.js";
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
} from "../runtime/dispatcher.js";
import type { ResolvedRuntimeEnvironment } from "../runtime/environment.js";
import {
  EXECUTION_OPERATION,
  assertExecutionIntent,
  executionIntentId,
  executionRequestPayload,
  parseExecutionReport,
  readExecutionCheckpoint,
  writeExecutionCheckpoint,
  type AgentExecutionCheckpoint,
  type AgentExecutionReport,
} from "./execution-journal.js";
import { withSingleHostExecutionLock } from "./single-host-execution-lock.js";

export type { AgentExecutionReport } from "./execution-journal.js";

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
  /** Canonical UTC lease expiry; stages that acquire authority require it to remain in the future. */
  readonly expiresAt: string;
  /** Stable key used to resume the same logical run. */
  readonly operationKey: string;
  /** Provider used for every authoritative read and mutation. */
  readonly provider: AgentTaskProvider;
  /** Task explicitly assigned to the Agent. */
  readonly taskId: string;
}

/** Runs one explicit assignment through every trusted manager-owned boundary. */
export async function runExplicitAgentTask(input: {
  /** Environment-specific runtime and effect bindings. */
  readonly bindings: AgentExecutionBindings;
  /** Stable execution request. */
  readonly request: AgentExecutionRequest;
}): Promise<AgentExecutionReport> {
  /** Trusted bindings and immutable caller request retained through cleanup. */
  const { bindings, request } = input;
  /** Primary failure preserved if host cleanup also fails. */
  let primaryError: unknown;
  try {
    validateRequestShape(request);
    /** Same-host lock identity derived without exposing the operation key. */
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
  /** Stable runtime owner derived from the logical operation key. */
  const runId = `run-${sha256(request.operationKey)}`;
  /** Canonical request fields bound to the provider operation intent. */
  const requestPayload = executionRequestPayload(request);
  /** Request fingerprint persisted in every forward checkpoint. */
  const requestDigest = digestJson(requestPayload);
  /** Provider operation address for terminal replay. */
  const intentId = executionIntentId(request);
  /** Existing terminal intent checked before any new-expiry requirement. */
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
  /** Pending or concurrently completed terminal operation for this request. */
  const intent = await request.provider.beginOperationIntent(
    intentId,
    EXECUTION_OPERATION,
    requestPayload,
  );
  if (intent.state === "applied") return parseExecutionReport(intent.result);

  /** Last durable forward phase, when this logical run is resuming. */
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

  /** Exact requested activation set validated against the installed host surface. */
  const activatedDefinitions = await activateDefinitions({
    ...bindings.activationRuntime,
    definitionIds: [request.agentId],
    provider: request.provider,
  });
  /** Requested Agent activation used by every subsequent authority check. */
  const activated = activatedDefinitions[0];
  if (activated === undefined)
    throw new Error(`Agent definition is unavailable: ${request.agentId}`);

  if (checkpoint === null) {
    validateFutureExpiry(request.expiresAt);
    /** Immutable provider selection basis frozen before assignment creation. */
    const selectionContext = await prepareSelection(
      request.provider,
      activated.resolved,
      activatedDefinitions,
    );

    /** Deterministic explicit assignment persisted before lease acquisition. */
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
    /** Provider-backed assignment promotion acquiring run and Task leases. */
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
  /** Durable promotion authorizing dispatch, effects, and outcome routing. */
  const promotion = requiredCheckpointValue(checkpoint.promotion, "promotion");

  if (checkpoint.result === null) {
    /** Exact live Task basis authorized by the promotion. */
    const task = await verifyAndLoadAssignedTask(
      request.provider,
      promotion,
      activated,
      bindings.activationRuntime,
    );

    /** Trusted runtime and additional input prepared for this assignment. */
    const preparedRun = await bindings.prepare({
      activated,
      config: request.config,
      promotion,
      provider: request.provider,
      task,
    });

    /** Validated dispatch result checkpointed before any proposed effect. */
    const dispatchResult = await dispatchActivatedAgent({
      activated,
      activationRuntime: bindings.activationRuntime,
      additionalInput: preparedRun.additionalInput,
      promotion,
      provider: request.provider,
      runtime: preparedRun.runtime,
    });

    checkpoint = { ...checkpoint, result: dispatchResult.result };
    await writeExecutionCheckpoint(request.provider, request, checkpoint);
  }
  /** Immutable validated result reused instead of redispatching on resume. */
  const result = requiredCheckpointValue(checkpoint.result, "Agent result");

  if (checkpoint.effectIds === null) {
    await verifyAndLoadAssignedTask(
      request.provider,
      promotion,
      activated,
      bindings.activationRuntime,
    );

    /** Ordered effect executions returned by the host's durable broker. */
    const effectExecutions = await bindings.executeEffects({
      deadlineAt:
        Date.now() + activated.resolved.definition.deadlineSeconds * 1_000,
      result,
    });

    assertAppliedEffects(result, effectExecutions);
    checkpoint = {
      ...checkpoint,
      effectIds: effectExecutions.map((effect) => effect.request.effectId),
    };

    await writeExecutionCheckpoint(request.provider, request, checkpoint);
  }

  if (checkpoint.transition === null) {
    /** Live assigned Task reloaded after the host-controlled effect boundary. */
    const task = await verifyAndLoadAssignedTask(
      request.provider,
      promotion,
      activated,
      bindings.activationRuntime,
    );

    /** Durable provider transition applied from the checkpointed Agent result. */
    const transition = await applyOutcome({
      activated,
      bindings,
      operationKey: request.operationKey,
      promotion,
      provider: request.provider,
      result,
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
  /** Completed promotion whose leases must be released idempotently. */
  const promotion = requiredCheckpointValue(checkpoint.promotion, "promotion");
  /** Checkpointed Agent result used to assemble the terminal report. */
  const result = requiredCheckpointValue(checkpoint.result, "Agent result");

  await releaseAssignment(request.provider, promotion, request.operationKey);

  /** Applied effect identities retained in original proposal order. */
  const effectIds = requiredCheckpointValue(
    checkpoint.effectIds,
    "effect receipts",
  );
  /** Durable outcome receipt proving routing completed before cleanup. */
  const transition = requiredCheckpointValue(
    checkpoint.transition,
    "outcome transition",
  );

  /** Exact terminal report persisted for read-only replay. */
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

  /** Applied operation intent that owns the canonical replay result. */
  const completedIntent = await request.provider.completeOperationIntent(
    intentId,
    EXECUTION_OPERATION,
    requestPayload,
    toJsonValue(report),
  );
  return parseExecutionReport(completedIntent.result);
}

/** Returns a completed checkpoint field or rejects corrupt phase ordering. */
function requiredCheckpointValue<T>(value: T | null, label: string): T {
  if (value === null)
    throw new Error(`Agent execution checkpoint is missing ${label}`);
  return value;
}

/** Revalidates the full assignment and returns its exact promoted Task basis. */
async function verifyAndLoadAssignedTask(
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

/** Applies the provider-defined result route after every proposed effect is durable. */
async function applyOutcome(input: {
  /** Activated definition whose route and authority govern the result. */
  readonly activated: ActivatedDefinition;
  /** Trusted callbacks used to materialize optional outcome evidence. */
  readonly bindings: AgentExecutionBindings;
  /** Stable operation key used to derive the ordinary transition key. */
  readonly operationKey: string;
  /** Live assignment basis that the outcome must still match. */
  readonly promotion: AssignmentPromotion;
  /** Provider receiving the durable outcome transition. */
  readonly provider: AgentTaskProvider;
  /** Checkpointed Agent result whose outcome is being routed. */
  readonly result: AgentResult;
  /** Task snapshot supplied to host-owned outcome materializers. */
  readonly task: TaskSnapshot;
  /** Explicit Task identity repeated at the broker boundary. */
  readonly taskId: string;
}): Promise<OutcomeTransitionReceipt> {
  /** Activated transition contract for the selected Agent. */
  const definition = input.activated.resolved.definition;
  /** Provider-backed broker enforcing replay and Task preconditions. */
  const broker = new OutcomeTransitionBroker(input.provider);

  if (definition.humanResolutionOutcomes.includes(input.result.outcome)) {
    if (input.bindings.humanResolution === undefined)
      throw new Error(
        "Execution host cannot materialize the required human resolution",
      );
    /** Human-resolution payload derived before assignment revalidation. */
    const resolution = await input.bindings.humanResolution({
      result: input.result,
      task: input.task,
    });

    await verifyAndLoadAssignedTask(
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
      outcome: input.result.outcome,
      resolution,
      taskId: input.taskId,
    });
  }

  /** Optional review or test evidence supplied to the ordinary transition. */
  const remediationCycle =
    (await input.bindings.remediationCycle?.({
      result: input.result,
      task: input.task,
    })) ?? {};

  await verifyAndLoadAssignedTask(
    input.provider,
    input.promotion,
    input.activated,
    input.bindings.activationRuntime,
  );

  return broker.apply({
    definition,
    expectedTaskStatus: input.promotion.taskStatus,
    expectedTaskVersion: input.promotion.taskVersion,
    idempotencyKey: `${input.operationKey}:outcome:${input.result.digest}`,
    kind: "task_transition",
    outcome: input.result.outcome,
    taskId: input.taskId,
    ...remediationCycle,
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
    /** Proposed intent occupying this exact ordered effect position. */
    const intent = result.proposedIntents[index];
    if (intent === undefined)
      throw new Error(`External effect ${index} has no matching intent`);
    /** Canonical request authorized by the immutable Agent result and index. */
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
    /** Current exact-owner lease snapshot, including released leases on replay. */
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

  /** Agent projection reconciled only after both assignment leases are released. */
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
  /** Parsed expiry used only to verify canonical UTC representation. */
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
