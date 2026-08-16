/** Exposes provider-backed Agent assignments to an external model harness. */
import { Buffer } from "node:buffer";

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
  type SelectionContext,
} from "../core/selection-coordinator.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type { AgentDefinition, TaskSnapshot } from "../domain/records.js";
import { finalizeRequest } from "../effects/external-effect-broker.js";
import {
  OutcomeTransitionBroker,
  type BlockedOutcomeResolution,
  type OutcomeTransitionReceipt,
} from "../human/outcome-transition-broker.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import {
  finalizeAgentResult,
  parseAgentResult,
  resourceContext,
  type AgentResult,
} from "../runtime/contracts.js";
import { verifyLiveAssignment } from "../runtime/dispatcher.js";

/** Stable provider operation used for one externally executed assignment. */
const HARNESS_ASSIGNMENT_OPERATION = "harness_assignment";

/** Immutable context emitted to the external Agent harness. */
export interface HarnessRunContext {
  /** SHA-256 digest of the activated definition and grant. */
  readonly activationDigest: string;
  /** Capabilities and effect intents granted by the provider definition. */
  readonly capabilityGrant: ActivatedDefinition["grant"];
  /** Provider-defined Agent manifest governing this assignment. */
  readonly definition: AgentDefinition;
  /** SHA-256 digest of the resolved definition and Resource graph. */
  readonly definitionDigest: string;
  /** SHA-256 digest of this complete immutable context. */
  readonly digest: string;
  /** Trusted caller input added to the provider context. */
  readonly input: JsonObject;
  /** Exact Resource versions and digests bound into this assignment. */
  readonly resourcePins: readonly {
    /** SHA-256 digest of canonical Resource content. */
    readonly digest: string;
    /** Stable Resource key. */
    readonly key: string;
    /** Opaque Resource version. */
    readonly version: string;
  }[];
  /** Canonical Resource bodies supplied to the external harness. */
  readonly resources: readonly {
    /** Canonical Resource body. */
    readonly body: string;
    /** Stable Resource key. */
    readonly key: string;
    /** Provider-neutral Resource kind. */
    readonly kind: string;
  }[];
  /** Stable assignment owner copied into the Agent result. */
  readonly runId: string;
  /** Wire schema for an external-harness context. */
  readonly schema: "harness-run-context-v1";
  /** Immutable Task snapshot authorized for this assignment. */
  readonly task: TaskSnapshot;
}

/** Provider-backed assignment returned to an external Agent harness. */
export interface HarnessAssignment {
  /** Immutable Agent context that the harness supplies to the selected role. */
  readonly context: HarnessRunContext;
  /** Stable caller key used to resume this logical assignment. */
  readonly operationKey: string;
  /** Provider-backed leases and Task basis authorizing completion. */
  readonly promotion: AssignmentPromotion;
  /** Wire schema for a prepared external-harness assignment. */
  readonly schema: "harness-assignment-v1";
}

/** Terminal report persisted after outcome routing and lease cleanup. */
export interface HarnessAssignmentReport {
  /** Agent definition that handled the assignment. */
  readonly agentId: string;
  /** Effect identities attested by the external harness in proposal order. */
  readonly effectIds: readonly string[];
  /** Stable caller key identifying the logical assignment. */
  readonly operationKey: string;
  /** Validated provider-defined outcome. */
  readonly outcome: string;
  /** SHA-256 digest of the validated Agent result. */
  readonly resultDigest: string;
  /** Stable assignment owner. */
  readonly runId: string;
  /** Wire schema for a terminal external-harness report. */
  readonly schema: "harness-assignment-report-v1";
  /** Task handled by the assignment. */
  readonly taskId: string;
  /** Durable provider transition applied from the result. */
  readonly transition: OutcomeTransitionReceipt;
}

/** Result of preparing or replaying an external-harness assignment. */
export type HarnessAssignmentPreparation =
  | {
      /** Prepared assignment requiring external execution. */
      readonly assignment: HarnessAssignment;
      /** Lifecycle state of the logical assignment. */
      readonly state: "prepared";
    }
  | {
      /** Previously persisted terminal report. */
      readonly report: HarnessAssignmentReport;
      /** Lifecycle state of the logical assignment. */
      readonly state: "complete";
    };

/** Stable request used to prepare one external-harness assignment. */
export interface HarnessAssignmentRequest {
  /** Agent definition selected by the external harness. */
  readonly agentId: string;
  /** Assignment depth, starting at zero for a human-authorized harness. */
  readonly assignmentDepth: number;
  /** Environment identity bound into durable operation addressing. */
  readonly environmentId: string;
  /** Canonical UTC expiry for the provider-backed assignment leases. */
  readonly expiresAt: string;
  /** Trusted input supplied by the external harness. */
  readonly input: JsonObject;
  /** Stable key used to resume the same logical assignment. */
  readonly operationKey: string;
  /** Provider used for every authoritative read and mutation. */
  readonly provider: AgentTaskProvider;
  /** Task explicitly assigned to the selected Agent. */
  readonly taskId: string;
}

