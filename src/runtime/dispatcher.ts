/** Launches one currently assigned Agent through environment-bound trusted adapters. */
import { digestJson, isSha256Digest } from "../core/digest.js";
import { sameStringSet } from "../core/string-set.js";
import {
  activateDefinitions,
  type ActivatedDefinition,
} from "../core/definition-activation.js";
import {
  verifyAssignmentPromotion,
  type ActivationRuntime,
  type AssignmentPromotion,
} from "../core/selection-coordinator.js";
import { assertSupportedJsonSchema } from "../core/json-schema.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { compileRunContext } from "./context-compiler.js";
import {
  parseAgentResult,
  validateRuntimeCapabilityReceipt,
  type AgentResult,
  type RuntimeCapabilityReceipt,
} from "./contracts.js";
import type {
  ModelTransportSession,
  ToolIsolationSession,
} from "./adapters.js";
import {
  compileToolIsolationPolicy,
  type ResolvedRuntimeEnvironment,
} from "./environment.js";
import {
  superviseProcess,
  type ProcessTelemetry,
} from "./process-supervisor.js";

/** Outcome returned by dispatch. */
export interface DispatchResult {
  /** SHA-256 digest of canonical context. */
  readonly contextDigest: string;
  /** Result dependency consumed by dispatch result. */
  readonly result: AgentResult;
  /** Telemetry dependency consumed by dispatch result. */
  readonly telemetry: ProcessTelemetry;
}

