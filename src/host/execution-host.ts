/** Composes one explicit Agent assignment through dispatch, effects, outcome routing, and cleanup. */
import type { EnvironmentConfig } from "../config/environment.js";
import {
  activateDefinitions,
  type ActivatedDefinition,
} from "../core/definition-activation.js";
import { sha256 } from "../core/digest.js";
import {
  finalizeExplicitAssignment,
  prepareSelection,
  promoteExplicitAssignment,
  type ActivationRuntime,
  type AssignmentPromotion,
} from "../core/selection-coordinator.js";
import type { JsonObject } from "../domain/json.js";
import type { TaskSnapshot } from "../domain/records.js";
import type { ExternalEffectExecution } from "../effects/contracts.js";
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
  type DispatchResult,
} from "../runtime/dispatcher.js";
import type { ResolvedRuntimeEnvironment } from "../runtime/environment.js";

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

/** Runs one explicit assignment through every trusted manager-owned boundary. */
export async function runExplicitAgentTask(input: {
  /** Environment-specific runtime and effect bindings. */
  readonly bindings: AgentExecutionBindings;
  /** Stable execution request. */
  readonly request: AgentExecutionRequest;
}): Promise<AgentExecutionReport> {
  validateRequest(input.request);
  const { bindings, request } = input;
  const runId = `run-${sha256(request.operationKey)}`;
  let primaryError: unknown;
  try {
    const activatedDefinitions = await activateDefinitions({
      ...bindings.activationRuntime,
      definitionIds: [request.agentId],
      provider: request.provider,
    });
    const activated = activatedDefinitions[0];
    if (activated === undefined)
      throw new Error(`Agent definition is unavailable: ${request.agentId}`);
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
    const promotion = await promoteExplicitAssignment({
      activationRuntime: bindings.activationRuntime,
      assignment,
      assignmentDepth: request.assignmentDepth,
      expiresAt: request.expiresAt,
      ownerId: runId,
      provider: request.provider,
      resolvedTarget: activated.resolved,
      selectionContext,
    });
    const task = await request.provider.getTaskSnapshot(request.taskId);
    const prepared = await bindings.prepare({
      activated,
      config: request.config,
      promotion,
      provider: request.provider,
      task,
    });
    const deadlineAt =
      Date.now() + activated.resolved.definition.deadlineSeconds * 1_000;
    const dispatched = await dispatchActivatedAgent({
      activated,
      activationRuntime: bindings.activationRuntime,
      additionalInput: prepared.additionalInput,
      promotion,
      provider: request.provider,
      runtime: prepared.runtime,
    });
    const effects = await bindings.executeEffects({
      deadlineAt,
      result: dispatched.result,
    });
    assertAppliedEffects(dispatched.result, effects);
    const transition = await applyOutcome({
      bindings,
      dispatched,
      operationKey: request.operationKey,
      provider: request.provider,
      task,
      taskId: request.taskId,
      activated,
    });
    await releaseAssignment(request.provider, promotion, request.operationKey);
    return {
      agentId: request.agentId,
      contextDigest: dispatched.contextDigest,
      effectIds: effects.map((effect) => effect.request.effectId),
      operationKey: request.operationKey,
      outcome: dispatched.result.outcome,
      resultDigest: dispatched.result.digest,
      runId,
      schema: "agent-execution-report-v1",
      taskId: request.taskId,
      transition,
    };
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

/** Applies the provider-defined result route after every proposed effect is durable. */
async function applyOutcome(input: {
  readonly activated: ActivatedDefinition;
  readonly bindings: AgentExecutionBindings;
  readonly dispatched: DispatchResult;
  readonly operationKey: string;
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
    return broker.apply({
      definition,
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
  return broker.apply({
    definition,
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
    if (effect.state !== "applied" || effect.receipt === null)
      throw new Error(`External effect ${index} did not reach applied state`);
    if (effect.request.kind !== result.proposedIntents[index]?.kind)
      throw new Error(
        `External effect ${index} does not match the Agent result`,
      );
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
    if (lease === null || lease.ownerId !== promotion.ownerId || lease.released)
      throw new Error(
        `Assignment lease is unavailable for release: ${leaseId}`,
      );
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
function validateRequest(request: AgentExecutionRequest): void {
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
  if (
    !Number.isFinite(Date.parse(request.expiresAt)) ||
    Date.parse(request.expiresAt) <= Date.now()
  )
    throw new TypeError("Assignment expiry must be a future ISO timestamp");
}