/** Harness attestation for one externally performed proposed intent. */
export interface HarnessEffectAttestation {
  /** Bounded evidence retained in the caller's completion record. */
  readonly evidence: JsonObject;
  /** Proposed intent kind copied from the validated Agent result. */
  readonly kind: string;
  /** Zero-based position in the Agent result's proposed intent list. */
  readonly intentIndex: number;
  /** Wire schema for an external-harness effect attestation. */
  readonly schema: "harness-effect-attestation-v1";
  /** Only completed external effects can authorize outcome routing. */
  readonly state: "applied";
}

/** Result content authored by the external harness before identity binding. */
export interface HarnessAgentResultSubmission {
  /** Provider-defined outcome selected by the external Agent. */
  readonly outcome: string;
  /** Output payload validated against the Agent definition's schema. */
  readonly payload: JsonObject;
  /** Ordered external effects proposed by the Agent. */
  readonly proposedIntents: readonly {
    /** Effect kind declared by the active Agent definition. */
    readonly kind: string;
    /** Canonical effect input executed by the external harness. */
    readonly payload: JsonObject;
  }[];
  /** Wire schema for an identity-free harness result. */
  readonly schema: "harness-agent-result-v1";
}

/** Completion envelope submitted after the external harness runs the Agent. */
export interface HarnessAssignmentCompletion {
  /** Ordered attestations for every proposed external effect. */
  readonly effectAttestations: readonly HarnessEffectAttestation[];
  /** Human-recovery content required by a declared blocking outcome. */
  readonly humanResolution: BlockedOutcomeResolution | null;
  /** Agent-authored result content bound to the prepared context by the manager. */
  readonly result: HarnessAgentResultSubmission;
  /** Confirmed review finding identities, when this result advances review remediation. */
  readonly reviewFindingKeys: readonly string[] | null;
  /** Wire schema for an external-harness completion. */
  readonly schema: "harness-assignment-completion-v1";
  /** Confirmed test failure identities, when this result advances test remediation. */
  readonly testFailureKeys: readonly string[] | null;
}

/** Read-only candidate context exposed to a provider-defined coordinator harness. */
export interface HarnessSelectionPreparation {
  /** Activated selector whose query produced the candidates. */
  readonly agentId: string;
  /** Immutable provider-defined selection basis. */
  readonly selection: SelectionContext;
  /** Wire schema for external-harness candidate preparation. */
  readonly schema: "harness-selection-v1";
}

/** Parses the closed completion envelope produced by an external harness. */
export function parseHarnessAssignmentCompletion(
  value: JsonValue,
): HarnessAssignmentCompletion {
  /** Closed top-level envelope supplied at the untrusted JSON boundary. */
  const completion = jsonObject(value, "Harness assignment completion");
  exactKeys(
    completion,
    [
      "effectAttestations",
      "humanResolution",
      "result",
      "reviewFindingKeys",
      "schema",
      "testFailureKeys",
    ],
    "Harness assignment completion",
  );
  if (completion.schema !== "harness-assignment-completion-v1")
    throw new TypeError("Harness assignment completion schema is invalid");
  if (!Array.isArray(completion.effectAttestations))
    throw new TypeError("Harness effect attestations must be an array");
  /** Ordered proof claims corresponding one-to-one with proposed intents. */
  const effectAttestations = completion.effectAttestations.map(
    (entry, intentIndex) => {
      /** Closed attestation at the expected proposal position. */
      const attestation = jsonObject(
        entry,
        `Harness effect attestation ${intentIndex}`,
      );
      exactKeys(
        attestation,
        ["evidence", "intentIndex", "kind", "schema", "state"],
        `Harness effect attestation ${intentIndex}`,
      );
      if (
        attestation.schema !== "harness-effect-attestation-v1" ||
        attestation.state !== "applied" ||
        attestation.intentIndex !== intentIndex
      )
        throw new TypeError(
          `Harness effect attestation ${intentIndex} is invalid`,
        );
      return {
        evidence: jsonObject(
          attestation.evidence,
          `Harness effect attestation ${intentIndex} evidence`,
        ),
        intentIndex,
        kind: requiredString(
          attestation.kind,
          `Harness effect attestation ${intentIndex} kind`,
        ),
        schema: "harness-effect-attestation-v1" as const,
        state: "applied" as const,
      };
    },
  );
  return {
    effectAttestations,
    humanResolution:
      completion.humanResolution === null
        ? null
        : parseHumanResolution(completion.humanResolution),
    result: parseHarnessResult(completion.result),
    reviewFindingKeys: optionalStringArray(
      completion.reviewFindingKeys,
      "Harness review finding keys",
    ),
    schema: completion.schema,
    testFailureKeys: optionalStringArray(
      completion.testFailureKeys,
      "Harness test failure keys",
    ),
  };
}