/** Represents a runtime dispatch failure. */
export class RuntimeDispatchError extends Error {
  /** Creates runtime dispatch error with its required collaborators. */
  public constructor(
    /** Code dependency consumed by runtime dispatch error. */ public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Represents a retryable no verdict failure. */
class RetryableNoVerdictError extends RuntimeDispatchError {}

/** Verifies live authority and dispatches one activated assignment. */
export async function dispatchActivatedAgent(input: {
  /** Activated dependency consumed by dispatch activated agent. */
  readonly activated: ActivatedDefinition;
  /** Activation runtime dependency consumed by dispatch activated agent. */
  readonly activationRuntime: ActivationRuntime;
  /** Additional input dependency consumed by dispatch activated agent. */
  readonly additionalInput: JsonObject;
  /** Promotion dependency consumed by dispatch activated agent. */
  readonly promotion: AssignmentPromotion;
  /** Provider boundary used for durable state reads and writes. */
  readonly provider: AgentTaskProvider;
  /** Runtime dependency consumed by dispatch activated agent. */
  readonly runtime: ResolvedRuntimeEnvironment;
}): Promise<DispatchResult> {
  try {
    /** Result of `verifyLiveAssignment`, retained for the dispatch activated agent operation. */
    const activated = await verifyLiveAssignment(input);
    return await dispatchVerified({ ...input, activated });
  } catch (error) {
    try {
      await recordRuntimeError(input, error);
    } catch (recordingError) {
      throw new AggregateError(
        [error, recordingError],
        "Agent runtime failed and Error persistence also failed",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Prepares trusted runtime sessions and supervises one verified agent run. */
async function dispatchVerified(input: {
  /** Activated dependency consumed by dispatch verified. */
  readonly activated: ActivatedDefinition;
  /** Activation runtime dependency consumed by dispatch verified. */
  readonly activationRuntime: ActivationRuntime;
  /** Additional input dependency consumed by dispatch verified. */
  readonly additionalInput: JsonObject;
  /** Promotion dependency consumed by dispatch verified. */
  readonly promotion: AssignmentPromotion;
  /** Provider boundary used for durable state reads and writes. */
  readonly provider: AgentTaskProvider;
  /** Runtime dependency consumed by dispatch verified. */
  readonly runtime: ResolvedRuntimeEnvironment;
}): Promise<DispatchResult> {
  /** Result of `Date.now`, retained for the dispatch verified operation. */
  const definition = input.activated.resolved.definition;
  /** Result of `Date.now`, retained for the dispatch verified operation. */
  const runId = input.promotion.ownerId;
  /** Absolute dispatch deadline verified before each boundary call. */
  const deadlineAt = Date.now() + definition.deadlineSeconds * 1000;
  /** Result of `compileToolIsolationPolicy`, retained for the dispatch verified operation. */
  const policy = compileToolIsolationPolicy({
    grant: input.activated.grant,
    runId,
    runtime: input.runtime,
  });
  /** Binds dispatch verified to canonical policy content. */
  const policyDigest = digestJson(toJsonValue(policy));
  /** Result of `withinDeadline`, retained for the dispatch verified operation. */
  const runnerIdentity = await withinDeadline(
    input.runtime.runner.identity(),
    deadlineAt,
    "runner_identity_timeout",
  );
  validateRunnerIdentity(
    input.runtime,
    definition.runnerProfile,
    runnerIdentity,
  );
  /** Prepared model-transport session for guaranteed cleanup. */
  let controlPlane: ModelTransportSession | null = null;
  /** Prepared tool-isolation session. */
  let isolation: ToolIsolationSession | null = null;
  /** Retains the primary failure so cleanup errors can be combined. */
  let primaryError: unknown;
  try {
    controlPlane = await cancellableWithinDeadline(
      (signal) =>
        input.runtime.modelTransport.prepare({
          model: definition.model,
          reasoning: definition.reasoning,
          runId,
          signal,
        }),
      deadlineAt,
      input.runtime.config.postKillReapMilliseconds,
      "model_prepare_timeout",
      (session) => session.close(),
    );
    validateModelReceipt(
      input.runtime,
      definition.model,
      definition.reasoning,
      runId,
      controlPlane,
    );
    isolation = await cancellableWithinDeadline(
      (signal) => input.runtime.toolIsolation.prepare(policy, signal),
      deadlineAt,
      input.runtime.config.postKillReapMilliseconds,
      "isolation_prepare_timeout",
      (session) => session.close(),
    );
    validateIsolationReceipt(input.runtime, runId, policyDigest, isolation);
    /** Runtime receipt produced by dispatch verified. */
    const runtimeReceipt: RuntimeCapabilityReceipt = {
      controlPlaneSeparated: controlPlane.receipt.separatedFromToolProcesses,
      credentialExposedToTools: controlPlane.receipt.credentialExposedToTools,
      executableDigest: runnerIdentity.executableDigest,
      executableVersion: runnerIdentity.executableVersion,
      filesystemPolicyDigest: isolation.receipt.filesystemPolicyDigest,
      isolationAdapterId: isolation.receipt.adapterId,
      model: controlPlane.receipt.model,
      modelTransportDigest: controlPlane.receipt.digest,
      modelTransportAdapterId: controlPlane.receipt.adapterId,
      networkPolicyDigest: isolation.receipt.networkPolicyDigest,
      reasoning: controlPlane.receipt.reasoning,
      runId,
      runnerProfile: definition.runnerProfile,
      runnerAdapterId: runnerIdentity.id,
      runtimeEnvironmentDigest: input.runtime.digest,
      schema: "runtime-capability-receipt-v1",
      toolEnvironmentDigest: isolation.receipt.environmentDigest,
      toolPolicyDigest: isolation.receipt.policyDigest,
      toolProcessTreeEnforced: isolation.receipt.processTreeEnforced,
    };
    validateRuntimeCapabilityReceipt(runtimeReceipt);
    /** Result of `compileRunContext`, retained for the dispatch verified operation. */
    const context = await compileRunContext({
      activated: input.activated,
      additionalInput: input.additionalInput,
      provider: input.provider,
      runId,
      runtimeReceipt,
      taskId: input.promotion.taskId,
    });
    /** Result of `input.activated.resolved.resources.find`, retained for the dispatch verified operation. */
    const controlPlaneHandle = controlPlane.opaqueHandle;
    /** Result of `input.activated.resolved.resources.find`, retained for the dispatch verified operation. */
    const toolIsolationHandle = isolation.opaqueHandle;
    /** Result of `input.activated.resolved.resources.find`, retained for the dispatch verified operation. */
    const outputResource = input.activated.resolved.resources.find(
      (resource) => resource.key === definition.outputSchema,
    );
    if (outputResource === undefined)
      throw new RuntimeDispatchError(
        "output_schema_missing",
        "Output schema Resource is absent from the resolved definition",
      );
    /** Result of `jsonObject`, retained for the dispatch verified operation. */
    const outputSchema = jsonObject(
      JSON.parse(outputResource.body),
      "Output schema",
    );
    assertSupportedJsonSchema(outputSchema, "Output schema");
    /** Last no verdict snapshot used consistently during the dispatch verified operation. */
    let lastNoVerdict: RetryableNoVerdictError | null = null;
    for (
      let attempt = 1;
      attempt <= definition.retry.maxAttempts;
      attempt += 1
    ) {
      /** Remaining snapshot used consistently during the dispatch verified operation. */
      const remaining = deadlineAt - Date.now();
      if (remaining < 1)
        throw new RuntimeDispatchError(
          "deadline_exceeded",
          "Agent dispatch exceeded its total deadline",
        );
      try {
        /** Result of `cancellableWithinDeadline`, retained for the dispatch verified operation. */
        const process = await cancellableWithinDeadline(
          (signal) =>
            input.runtime.runner.start({
              context,
              controlPlaneHandle,
              outputLimitBytes: input.runtime.config.outputLimitBytes,
              outputSchema,
              signal,
              toolIsolationHandle,
            }),
          deadlineAt,
          input.runtime.config.postKillReapMilliseconds,
          "runner_start_timeout",
          disposeLateProcess,
        );
        /** Result of `superviseProcess`, retained for the dispatch verified operation. */
        const supervised = await superviseProcess({
          deadlineAt,
          graceMilliseconds: input.runtime.config.terminationGraceMilliseconds,
          outputLimitBytes: input.runtime.config.outputLimitBytes,
          postKillReapMilliseconds:
            input.runtime.config.postKillReapMilliseconds,
          process,
        });
        if (supervised.telemetry.toolViolation !== null)
          throw new RuntimeDispatchError(
            "tool_policy_violation",
            "Agent attempted an unauthorized tool operation",
          );
        if (supervised.telemetry.timedOut)
          throw new RuntimeDispatchError(
            "deadline_exceeded",
            "Agent process exceeded the total dispatch deadline",
          );
        if (supervised.completion.exitCode !== 0)
          throw new RetryableNoVerdictError(
            "process_no_verdict",
            `Agent process exited without a verdict (${supervised.completion.exitCode ?? "unknown"})`,
          );
        /** Validated result returned by dispatch verified. */
        const result = parseAgentResult({
          allowedIntents: definition.allowedIntents,
          allowedOutcomes: Object.keys(definition.transitions),
          context,
          outputSchema,
          raw: supervised.stdout,
          ...(definition.requiredIntentSequenceByOutcome === undefined
            ? {}
            : {
                requiredIntentSequenceByOutcome:
                  definition.requiredIntentSequenceByOutcome,
              }),
        });
        return {
          contextDigest: context.digest,
          result,
          telemetry: supervised.telemetry,
        };
      } catch (error) {
        if (
          !(error instanceof RetryableNoVerdictError) ||
          definition.retry.noVerdict !== "retry" ||
          attempt === definition.retry.maxAttempts
        )
          throw error;
        lastNoVerdict = error;
      }
    }
    throw (
      lastNoVerdict ??
      new RuntimeDispatchError(
        "missing_result",
        "Agent execution ended without a result",
      )
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await closeSessions(
      [isolation, controlPlane],
      primaryError,
      input.runtime.config.postKillReapMilliseconds,
    );
  }
}

/** Verifies live assignment against authoritative state. */
export async function verifyLiveAssignment(input: {
  /** Activated dependency consumed by verify live assignment. */
  readonly activated: ActivatedDefinition;
  /** Activation runtime dependency consumed by verify live assignment. */
  readonly activationRuntime: ActivationRuntime;
  /** Promotion dependency consumed by verify live assignment. */
  readonly promotion: AssignmentPromotion;
  /** Provider boundary used for durable state reads and writes. */
  readonly provider: AgentTaskProvider;
}): Promise<ActivatedDefinition> {
  /** Definition id snapshot used consistently during the verify live assignment operation. */
  const definitionId = input.activated.resolved.definition.id;
  if (input.promotion.targetAgentId !== definitionId)
    throw new RuntimeDispatchError(
      "assignment_mismatch",
      "Assignment targets a different Agent",
    );
  /** Result of `activateDefinitions`, retained for the verify live assignment operation. */
  const fresh = await activateDefinitions({
    ...input.activationRuntime,
    provider: input.provider,
  });
  /** Result of `fresh.filter`, retained for the verify live assignment operation. */
  const matches = fresh.filter(
    ({ resolved }) => resolved.definition.id === definitionId,
  );
  if (
    matches.length !== 1 ||
    matches[0] === undefined ||
    matches[0].digest !== input.activated.digest
  )
    throw new RuntimeDispatchError(
      "activation_changed",
      "Agent definition, Resources, or capability grant changed before dispatch",
    );
  try {
    await verifyAssignmentPromotion(input.provider, input.promotion);
  } catch (error) {
    throw new RuntimeDispatchError(
      "assignment_receipt_invalid",
      "Assignment promotion receipt does not match the dispatch",
      { cause: error },
    );
  }
  /** Result of `input.provider.getLeaseProjection`, retained for the verify live assignment operation. */
  const projection = await input.provider.getLeaseProjection(definitionId);
  if (
    !projection.runLeaseIds.includes(input.promotion.runLeaseId) ||
    !projection.taskLeaseIds.includes(input.promotion.taskLeaseId) ||
    !projection.taskIds.includes(input.promotion.taskId)
  )
    throw new RuntimeDispatchError(
      "assignment_inactive",
      "Assignment leases are not active",
    );
  /** Result of `input.provider.getAgentActivity`, retained for the verify live assignment operation. */
  const activity = await input.provider.getAgentActivity(definitionId);
  if (
    activity.status !== "Online" ||
    !sameStringSet(activity.taskIds, projection.taskIds)
  )
    throw new RuntimeDispatchError(
      "activity_mismatch",
      "Agent Status or Working On does not match active leases",
    );
  /** Result of `input.provider.getTaskSnapshot`, retained for the verify live assignment operation. */
  const task = await input.provider.getTaskSnapshot(input.promotion.taskId);
  if (task.archived)
    throw new RuntimeDispatchError(
      "task_archived",
      "Assigned Task is archived",
    );
  if (
    task.version !== input.promotion.taskVersion ||
    task.status !== input.promotion.taskStatus
  )
    throw new RuntimeDispatchError(
      "task_basis_changed",
      "Assigned Task changed after selection",
    );
  for (const dependencyId of task.dependencies) {
    /** Result of `input.provider.getTaskSnapshot`, retained for the verify live assignment operation. */
    const dependency = await input.provider.getTaskSnapshot(dependencyId);
    if (
      dependency.archived ||
      !matches[0].resolved.taskQuery?.dependencySatisfiedStatuses.includes(
        dependency.status,
      )
    )
      throw new RuntimeDispatchError(
        "task_dependency_changed",
        "Assigned Task dependency state changed after selection",
      );
  }
  return matches[0];
}

/** Rejects invalid runner identity before it crosses the boundary. */
function validateRunnerIdentity(
  runtime: ResolvedRuntimeEnvironment,
  profile: string,
  identity: Awaited<
    ReturnType<ResolvedRuntimeEnvironment["runner"]["identity"]>
  >,
): void {
  if (identity.id !== runtime.runner.id || identity.id === "")
    throw new RuntimeDispatchError(
      "runner_identity_invalid",
      "Agent runner identity does not match the configured adapter",
    );
  if (!identity.supportedProfiles.includes(profile))
    throw new RuntimeDispatchError(
      "runner_profile_unsupported",
      `Agent runner does not support profile ${profile}`,
    );
  requireDigest(identity.executableDigest, "Runner executable digest");
  if (identity.executableVersion === "")
    throw new RuntimeDispatchError(
      "runner_identity_invalid",
      "Runner executable version is required",
    );
}

/** Rejects invalid model receipt before it crosses the boundary. */
function validateModelReceipt(
  runtime: ResolvedRuntimeEnvironment,
  model: string,
  reasoning: string,
  runId: string,
  session: ModelTransportSession,
): void {
  /** Receipt produced by validate model receipt. */
  const receipt = session.receipt;
  if (
    receipt.adapterId !== runtime.modelTransport.id ||
    receipt.runId !== runId ||
    receipt.model !== model ||
    receipt.reasoning !== reasoning ||
    receipt.separatedFromToolProcesses !== true ||
    receipt.credentialExposedToTools !== false
  )
    throw new RuntimeDispatchError(
      "model_receipt_invalid",
      "Model transport receipt does not prove the configured control-plane boundary",
    );
  requireDigest(receipt.digest, "Model transport digest");
}

/** Rejects invalid isolation receipt before it crosses the boundary. */
function validateIsolationReceipt(
  runtime: ResolvedRuntimeEnvironment,
  runId: string,
  policyDigest: string,
  session: ToolIsolationSession,
): void {
  /** Receipt produced by validate isolation receipt. */
  const receipt = session.receipt;
  if (
    receipt.adapterId !== runtime.toolIsolation.id ||
    receipt.runId !== runId ||
    receipt.policyDigest !== policyDigest ||
    receipt.processTreeEnforced !== true
  )
    throw new RuntimeDispatchError(
      "isolation_receipt_invalid",
      "Tool isolation receipt does not prove the configured policy boundary",
    );
  for (const [label, value] of [
    ["environment", receipt.environmentDigest],
    ["filesystem", receipt.filesystemPolicyDigest],
    ["network", receipt.networkPolicyDigest],
  ] as const)
    requireDigest(value, `Tool isolation ${label} digest`);
}

/** Closes runtime sessions in reverse ownership order and preserves failures. */
async function closeSessions(
  sessions: readonly (ModelTransportSession | ToolIsolationSession | null)[],
  primaryError: unknown,
  timeoutMilliseconds: number,
): Promise<void> {
  /** Mutable failures collection accumulated during the close sessions operation. */
  const failures: unknown[] = [];
  for (const session of sessions)
    if (session !== null) {
      try {
        await withinDeadline(
          session.close(),
          Date.now() + timeoutMilliseconds,
          "session_close_timeout",
        );
      } catch (error) {
        failures.push(error);
      }
    }
  if (failures.length === 0) return;
  if (primaryError === undefined)
    throw new AggregateError(failures, "Runtime session cleanup failed");
  throw new AggregateError(
    [primaryError, ...failures],
    "Agent runtime failed and session cleanup also failed",
    { cause: primaryError },
  );
}

/** Persists a bounded runtime failure linked to the Task and Agent. */
async function recordRuntimeError(
  input: {
    /** Activated dependency consumed by record runtime error. */
    readonly activated: ActivatedDefinition;
    /** Promotion dependency consumed by record runtime error. */
    readonly promotion: AssignmentPromotion;
    /** Provider boundary used for durable state reads and writes. */
    readonly provider: AgentTaskProvider;
  },
  error: unknown,
): Promise<void> {
  /** Code snapshot used consistently during the record runtime error operation. */
  const code =
    error instanceof RuntimeDispatchError
      ? error.code
      : "unexpected_runtime_failure";
  /** Definition snapshot used consistently during the record runtime error operation. */
  const definition = input.activated.resolved.definition;
  /** Basis snapshot used consistently during the record runtime error operation. */
  const basis = {
    code,
    definitionDigest: input.activated.resolved.digest,
    runId: input.promotion.ownerId,
    taskId: input.promotion.taskId,
  };
  /** Binds record runtime error to canonical operation content. */
  const operationDigest = digestJson(toJsonValue(basis));
  await input.provider.createOrUpdateError({
    description: `Agent runtime failed closed with code ${code}. No exception text or credential-bearing adapter output was persisted.`,
    errorKey: `agent-runtime:${input.promotion.ownerId}`,
    idempotencyKey: `agent-runtime:${operationDigest}`,
    relatedRunId: input.promotion.ownerId,
    relatedAgentId: definition.id,
    relatedTaskId: input.promotion.taskId,
    resolution:
      "Inspect trusted runtime telemetry and receipts outside the provider. Correct the assignment, adapter, policy, or result contract, then start a new verified attempt.",
    severity: "high",
    status: "Not Fixed",
    title: `Agent runtime ${code}`,
  });
}

/** Validates and returns a non-array JSON object. */
function jsonObject(value: unknown, label: string): JsonObject {
  /** Result of `toJsonValue`, retained for the json object operation. */
  const json = toJsonValue(value);
  if (json === null || typeof json !== "object" || Array.isArray(json))
    throw new TypeError(`${label} must be an object`);
  return json;
}

/** Returns digest or throws when invalid or absent. */
function requireDigest(value: string, label: string): void {
  if (!isSha256Digest(value))
    throw new RuntimeDispatchError(
      "receipt_digest_invalid",
      `${label} is invalid`,
    );
}

/** Bounds an asynchronous operation by the remaining absolute deadline. */
async function withinDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  code: string,
): Promise<T> {
  /** Remaining snapshot used consistently during the within deadline operation. */
  const remaining = deadlineAt - Date.now();
  if (remaining < 1)
    throw new RuntimeDispatchError(
      code,
      "Trusted runtime operation exceeded its deadline",
    );
  /** Timeout handle cleared during cleanup. */
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RuntimeDispatchError(
                code,
                "Trusted runtime operation exceeded its deadline",
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Bounds an asynchronous operation by the remaining absolute deadline. */
async function cancellableWithinDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  deadlineAt: number,
  cancellationMilliseconds: number,
  code: string,
  dispose: (value: T) => Promise<void>,
): Promise<T> {
  /** Result of `AbortController`, retained for the cancellable within deadline operation. */
  const controller = new AbortController();
  /** Result of `start`, retained for the cancellable within deadline operation. */
  const operation = start(controller.signal);
  try {
    return await withinDeadline(operation, deadlineAt, code);
  } catch (error) {
    if (!(error instanceof RuntimeDispatchError) || error.code !== code)
      throw error;
    controller.abort(error);
    /** Result of `operation.then`, retained for the cancellable within deadline operation. */
    const lateCleanup = operation.then(dispose, () => undefined);
    /** Result of `settleBefore`, retained for the cancellable within deadline operation. */
    const acknowledged = await settleBefore(
      operation.then(
        () => true,
        () => true,
      ),
      cancellationMilliseconds,
    );
    if (acknowledged === null) {
      void lateCleanup;
      throw new RuntimeDispatchError(
        `${code}_unacknowledged`,
        "Trusted runtime operation did not acknowledge cancellation",
        { cause: error },
      );
    }
    await lateCleanup;
    throw error;
  }
}

/** Force-stops a process that becomes available after its caller timed out. */
async function disposeLateProcess(
  process: Awaited<ReturnType<ResolvedRuntimeEnvironment["runner"]["start"]>>,
): Promise<void> {
  await Promise.allSettled([process.terminateTree(), process.killTree()]);
  await process.cleanup();
}

/** Returns a promise result only when it settles before the timeout. */
async function settleBefore<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T | null> {
  /** Timeout handle cleared during cleanup. */
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
