/** Launches one currently assigned Agent through environment-bound trusted adapters. */
import { digestJson } from "../core/digest.js";
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

/** Defines the data and behavior required by dispatch result. */
export interface DispatchResult {
  /** Stores the SHA-256 digest of context. */
  readonly contextDigest: string;
  /** Provides result to dispatch result. */
  readonly result: AgentResult;
  /** Provides telemetry to dispatch result. */
  readonly telemetry: ProcessTelemetry;
}

/** Represents a runtime dispatch failure. */
export class RuntimeDispatchError extends Error {
  /** Creates runtime dispatch error with its required collaborators. */
  public constructor(
    /** Provides code to runtime dispatch error. */ public readonly code: string,
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
  /** Provides activated to dispatch activated agent. */
  readonly activated: ActivatedDefinition;
  /** Provides activation runtime to dispatch activated agent. */
  readonly activationRuntime: ActivationRuntime;
  /** Provides additional input to dispatch activated agent. */
  readonly additionalInput: JsonObject;
  /** Provides promotion to dispatch activated agent. */
  readonly promotion: AssignmentPromotion;
  /** Provides provider to dispatch activated agent. */
  readonly provider: AgentTaskProvider;
  /** Provides runtime to dispatch activated agent. */
  readonly runtime: ResolvedRuntimeEnvironment;
}): Promise<DispatchResult> {
  try {
    /** Stores activated used by dispatch activated agent. */
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
  /** Provides activated to dispatch verified. */
  readonly activated: ActivatedDefinition;
  /** Provides activation runtime to dispatch verified. */
  readonly activationRuntime: ActivationRuntime;
  /** Provides additional input to dispatch verified. */
  readonly additionalInput: JsonObject;
  /** Provides promotion to dispatch verified. */
  readonly promotion: AssignmentPromotion;
  /** Provides provider to dispatch verified. */
  readonly provider: AgentTaskProvider;
  /** Provides runtime to dispatch verified. */
  readonly runtime: ResolvedRuntimeEnvironment;
}): Promise<DispatchResult> {
  /** Stores definition used by dispatch verified. */
  const definition = input.activated.resolved.definition;
  /** Stores run id used by dispatch verified. */
  const runId = input.promotion.ownerId;
  /** Tracks the absolute deadline for dispatch verified. */
  const deadlineAt = Date.now() + definition.deadlineSeconds * 1000;
  /** Stores policy used by dispatch verified. */
  const policy = compileToolIsolationPolicy({
    grant: input.activated.grant,
    runId,
    runtime: input.runtime,
  });
  /** Binds dispatch verified to canonical policy content. */
  const policyDigest = digestJson(toJsonValue(policy));
  /** Stores runner identity used by dispatch verified. */
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
  /** Holds the prepared model-transport session for guaranteed cleanup. */
  let controlPlane: ModelTransportSession | null = null;
  /** Holds the prepared tool-isolation session. */
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
    /** Captures the runtime receipt produced by dispatch verified. */
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
    /** Stores context used by dispatch verified. */
    const context = await compileRunContext({
      activated: input.activated,
      additionalInput: input.additionalInput,
      provider: input.provider,
      runId,
      runtimeReceipt,
      taskId: input.promotion.taskId,
    });
    /** Stores control plane handle used by dispatch verified. */
    const controlPlaneHandle = controlPlane.opaqueHandle;
    /** Stores tool isolation handle used by dispatch verified. */
    const toolIsolationHandle = isolation.opaqueHandle;
    /** Stores output resource used by dispatch verified. */
    const outputResource = input.activated.resolved.resources.find(
      (resource) => resource.key === definition.outputSchema,
    );
    if (outputResource === undefined)
      throw new RuntimeDispatchError(
        "output_schema_missing",
        "Output schema Resource is absent from the resolved definition",
      );
    /** Stores output schema used by dispatch verified. */
    const outputSchema = jsonObject(
      JSON.parse(outputResource.body),
      "Output schema",
    );
    assertSupportedJsonSchema(outputSchema, "Output schema");
    /** Stores last no verdict used by dispatch verified. */
    let lastNoVerdict: RetryableNoVerdictError | null = null;
    for (
      let attempt = 1;
      attempt <= definition.retry.maxAttempts;
      attempt += 1
    ) {
      /** Stores remaining used by dispatch verified. */
      const remaining = deadlineAt - Date.now();
      if (remaining < 1)
        throw new RuntimeDispatchError(
          "deadline_exceeded",
          "Agent dispatch exceeded its total deadline",
        );
      try {
        /** Stores process used by dispatch verified. */
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
        /** Stores supervised used by dispatch verified. */
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
        /** Holds the validated result returned by dispatch verified. */
        const result = parseAgentResult({
          allowedIntents: definition.allowedIntents,
          allowedOutcomes: Object.keys(definition.transitions),
          context,
          outputSchema,
          raw: supervised.stdout,
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
  /** Provides activated to verify live assignment. */
  readonly activated: ActivatedDefinition;
  /** Provides activation runtime to verify live assignment. */
  readonly activationRuntime: ActivationRuntime;
  /** Provides promotion to verify live assignment. */
  readonly promotion: AssignmentPromotion;
  /** Provides provider to verify live assignment. */
  readonly provider: AgentTaskProvider;
}): Promise<ActivatedDefinition> {
  /** Stores definition id used by verify live assignment. */
  const definitionId = input.activated.resolved.definition.id;
  if (input.promotion.targetAgentId !== definitionId)
    throw new RuntimeDispatchError(
      "assignment_mismatch",
      "Assignment targets a different Agent",
    );
  /** Stores fresh used by verify live assignment. */
  const fresh = await activateDefinitions({
    ...input.activationRuntime,
    provider: input.provider,
  });
  /** Stores matches used by verify live assignment. */
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
  /** Stores projection used by verify live assignment. */
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
  /** Stores activity used by verify live assignment. */
  const activity = await input.provider.getAgentActivity(definitionId);
  if (
    activity.status !== "Online" ||
    !sameSet(activity.taskIds, projection.taskIds)
  )
    throw new RuntimeDispatchError(
      "activity_mismatch",
      "Agent Status or Working On does not match active leases",
    );
  /** Stores task used by verify live assignment. */
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
    /** Stores dependency used by verify live assignment. */
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
  /** Captures the receipt produced by validate model receipt. */
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
  /** Captures the receipt produced by validate isolation receipt. */
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
  /** Stores failures used by close sessions. */
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
    /** Provides activated to record runtime error. */
    readonly activated: ActivatedDefinition;
    /** Provides promotion to record runtime error. */
    readonly promotion: AssignmentPromotion;
    /** Provides provider to record runtime error. */
    readonly provider: AgentTaskProvider;
  },
  error: unknown,
): Promise<void> {
  /** Stores code used by record runtime error. */
  const code =
    error instanceof RuntimeDispatchError
      ? error.code
      : "unexpected_runtime_failure";
  /** Stores definition used by record runtime error. */
  const definition = input.activated.resolved.definition;
  /** Stores basis used by record runtime error. */
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
  /** Stores json used by json object. */
  const json = toJsonValue(value);
  if (json === null || typeof json !== "object" || Array.isArray(json))
    throw new TypeError(`${label} must be an object`);
  return json;
}
/** Returns digest or throws when invalid or absent. */
function requireDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value))
    throw new RuntimeDispatchError(
      "receipt_digest_invalid",
      `${label} is invalid`,
    );
}
/** Compares values without making ordering observable. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    [...new Set(left)].sort().join("\0") ===
    [...new Set(right)].sort().join("\0")
  );
}
/** Bounds an asynchronous operation by the remaining absolute deadline. */
async function withinDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  code: string,
): Promise<T> {
  /** Stores remaining used by within deadline. */
  const remaining = deadlineAt - Date.now();
  if (remaining < 1)
    throw new RuntimeDispatchError(
      code,
      "Trusted runtime operation exceeded its deadline",
    );
  /** Tracks the timeout handle so it can be cleared. */
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
  /** Stores controller used by cancellable within deadline. */
  const controller = new AbortController();
  /** Stores operation used by cancellable within deadline. */
  const operation = start(controller.signal);
  try {
    return await withinDeadline(operation, deadlineAt, code);
  } catch (error) {
    if (!(error instanceof RuntimeDispatchError) || error.code !== code)
      throw error;
    controller.abort(error);
    /** Stores late cleanup used by cancellable within deadline. */
    const lateCleanup = operation.then(dispose, () => undefined);
    /** Stores acknowledged used by cancellable within deadline. */
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
  /** Tracks the timeout handle so it can be cleared. */
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