/** Parses result content that will be bound to the persisted assignment. */
function parseHarnessResult(
  value: JsonValue | undefined,
): HarnessAgentResultSubmission {
  /** Identity-free result content authored by the external role. */
  const result = jsonObject(value, "Harness Agent result");
  exactKeys(
    result,
    ["outcome", "payload", "proposedIntents", "schema"],
    "Harness Agent result",
  );
  if (result.schema !== "harness-agent-result-v1")
    throw new TypeError("Harness Agent result schema is invalid");
  if (!Array.isArray(result.proposedIntents))
    throw new TypeError("Harness proposed intents must be an array");
  /** Ordered effects requested by the external role. */
  const proposedIntents = result.proposedIntents.map((entry, intentIndex) => {
    /** Closed effect proposal before definition-level authorization. */
    const intent = jsonObject(entry, `Harness proposed intent ${intentIndex}`);
    exactKeys(
      intent,
      ["kind", "payload"],
      `Harness proposed intent ${intentIndex}`,
    );
    return {
      kind: requiredString(
        intent.kind,
        `Harness proposed intent ${intentIndex} kind`,
      ),
      payload: jsonObject(
        intent.payload,
        `Harness proposed intent ${intentIndex} payload`,
      ),
    };
  });
  return {
    outcome: requiredString(result.outcome, "Harness Agent result outcome"),
    payload: jsonObject(result.payload, "Harness Agent result payload"),
    proposedIntents,
    schema: result.schema,
  };
}

/** Parses the human decision request attached to a blocking Agent outcome. */
function parseHumanResolution(
  value: JsonValue | undefined,
): BlockedOutcomeResolution {
  /** Closed human-recovery request paired with the blocking outcome. */
  const resolution = jsonObject(value, "Harness human resolution");
  exactKeys(
    resolution,
    [
      "createdAt",
      "error",
      "generation",
      "prompt",
      "requestedBy",
      "resumeStatus",
    ],
    "Harness human resolution",
  );
  /** Timestamp that orders this human-recovery generation. */
  const createdAt = requiredString(
    resolution.createdAt,
    "Harness human resolution createdAt",
  );
  if (!Number.isFinite(Date.parse(createdAt)))
    throw new TypeError(
      "Harness human resolution createdAt must be a timestamp",
    );
  if (
    typeof resolution.generation !== "number" ||
    !Number.isSafeInteger(resolution.generation) ||
    resolution.generation < 1
  )
    throw new TypeError(
      "Harness human resolution generation must be a positive integer",
    );
  return {
    createdAt,
    error: parseHumanError(resolution.error),
    generation: resolution.generation,
    prompt: requiredString(
      resolution.prompt,
      "Harness human resolution prompt",
    ),
    requestedBy: requiredString(
      resolution.requestedBy,
      "Harness human resolution requestedBy",
    ),
    resumeStatus: requiredString(
      resolution.resumeStatus,
      "Harness human resolution resumeStatus",
    ),
  };
}

/** Parses the Error content persisted before entering human recovery. */
function parseHumanError(
  value: JsonValue | undefined,
): BlockedOutcomeResolution["error"] {
  /** Closed human-visible Error content without manager-owned identity fields. */
  const error = jsonObject(value, "Harness human resolution error");
  exactKeys(
    error,
    [
      "description",
      "errorKey",
      "relatedAgentId",
      "relatedRunId",
      "resolution",
      "severity",
      "status",
      "title",
    ],
    "Harness human resolution error",
  );
  if (
    error.severity !== "critical" &&
    error.severity !== "high" &&
    error.severity !== "medium" &&
    error.severity !== "low"
  )
    throw new TypeError("Harness human resolution error severity is invalid");
  if (
    error.status !== "Not Fixed" &&
    error.status !== "Fixing" &&
    error.status !== "Fixed"
  )
    throw new TypeError("Harness human resolution error status is invalid");
  return {
    description: requiredString(
      error.description,
      "Harness human resolution error description",
    ),
    errorKey: requiredString(
      error.errorKey,
      "Harness human resolution error key",
    ),
    relatedAgentId: optionalString(
      error.relatedAgentId,
      "Harness human resolution relatedAgentId",
    ),
    relatedRunId: optionalString(
      error.relatedRunId,
      "Harness human resolution relatedRunId",
    ),
    resolution: requiredString(
      error.resolution,
      "Harness human resolution error resolution",
    ),
    severity: error.severity,
    status: error.status,
    title: requiredString(error.title, "Harness human resolution error title"),
  };
}

/** Returns the immutable candidate set for a provider-defined harness role. */
export async function prepareHarnessSelection(
  provider: AgentTaskProvider,
  agentId: string,
): Promise<HarnessSelectionPreparation> {
  /** Provider definitions resolved without constructing a model runtime. */
  const { activated } = await activateForHarness(provider);
  /** Unique role whose Task Query bounds the returned candidates. */
  const selector = requiredActivated(
    activated,
    requiredString(agentId, "Agent ID"),
  );
  return {
    agentId: selector.resolved.definition.id,
    schema: "harness-selection-v1",
    selection: await prepareSelection(provider, selector.resolved, activated),
  };
}

