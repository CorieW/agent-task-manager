/** Launches one currently assigned Sub-agent through environment-bound trusted adapters. */
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

export interface DispatchResult {
  readonly contextDigest: string;
  readonly result: AgentResult;
  readonly telemetry: ProcessTelemetry;
}

export class RuntimeDispatchError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
class RetryableNoVerdictError extends RuntimeDispatchError {}

export async function dispatchActivatedAgent(input: {
  readonly activated: ActivatedDefinition;
  readonly activationRuntime: ActivationRuntime;
  readonly additionalInput: JsonObject;
  readonly promotion: AssignmentPromotion;
  readonly provider: AgentTaskProvider;
  readonly runtime: ResolvedRuntimeEnvironment;
}): Promise<DispatchResult> {
  try {
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

async function dispatchVerified(input: {
  readonly activated: ActivatedDefinition;
  readonly activationRuntime: ActivationRuntime;
  readonly additionalInput: JsonObject;
  readonly promotion: AssignmentPromotion;
  readonly provider: AgentTaskProvider;
  readonly runtime: ResolvedRuntimeEnvironment;
}): Promise<DispatchResult> {
  const definition = input.activated.resolved.definition;
  const runId = input.promotion.ownerId;
  const deadlineAt = Date.now() + definition.deadlineSeconds * 1000;
  const policy = compileToolIsolationPolicy({
    grant: input.activated.grant,
    runId,
    runtime: input.runtime,
  });
  const policyDigest = digestJson(toJsonValue(policy));
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
  let controlPlane: ModelTransportSession | null = null;
  let isolation: ToolIsolationSession | null = null;
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
    const context = await compileRunContext({
      activated: input.activated,
      additionalInput: input.additionalInput,
      provider: input.provider,
      runId,
      runtimeReceipt,
      taskId: input.promotion.taskId,
    });
    const controlPlaneHandle = controlPlane.opaqueHandle;
    const toolIsolationHandle = isolation.opaqueHandle;
    const outputResource = input.activated.resolved.resources.find(
      (resource) => resource.key === definition.outputSchema,
    );
    if (outputResource === undefined)
      throw new RuntimeDispatchError(
        "output_schema_missing",
        "Output schema Resource is absent from the resolved definition",
      );
    const outputSchema = jsonObject(
      JSON.parse(outputResource.body),
      "Output schema",
    );
    assertSupportedJsonSchema(outputSchema, "Output schema");
    let lastNoVerdict: RetryableNoVerdictError | null = null;
    for (
      let attempt = 1;
      attempt <= definition.retry.maxAttempts;
      attempt += 1
    ) {
      const remaining = deadlineAt - Date.now();
      if (remaining < 1)
        throw new RuntimeDispatchError(
          "deadline_exceeded",
          "Agent dispatch exceeded its total deadline",
        );
      try {
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

export async function verifyLiveAssignment(input: {
  readonly activated: ActivatedDefinition;
  readonly activationRuntime: ActivationRuntime;
  readonly promotion: AssignmentPromotion;
  readonly provider: AgentTaskProvider;
}): Promise<ActivatedDefinition> {
  const definitionId = input.activated.resolved.definition.id;
  if (input.promotion.targetSubAgentId !== definitionId)
    throw new RuntimeDispatchError(
      "assignment_mismatch",
      "Assignment targets a different Sub-agent",
    );
  const fresh = await activateDefinitions({
    ...input.activationRuntime,
    provider: input.provider,
  });
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
      "Sub-agent definition, Resources, or capability grant changed before dispatch",
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
  const activity = await input.provider.getSubAgentActivity(definitionId);
  if (
    activity.status !== "Online" ||
    !sameSet(activity.taskIds, projection.taskIds)
  )
    throw new RuntimeDispatchError(
      "activity_mismatch",
      "Sub-agent Status or Working On does not match active leases",
    );
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
function validateModelReceipt(
  runtime: ResolvedRuntimeEnvironment,
  model: string,
  reasoning: string,
  runId: string,
  session: ModelTransportSession,
): void {
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
function validateIsolationReceipt(
  runtime: ResolvedRuntimeEnvironment,
  runId: string,
  policyDigest: string,
  session: ToolIsolationSession,
): void {
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

async function closeSessions(
  sessions: readonly (ModelTransportSession | ToolIsolationSession | null)[],
  primaryError: unknown,
  timeoutMilliseconds: number,
): Promise<void> {
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

async function recordRuntimeError(
  input: {
    readonly activated: ActivatedDefinition;
    readonly promotion: AssignmentPromotion;
    readonly provider: AgentTaskProvider;
  },
  error: unknown,
): Promise<void> {
  const code =
    error instanceof RuntimeDispatchError
      ? error.code
      : "unexpected_runtime_failure";
  const definition = input.activated.resolved.definition;
  const basis = {
    code,
    definitionDigest: input.activated.resolved.digest,
    runId: input.promotion.ownerId,
    taskId: input.promotion.taskId,
  };
  const operationDigest = digestJson(toJsonValue(basis));
  await input.provider.createOrUpdateError({
    description: `Sub-agent runtime failed closed with code ${code}. No exception text or credential-bearing adapter output was persisted.`,
    errorKey: `agent-runtime:${input.promotion.ownerId}`,
    idempotencyKey: `agent-runtime:${operationDigest}`,
    relatedRunId: input.promotion.ownerId,
    relatedSubAgentId: definition.id,
    relatedTaskId: input.promotion.taskId,
    resolution:
      "Inspect trusted runtime telemetry and receipts outside the provider. Correct the assignment, adapter, policy, or result contract, then start a new verified attempt.",
    severity: "high",
    status: "Not Fixed",
    title: `Sub-agent runtime ${code}`,
  });
}

function jsonObject(value: unknown, label: string): JsonObject {
  const json = toJsonValue(value);
  if (json === null || typeof json !== "object" || Array.isArray(json))
    throw new TypeError(`${label} must be an object`);
  return json;
}
function requireDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value))
    throw new RuntimeDispatchError(
      "receipt_digest_invalid",
      `${label} is invalid`,
    );
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    [...new Set(left)].sort().join("\0") ===
    [...new Set(right)].sort().join("\0")
  );
}
async function withinDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  code: string,
): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining < 1)
    throw new RuntimeDispatchError(
      code,
      "Trusted runtime operation exceeded its deadline",
    );
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
async function cancellableWithinDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  deadlineAt: number,
  cancellationMilliseconds: number,
  code: string,
  dispose: (value: T) => Promise<void>,
): Promise<T> {
  const controller = new AbortController();
  const operation = start(controller.signal);
  try {
    return await withinDeadline(operation, deadlineAt, code);
  } catch (error) {
    if (!(error instanceof RuntimeDispatchError) || error.code !== code)
      throw error;
    controller.abort(error);
    const lateCleanup = operation.then(dispose, () => undefined);
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
async function disposeLateProcess(
  process: Awaited<ReturnType<ResolvedRuntimeEnvironment["runner"]["start"]>>,
): Promise<void> {
  await Promise.allSettled([process.terminateTree(), process.killTree()]);
  await process.cleanup();
}
async function settleBefore<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T | null> {
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