/** Prepares or replays one provider-backed assignment without invoking a model. */
export async function prepareHarnessAssignment(
  request: HarnessAssignmentRequest,
): Promise<HarnessAssignmentPreparation> {
  validateRequest(request);
  /** Environment-scoped durable identity for preparation and completion. */
  const intentId = harnessIntentId(request.environmentId, request.operationKey);
  /** Existing logical assignment, if this operation key has been seen. */
  const priorIntent = await request.provider.getOperationIntent(intentId);
  if (priorIntent?.state === "applied") {
    assertOperation(priorIntent.operation);
    /** Frozen assignment request needed for exact terminal replay. */
    const payload = parseOperationPayload(priorIntent.payload);
    assertAssignmentRequest(payload.assignment, payload.requestDigest, request);
    await releaseAssignment(
      request.provider,
      payload.assignment.promotion,
      request.operationKey,
    );
    return { report: parseReport(priorIntent.result), state: "complete" };
  }
  if (priorIntent?.state === "pending") {
    assertOperation(priorIntent.operation);
    /** Frozen preparation payload returned rather than rematerialized. */
    const payload = parseOperationPayload(priorIntent.payload);
    /** Existing live assignment authorized by the pending operation. */
    const assignment = payload.assignment;
    assertAssignmentRequest(assignment, payload.requestDigest, request);
    return { assignment, state: "prepared" };
  }

  /** Provider definitions and declared authority used for assignment checks. */
  const { activated, runtime } = await activateForHarness(request.provider);
  /** Exact role selected by the external Task Master harness. */
  const target = requiredActivated(activated, request.agentId);
  /** Immutable candidate basis proving the Task is currently eligible. */
  const selection = await prepareSelection(
    request.provider,
    target.resolved,
    activated,
  );
  /** Stable lease owner derived from the environment-scoped operation. */
  const runId = `run-${sha256(`${request.environmentId}\0${request.operationKey}`)}`;
  /** Complete caller identity bound into promotion and outer-operation replay. */
  const callerRequestDigest = requestDigest(request);
  /** Digest-bound explicit selection accepted by the promotion boundary. */
  const explicitAssignment = finalizeExplicitAssignment({
    authorityId: runId,
    idempotencyKey: `${request.operationKey}:assignment:${callerRequestDigest}`,
    schema: "explicit-assignment-v1",
    selectionBasisDigest: selection.basisDigest,
    targetAgentId: request.agentId,
    targetAgentRevision: target.resolved.definition.revision,
    taskId: request.taskId,
  });
  /** Provider-backed run and Task leases authorizing the external execution. */
  const promotion = await promoteExplicitAssignment({
    activationRuntime: runtime,
    assignment: explicitAssignment,
    assignmentDepth: request.assignmentDepth,
    expiresAt: request.expiresAt,
    ownerId: runId,
    provider: request.provider,
    resolvedTarget: target.resolved,
    selectionContext: selection,
  });
  await verifyLiveAssignment({
    activated: target,
    activationRuntime: runtime,
    promotion,
    provider: request.provider,
  });
  /** Immutable role, Task, Resource, and input snapshot returned externally. */
  const context = compileHarnessContext(
    target,
    request.input,
    runId,
    await request.provider.getTaskSnapshot(request.taskId),
  );
  /** Complete prepared assignment persisted for retry and completion. */
  const assignment: HarnessAssignment = {
    context,
    operationKey: request.operationKey,
    promotion,
    schema: "harness-assignment-v1",
  };
  /** Canonical operation payload binding the assignment to caller input. */
  const operationPayload = toJsonValue({
    assignment,
    environmentId: request.environmentId,
    requestDigest: callerRequestDigest,
    schema: "harness-assignment-operation-v1",
  });
  /** Durable preparation intent, including any concurrent winner. */
  const intent = await request.provider.beginOperationIntent(
    intentId,
    HARNESS_ASSIGNMENT_OPERATION,
    operationPayload,
  );
  if (intent.state === "applied")
    return { report: parseReport(intent.result), state: "complete" };
  /** Authoritative payload chosen by the provider intent boundary. */
  const persistedPayload = parseOperationPayload(intent.payload);
  /** Persisted assignment returned to every exact retry. */
  const persisted = persistedPayload.assignment;
  assertAssignmentRequest(persisted, persistedPayload.requestDigest, request);
  return { assignment: persisted, state: "prepared" };
}

/** Validates an external result, applies its provider outcome, and releases leases. */
export async function completeHarnessAssignment(input: {
  /** Completion envelope returned by the trusted external harness. */
  readonly completion: HarnessAssignmentCompletion;
  /** Environment identity used when the assignment was prepared. */
  readonly environmentId: string;
  /** Stable operation key used when the assignment was prepared. */
  readonly operationKey: string;
  /** Provider owning the assignment and outcome state. */
  readonly provider: AgentTaskProvider;
}): Promise<HarnessAssignmentReport> {
  /** Durable operation address shared with the preparation command. */
  const intentId = harnessIntentId(input.environmentId, input.operationKey);
  /** Prepared or terminal operation that authorizes this completion. */
  const intent = await input.provider.getOperationIntent(intentId);
  if (intent === null)
    throw new Error("Harness assignment has not been prepared");
  assertOperation(intent.operation);
  /** Immutable assignment and caller identity frozen during preparation. */
  const payload = parseOperationPayload(intent.payload);
  if (
    payload.environmentId !== input.environmentId ||
    payload.assignment.operationKey !== input.operationKey
  )
    throw new Error("Harness assignment identity does not match completion");
  /** Provider-backed assignment being completed. */
  const assignment = payload.assignment;
  /** Frozen Agent contract used instead of mutable provider state. */
  const definition = assignment.context.definition;
  /** Frozen schema used to validate the externally authored payload. */
  const outputSchema = resourceByKey(
    assignment.context.resources,
    definition.outputSchema,
  );
  /** Identity-free result content submitted by the harness. */
  const submittedResult = input.completion.result;
  /** Canonical Agent result bound to the prepared context and definition. */
  const result = parseAgentResult({
    allowedIntents: definition.allowedIntents,
    allowedOutcomes: Object.keys(definition.transitions),
    context: assignment.context,
    outputSchema: jsonObject(JSON.parse(outputSchema.body), "Output schema"),
    raw: JSON.stringify(
      finalizeAgentResult({
        contextDigest: assignment.context.digest,
        definitionDigest: assignment.context.definitionDigest,
        outcome: submittedResult.outcome,
        payload: submittedResult.payload,
        proposedIntents: submittedResult.proposedIntents,
        runId: assignment.context.runId,
        schema: "agent-result-v1",
      }),
    ),
    ...(definition.requiredIntentSequenceByOutcome === undefined
      ? {}
      : {
          requiredIntentSequenceByOutcome:
            definition.requiredIntentSequenceByOutcome,
        }),
  });
  /** Exact effect identities proven applied by ordered harness attestations. */
  const effectIds = validateEffectAttestations(
    result,
    input.completion.effectAttestations,
  );
  if (intent.state === "applied") {
    /** Terminal report retained by the completed logical operation. */
    const report = parseReport(intent.result);
    if (report.resultDigest !== result.digest)
      throw new Error(
        "Completed harness assignment was submitted with a different result",
      );
    await releaseAssignment(
      input.provider,
      assignment.promotion,
      input.operationKey,
    );
    return report;
  }

  /** Current provider authority used to reject definition or Resource drift. */
  const { activated, runtime } = await activateForHarness(input.provider);
  /** Current activation corresponding to the frozen assignment definition. */
  const target = requiredActivated(activated, definition.id);
  if (target.digest !== assignment.context.activationDigest)
    throw new Error("Agent definition or Resources changed after preparation");
  await verifyLiveAssignment({
    activated: target,
    activationRuntime: runtime,
    promotion: assignment.promotion,
    provider: input.provider,
  });
  /** Durable provider transition derived from the validated Agent result. */
  const transition = await applyOutcome(
    input.provider,
    assignment,
    result,
    input.completion,
  );
  /** Terminal replay record persisted before fallible lease cleanup. */
  const report: HarnessAssignmentReport = {
    agentId: definition.id,
    effectIds,
    operationKey: input.operationKey,
    outcome: result.outcome,
    resultDigest: result.digest,
    runId: assignment.context.runId,
    schema: "harness-assignment-report-v1",
    taskId: assignment.context.task.id,
    transition,
  };
  /** Completed operation that freezes the transition and terminal report. */
  const completed = await input.provider.completeOperationIntent(
    intentId,
    HARNESS_ASSIGNMENT_OPERATION,
    intent.payload,
    toJsonValue(report),
  );
  /** Provider-owned terminal report returned by all subsequent retries. */
  const persistedReport = parseReport(completed.result);
  await releaseAssignment(
    input.provider,
    assignment.promotion,
    input.operationKey,
  );
  return persistedReport;
}

/** Builds the runtime declaration used only to validate provider-defined authority. */
async function activateForHarness(provider: AgentTaskProvider): Promise<{
  readonly activated: readonly ActivatedDefinition[];
  readonly runtime: ActivationRuntime;
}> {
  /** Complete provider definition set evaluated for internal consistency. */
  const definitions = await provider.listAgentDefinitions();
  /** Declared model/reasoning pairs used as metadata-validation inputs only. */
  const supportedModels: Record<string, string[]> = {};
  for (const definition of definitions) {
    /** Reasoning levels declared for this model across provider definitions. */
    const values = supportedModels[definition.model] ?? [];
    if (!values.includes(definition.reasoning))
      values.push(definition.reasoning);
    supportedModels[definition.model] = values;
  }
  /** Synthetic availability declaration that never constructs an adapter. */
  const runtime: ActivationRuntime = {
    installedCapabilities: unique(
      definitions.flatMap(({ capabilities }) => capabilities),
    ),
    installedIntents: unique(
      definitions.flatMap(({ allowedIntents }) => allowedIntents),
    ),
    installedRunnerProfiles: unique(
      definitions.map(({ runnerProfile }) => runnerProfile),
    ),
    supportedModels,
  };
  return {
    activated: await activateDefinitions({ ...runtime, provider }),
    runtime,
  };
}

/** Compiles one bounded provider context without launching a model runtime. */
function compileHarnessContext(
  activated: ActivatedDefinition,
  input: JsonObject,
  runId: string,
  task: TaskSnapshot,
): HarnessRunContext {
  /** Fully resolved definition and transitive Resource graph. */
  const resolved = activated.resolved;
  /** Digest input containing every immutable value exposed to the harness. */
  const core = {
    activationDigest: activated.digest,
    capabilityGrant: activated.grant,
    definition: resolved.definition,
    definitionDigest: resolved.digest,
    input: structuredClone(input),
    resourcePins: resolved.resources.map(({ digest, key, version }) => ({
      digest,
      key,
      version,
    })),
    resources: resourceContext(resolved.resources),
    runId,
    schema: "harness-run-context-v1" as const,
    task,
  };
  if (
    Buffer.byteLength(JSON.stringify(toJsonValue(core)), "utf8") >
    resolved.definition.contextBudgetBytes
  )
    throw new Error(
      "Compiled harness context exceeds the Agent context budget",
    );
  return { ...structuredClone(core), digest: digestJson(toJsonValue(core)) };
}

/** Applies the result's provider-defined outcome route. */
async function applyOutcome(
  provider: AgentTaskProvider,
  assignment: HarnessAssignment,
  result: AgentResult,
  completion: HarnessAssignmentCompletion,
): Promise<OutcomeTransitionReceipt> {
  /** Frozen routing contract from the prepared context. */
  const definition = assignment.context.definition;
  /** Whether this outcome must install a durable human-recovery slot. */
  const requiresHuman = definition.humanResolutionOutcomes.includes(
    result.outcome,
  );
  if (requiresHuman) {
    if (completion.humanResolution === null)
      throw new Error("Harness completion requires human-resolution content");
    if (
      completion.reviewFindingKeys !== null ||
      completion.testFailureKeys !== null
    )
      throw new Error(
        "Human resolution cannot also advance a remediation cycle",
      );
    return new OutcomeTransitionBroker(provider).apply({
      definition,
      expectedTaskStatus: assignment.promotion.taskStatus,
      expectedTaskVersion: assignment.promotion.taskVersion,
      kind: "human_resolution",
      outcome: result.outcome,
      resolution: completion.humanResolution,
      taskId: assignment.context.task.id,
    });
  }
  if (completion.humanResolution !== null)
    throw new Error(
      "Harness completion supplied unexpected human-resolution content",
    );
  if (
    completion.reviewFindingKeys !== null &&
    completion.testFailureKeys !== null
  )
    throw new Error(
      "Harness completion cannot advance both remediation cycles",
    );
  return new OutcomeTransitionBroker(provider).apply({
    definition,
    expectedTaskStatus: assignment.promotion.taskStatus,
    expectedTaskVersion: assignment.promotion.taskVersion,
    idempotencyKey: `${assignment.operationKey}:outcome:${result.digest}`,
    kind: "task_transition",
    outcome: result.outcome,
    ...(completion.reviewFindingKeys === null
      ? {}
      : { reviewCycle: { findingKeys: completion.reviewFindingKeys } }),
    ...(completion.testFailureKeys === null
      ? {}
      : { testCycle: { failureKeys: completion.testFailureKeys } }),
    taskId: assignment.context.task.id,
  });
}

/** Validates exact ordered harness attestations and returns effect identities. */
function validateEffectAttestations(
  result: AgentResult,
  attestations: readonly HarnessEffectAttestation[],
): readonly string[] {
  if (attestations.length !== result.proposedIntents.length)
    throw new Error(
      "Harness completion must attest every proposed intent exactly once",
    );
  return result.proposedIntents.map((intent, intentIndex) => {
    /** Attestation occupying the exact corresponding proposal position. */
    const attestation = attestations[intentIndex];
    if (
      attestation === undefined ||
      attestation.schema !== "harness-effect-attestation-v1" ||
      attestation.state !== "applied" ||
      attestation.intentIndex !== intentIndex ||
      attestation.kind !== intent.kind
    )
      throw new Error(`Harness effect attestation ${intentIndex} is invalid`);
    jsonObject(
      attestation.evidence,
      `Harness effect attestation ${intentIndex} evidence`,
    );
    return finalizeRequest({
      kind: intent.kind,
      payload: intent.payload,
      source: {
        contextDigest: result.contextDigest,
        definitionDigest: result.definitionDigest,
        intentIndex,
        resultDigest: result.digest,
        runId: result.runId,
      },
    }).effectId;
  });
}

/** Releases both assignment leases and reconciles the Agent activity projection. */
async function releaseAssignment(
  provider: AgentTaskProvider,
  promotion: AssignmentPromotion,
  operationKey: string,
): Promise<void> {
  /** Lease projection that the existing activity row is expected to reflect. */
  const beforeProjection = await provider.getLeaseProjection(
    promotion.targetAgentId,
  );
  /** Activity state used as the compare-and-set basis for reconciliation. */
  const beforeActivity = await provider.getAgentActivity(
    promotion.targetAgentId,
  );
  await releaseLease(provider, promotion.taskLeaseId, promotion.ownerId);
  await releaseLease(provider, promotion.runLeaseId, promotion.ownerId);
  /** Authoritative lease projection after both idempotent releases. */
  const afterProjection = await provider.getLeaseProjection(
    promotion.targetAgentId,
  );
  if (
    beforeActivity.status !==
      (afterProjection.runLeaseIds.length === 0 ? "Offline" : "Online") ||
    !sameSet(beforeActivity.taskIds, afterProjection.taskIds)
  ) {
    await provider.updateAgentActivity({
      expectedRunLeaseIds: beforeProjection.runLeaseIds,
      expectedTaskIds: beforeActivity.taskIds,
      idempotencyKey: `${operationKey}:activity-release`,
      nextRunLeaseIds: afterProjection.runLeaseIds,
      nextTaskIds: afterProjection.taskIds,
      agentId: promotion.targetAgentId,
    });
  }
}

/** Releases a matching active lease and treats exact prior release as complete. */
async function releaseLease(
  provider: AgentTaskProvider,
  leaseId: string,
  ownerId: string,
): Promise<void> {
  /** Current lease state, including a prior matching release. */
  const lease = await provider.getLeaseSnapshot(leaseId);
  if (lease === null) return;
  if (lease.ownerId !== ownerId)
    throw new Error(`Assignment lease ${leaseId} belongs to a different owner`);
  if (lease.released) return;
  await provider.releaseLease({
    expectedVersion: lease.version,
    leaseId,
    ownerId,
  });
}

/** Parses the immutable payload stored for a prepared assignment. */
function parseOperationPayload(value: JsonValue): {
  readonly assignment: HarnessAssignment;
  readonly environmentId: string;
  readonly requestDigest: string;
} {
  /** Closed provider payload that binds caller input to one assignment. */
  const payload = jsonObject(value, "Harness assignment operation");
  exactKeys(
    payload,
    ["assignment", "environmentId", "requestDigest", "schema"],
    "Harness assignment operation",
  );
  if (payload.schema !== "harness-assignment-operation-v1")
    throw new TypeError("Harness assignment operation schema is invalid");
  /** Persisted assignment validated before any field is trusted. */
  const assignment = payload.assignment as unknown as HarnessAssignment;
  validatePersistedAssignment(assignment);
  return {
    assignment: structuredClone(assignment),
    environmentId: requiredString(payload.environmentId, "Environment ID"),
    requestDigest: requiredDigest(payload.requestDigest, "Request digest"),
  };
}

/** Rejects malformed or digest-inconsistent persisted assignment data. */
function validatePersistedAssignment(value: HarnessAssignment): void {
  if (
    value === null ||
    typeof value !== "object" ||
    value.schema !== "harness-assignment-v1"
  )
    throw new TypeError("Harness assignment is invalid");
  /** Immutable context whose digest protects its nested assignment data. */
  const context = value.context;
  if (context.schema !== "harness-run-context-v1")
    throw new TypeError("Harness context schema is invalid");
  /** Context body recomputed to verify the stored digest. */
  const { digest, ...core } = context;
  requiredDigest(digest, "Harness context digest");
  if (digestJson(toJsonValue(core)) !== digest)
    throw new TypeError("Harness context digest is invalid");
  if (
    context.runId !== value.promotion.ownerId ||
    context.task.id !== value.promotion.taskId ||
    context.definition.id !== value.promotion.targetAgentId ||
    context.definitionDigest === "" ||
    context.activationDigest === ""
  )
    throw new Error("Harness assignment context conflicts with its promotion");
}

/** Parses a terminal assignment report from provider-owned state. */
function parseReport(value: JsonValue): HarnessAssignmentReport {
  /** Closed provider-owned terminal report. */
  const report = jsonObject(value, "Harness assignment report");
  exactKeys(
    report,
    [
      "agentId",
      "effectIds",
      "operationKey",
      "outcome",
      "resultDigest",
      "runId",
      "schema",
      "taskId",
      "transition",
    ],
    "Harness assignment report",
  );
  if (report.schema !== "harness-assignment-report-v1")
    throw new TypeError("Harness assignment report schema is invalid");
  if (!Array.isArray(report.effectIds))
    throw new TypeError("Harness assignment report effectIds must be an array");
  /** Ordered canonical identities of all attested effects. */
  const effectIds = report.effectIds.map((item) =>
    requiredDigest(item, "Harness assignment report effect ID"),
  );
  return {
    agentId: requiredString(
      report.agentId,
      "Harness assignment report agentId",
    ),
    effectIds,
    operationKey: requiredString(
      report.operationKey,
      "Harness assignment report operationKey",
    ),
    outcome: requiredString(
      report.outcome,
      "Harness assignment report outcome",
    ),
    resultDigest: requiredDigest(
      report.resultDigest,
      "Harness assignment report resultDigest",
    ),
    runId: requiredString(report.runId, "Harness assignment report runId"),
    schema: report.schema,
    taskId: requiredString(report.taskId, "Harness assignment report taskId"),
    transition: parseTransitionReceipt(report.transition),
  };
}

/** Parses the provider receipt retained in a terminal harness report. */
function parseTransitionReceipt(
  value: JsonValue | undefined,
): OutcomeTransitionReceipt {
  /** Closed transition receipt embedded in the terminal report. */
  const receipt = jsonObject(value, "Harness assignment transition");
  exactKeys(
    receipt,
    ["humanSlotId", "kind", "targetStatus", "taskVersion"],
    "Harness assignment transition",
  );
  if (
    (receipt.kind !== "human_resolution" &&
      receipt.kind !== "task_transition") ||
    (receipt.kind === "human_resolution" &&
      typeof receipt.humanSlotId !== "string") ||
    (receipt.kind === "task_transition" && receipt.humanSlotId !== null)
  )
    throw new TypeError("Harness assignment transition is invalid");
  return {
    humanSlotId:
      receipt.kind === "human_resolution"
        ? requiredString(
            receipt.humanSlotId,
            "Harness assignment transition humanSlotId",
          )
        : null,
    kind: receipt.kind,
    targetStatus: requiredString(
      receipt.targetStatus,
      "Harness assignment transition targetStatus",
    ),
    taskVersion: requiredString(
      receipt.taskVersion,
      "Harness assignment transition taskVersion",
    ),
  } as OutcomeTransitionReceipt;
}

/** Confirms a replayed prepared assignment belongs to the exact caller request. */
function assertAssignmentRequest(
  assignment: HarnessAssignment,
  storedRequestDigest: string,
  request: HarnessAssignmentRequest,
): void {
  if (
    assignment.operationKey !== request.operationKey ||
    assignment.context.definition.id !== request.agentId ||
    assignment.context.task.id !== request.taskId ||
    storedRequestDigest !== requestDigest(request)
  )
    throw new Error(
      "Harness assignment operation key was reused with different input",
    );
}

/** Computes the immutable caller-request digest stored with a prepared assignment. */
function requestDigest(request: HarnessAssignmentRequest): string {
  return digestJson(
    toJsonValue({
      agentId: request.agentId,
      assignmentDepth: request.assignmentDepth,
      environmentId: request.environmentId,
      expiresAt: request.expiresAt,
      input: request.input,
      operationKey: request.operationKey,
      taskId: request.taskId,
    }),
  );
}

/** Validates a new external-harness assignment before provider mutation. */
function validateRequest(request: HarnessAssignmentRequest): void {
  requiredString(request.agentId, "Agent ID");
  requiredString(request.environmentId, "Environment ID");
  requiredString(request.operationKey, "Operation key");
  requiredString(request.taskId, "Task ID");
  if (
    !Number.isSafeInteger(request.assignmentDepth) ||
    request.assignmentDepth < 0
  )
    throw new TypeError("Assignment depth must be a non-negative integer");
  /** Parsed canonical expiry compared with the local preparation clock. */
  const expiresAt = Date.parse(request.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== request.expiresAt ||
    expiresAt <= Date.now()
  )
    throw new TypeError(
      "Lease expiry must be a canonical future UTC timestamp",
    );
  jsonObject(request.input, "Harness input");
}

/** Returns the provider intent address for one environment-scoped operation key. */
function harnessIntentId(environmentId: string, operationKey: string): string {
  return `harness-assignment/${sha256(`${environmentId}\0${operationKey}`)}`;
}

/** Rejects a provider operation belonging to another workflow. */
function assertOperation(operation: string): void {
  if (operation !== HARNESS_ASSIGNMENT_OPERATION)
    throw new Error("Harness assignment key belongs to another operation");
}

/** Returns one uniquely activated definition. */
function requiredActivated(
  values: readonly ActivatedDefinition[],
  agentId: string,
): ActivatedDefinition {
  /** Definitions matching the stable logical Agent ID. */
  const matches = values.filter(
    ({ resolved }) => resolved.definition.id === agentId,
  );
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error(`Agent ${agentId} is not uniquely activated`);
  return matches[0];
}

/** Returns a context Resource by exact key. */
function resourceByKey(
  resources: HarnessRunContext["resources"],
  key: string,
): HarnessRunContext["resources"][number] {
  /** Frozen Resource entries matching the required exact key. */
  const matches = resources.filter((resource) => resource.key === key);
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error(
      `Harness context Resource is missing or duplicated: ${key}`,
    );
  return matches[0];
}

/** Returns a non-array JSON object or throws. */
function jsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as JsonObject;
}

/** Requires exactly the expected object fields. */
function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    throw new TypeError(`${label} has unexpected or missing fields`);
}

/** Parses an optional ordered collection of non-empty strings. */
function optionalStringArray(
  value: JsonValue | undefined,
  label: string,
): readonly string[] | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item === "")
  )
    throw new TypeError(
      `${label} must be null or an array of non-empty strings`,
    );
  return [...value] as string[];
}

/** Requires a non-empty string. */
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Requires either a non-empty string or an explicit null. */
function optionalString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

/** Requires a lowercase SHA-256 digest. */
function requiredDigest(value: unknown, label: string): string {
  /** Non-empty candidate checked against the canonical digest syntax. */
  const digest = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest))
    throw new TypeError(`${label} must be a SHA-256 digest`);
  return digest;
}

/** Returns unique strings in deterministic order. */
function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/** Checks whether two collections contain the same distinct values. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return unique(left).join("\0") === unique(right).join("\0");
}
