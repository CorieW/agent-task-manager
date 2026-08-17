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
  rebindAssignmentPromotion,
  type ActivationRuntime,
  type AssignmentPromotion,
  type SelectionContext,
} from "../core/selection-coordinator.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type {
  AgentDefinition,
  LeaseSnapshot,
  TaskSnapshot,
} from "../domain/records.js";
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

/** Intent kinds applied directly to the assigned Task by the manager. */
const MANAGER_TASK_INTENTS = new Set([
  "task.github_link.record",
  "task.plan.publish",
]);

/** Stable markers delimiting the Planner-owned section in a Task body. */
const PLAN_SECTION = {
  end: "<!-- agent-task-manager:plan:end -->",
  start: "<!-- agent-task-manager:plan:start -->",
} as const;

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

/** Result of extending or recovering one prepared harness assignment. */
export interface HarnessAssignmentRenewal {
  /** Canonical UTC expiry now protecting both assignment leases. */
  readonly expiresAt: string;
  /** Stable caller key identifying the logical assignment. */
  readonly operationKey: string;
  /** Current provider-backed promotion, including recovered lease IDs. */
  readonly promotion: AssignmentPromotion;
  /** Wire schema for an external-harness lease renewal. */
  readonly schema: "harness-assignment-renewal-v1";
  /** Whether existing leases were extended or expired leases were reacquired. */
  readonly state: "recovered" | "renewed";
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
        typeof attestation.intentIndex !== "number" ||
        !Number.isSafeInteger(attestation.intentIndex) ||
        attestation.intentIndex < 0
      )
        throw new TypeError(
          `Harness effect attestation ${intentIndex} is invalid`,
        );
      return {
        evidence: jsonObject(
          attestation.evidence,
          `Harness effect attestation ${intentIndex} evidence`,
        ),
        intentIndex: attestation.intentIndex,
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

/** Extends a prepared assignment, reacquiring its exact authority after expiry. */
export async function renewHarnessAssignment(input: {
  /** Environment identity used when the assignment was prepared. */
  readonly environmentId: string;
  /** Canonical future expiry requested for both assignment leases. */
  readonly expiresAt: string;
  /** Stable operation key used when the assignment was prepared. */
  readonly operationKey: string;
  /** Provider owning the assignment and lease state. */
  readonly provider: AgentTaskProvider;
}): Promise<HarnessAssignmentRenewal> {
  assertFutureLeaseExpiry(input.expiresAt);
  /** Prepared operation whose immutable Task and Agent basis is renewed. */
  const intent = await input.provider.getOperationIntent(
    harnessIntentId(input.environmentId, input.operationKey),
  );
  if (intent === null)
    throw new Error("Harness assignment has not been prepared");
  assertOperation(intent.operation);
  if (intent.state === "applied")
    throw new Error("Completed harness assignment cannot be renewed");
  /** Frozen assignment authorized by the pending operation. */
  const payload = parseOperationPayload(intent.payload);
  if (
    payload.environmentId !== input.environmentId ||
    payload.assignment.operationKey !== input.operationKey
  )
    throw new Error("Harness assignment identity does not match renewal");
  /** Current activation checked before any lease is changed. */
  const { activated, runtime } = await activateForHarness(input.provider);
  /** Current target corresponding to the frozen assignment definition. */
  const target = requiredActivated(
    activated,
    payload.assignment.context.definition.id,
  );
  if (target.digest !== payload.assignment.context.activationDigest)
    throw new Error("Agent definition or Resources changed after preparation");
  await assertTaskBasis(input.provider, payload.assignment.promotion);
  /** Current authority, or newly reacquired authority after expiry. */
  const existing = await activeAssignmentPromotion(
    input.provider,
    payload.assignment.promotion,
  );
  const promotion =
    existing ??
    (await recoverAssignmentPromotion(
      input.provider,
      payload.assignment.promotion,
      input.operationKey,
      input.expiresAt,
    ));
  /** Promotion after convergent extension of both live leases. */
  const renewed = await extendAssignmentPromotion(
    input.provider,
    promotion,
    input.operationKey,
    input.expiresAt,
  );
  await input.provider.reconcileAgentActivity(
    renewed.targetAgentId,
    `${input.operationKey}:activity-renew:${sha256(input.expiresAt)}`,
  );
  try {
    await verifyLiveAssignment({
      activated: target,
      activationRuntime: runtime,
      promotion: renewed,
      provider: input.provider,
    });
  } catch (error) {
    if (existing === null)
      await releaseAssignment(input.provider, renewed, input.operationKey);
    throw error;
  }
  return {
    expiresAt: input.expiresAt,
    operationKey: input.operationKey,
    promotion: renewed,
    schema: "harness-assignment-renewal-v1",
    state: existing === null ? "recovered" : "renewed",
  };
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
  /** Manager-owned Task content and properties derived from declared intents. */
  const taskUpdate = managerTaskUpdate(result, assignment.context.task);
  if (intent.state === "applied") {
    /** Terminal report retained by the completed logical operation. */
    const report = parseReport(intent.result);
    if (report.resultDigest !== result.digest)
      throw new Error(
        "Completed harness assignment was submitted with a different result",
      );
    await releaseAssignment(
      input.provider,
      (await activeAssignmentPromotion(input.provider, assignment.promotion)) ??
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
  /** Live authority currently owned by this logical assignment. */
  let effectivePromotion = await activeAssignmentPromotion(
    input.provider,
    assignment.promotion,
  );
  /** Whether this completion reacquired expired lease slots. */
  let recoveredAuthority = false;
  if (effectivePromotion === null) {
    /** Current Task used to distinguish safe recovery from stale work. */
    const currentTask = await input.provider.getTaskSnapshot(
      assignment.context.task.id,
    );
    /** A partially committed human request is replayable without reacquisition. */
    const partialHumanRequest =
      input.completion.humanResolution !== null &&
      definition.humanResolutionOutcomes.includes(result.outcome) &&
      (currentTask.version !== assignment.promotion.taskVersion ||
        currentTask.status !== assignment.promotion.taskStatus);
    if (!partialHumanRequest) {
      try {
        await assertTaskBasis(input.provider, assignment.promotion);
      } catch (error) {
        await input.provider.reconcileAgentActivity(
          assignment.promotion.targetAgentId,
          `${input.operationKey}:activity-expired-stale`,
        );
        throw error;
      }
      effectivePromotion = await recoverAssignmentPromotion(
        input.provider,
        assignment.promotion,
        input.operationKey,
        new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
      );
      recoveredAuthority = true;
    }
  }
  try {
    if (effectivePromotion === null)
      throw new Error("Assignment leases are not active");
    await verifyLiveAssignment({
      activated: target,
      activationRuntime: runtime,
      promotion: effectivePromotion,
      provider: input.provider,
    });
  } catch (error) {
    if (recoveredAuthority && effectivePromotion !== null)
      await releaseAssignment(
        input.provider,
        effectivePromotion,
        input.operationKey,
      );
    /** Current Task used only to recognize a partially committed human request. */
    const currentTask = await input.provider.getTaskSnapshot(
      assignment.context.task.id,
    );
    /** Whether a prior completion attempt already changed the assigned Task. */
    const taskChanged =
      currentTask.version !== assignment.promotion.taskVersion ||
      currentTask.status !== assignment.promotion.taskStatus;
    if (
      input.completion.humanResolution === null ||
      !definition.humanResolutionOutcomes.includes(result.outcome) ||
      !taskChanged
    )
      throw error;
  }
  /** Assignment with the current recovered or renewed lease identities. */
  const effectiveAssignment =
    effectivePromotion === null
      ? assignment
      : { ...assignment, promotion: effectivePromotion };
  /** Durable provider transition derived from the validated Agent result. */
  const transition = await applyOutcome(
    input.provider,
    effectiveAssignment,
    result,
    input.completion,
    taskUpdate,
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
    effectiveAssignment.promotion,
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
  taskUpdate: ManagerTaskUpdate,
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
    if (taskUpdate.planPublished && taskUpdate.questions.length === 0)
      throw new Error(
        "A blocking planning result must ask at least one human question",
      );
    return new OutcomeTransitionBroker(provider).apply({
      definition,
      expectedTaskStatus: assignment.promotion.taskStatus,
      expectedTaskVersion: assignment.promotion.taskVersion,
      kind: "human_resolution",
      outcome: result.outcome,
      resolution:
        taskUpdate.questions.length === 0
          ? completion.humanResolution
          : {
              ...completion.humanResolution,
              prompt: planningQuestionsPrompt(taskUpdate.questions),
            },
      ...(taskUpdate.update === undefined
        ? {}
        : { taskUpdate: taskUpdate.update }),
      taskId: assignment.context.task.id,
    });
  }
  if (taskUpdate.questions.length !== 0)
    throw new Error(
      "Planning questions require a declared human-resolution outcome",
    );
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
    ...(taskUpdate.update === undefined
      ? {}
      : { taskUpdate: taskUpdate.update }),
    taskId: assignment.context.task.id,
  });
}

/** Validates exact ordered harness attestations and returns effect identities. */
function validateEffectAttestations(
  result: AgentResult,
  attestations: readonly HarnessEffectAttestation[],
): readonly string[] {
  /** Proposed intents that must be performed by the external harness. */
  const externalIntents = result.proposedIntents
    .map((intent, intentIndex) => ({ intent, intentIndex }))
    .filter(({ intent }) => !MANAGER_TASK_INTENTS.has(intent.kind));
  if (attestations.length !== externalIntents.length)
    throw new Error(
      "Harness completion must attest every proposed external intent exactly once",
    );
  return externalIntents.map(({ intent, intentIndex }, attestationIndex) => {
    /** Attestation occupying the exact corresponding proposal position. */
    const attestation = attestations[attestationIndex];
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

/** Task mutation derived from manager-owned Agent intents. */
interface ManagerTaskUpdate {
  /** Whether the result published a Planner-owned plan. */
  readonly planPublished: boolean;
  /** Human questions emitted with the plan. */
  readonly questions: readonly string[];
  /** Optional body/property patch applied with the outcome route. */
  readonly update:
    | {
        readonly nextBody?: string;
        readonly nextProperties?: JsonObject;
      }
    | undefined;
}

/** Validates manager-owned intents and compiles their Task patch. */
function managerTaskUpdate(
  result: AgentResult,
  task: TaskSnapshot,
): ManagerTaskUpdate {
  let nextBody: string | undefined;
  let nextProperties: JsonObject | undefined;
  let planPublished = false;
  let questions: readonly string[] = [];
  for (const intent of result.proposedIntents) {
    if (intent.kind === "task.plan.publish") {
      if (planPublished)
        throw new Error("An Agent result can publish only one Task plan");
      const plan = parsePlanIntent(intent.payload);
      planPublished = true;
      questions = plan.questions;
      nextBody = upsertPlanSection(task.body, plan.planMarkdown);
    } else if (intent.kind === "task.github_link.record") {
      if (nextProperties !== undefined)
        throw new Error("An Agent result can record only one GitHub link");
      const url = parseGitHubLinkIntent(intent.payload);
      nextProperties = {
        ...task.properties,
        "GitHub Links": appendLine(
          typeof task.properties["GitHub Links"] === "string"
            ? task.properties["GitHub Links"]
            : "",
          url,
        ),
      };
    }
  }
  return {
    planPublished,
    questions,
    update:
      nextBody === undefined && nextProperties === undefined
        ? undefined
        : {
            ...(nextBody === undefined ? {} : { nextBody }),
            ...(nextProperties === undefined ? {} : { nextProperties }),
          },
  };
}

/** Parses the bounded plan and complete human-question batch. */
function parsePlanIntent(payload: JsonObject): {
  readonly planMarkdown: string;
  readonly questions: readonly string[];
} {
  exactKeys(payload, ["planMarkdown", "questions"], "Task plan intent");
  const planMarkdown = requiredString(
    payload.planMarkdown,
    "Task plan intent planMarkdown",
  ).trim();
  if (
    planMarkdown.length > 100_000 ||
    planMarkdown.includes(PLAN_SECTION.start) ||
    planMarkdown.includes(PLAN_SECTION.end)
  )
    throw new TypeError("Task plan intent planMarkdown is invalid");
  if (!Array.isArray(payload.questions) || payload.questions.length > 20)
    throw new TypeError("Task plan intent questions are invalid");
  const questions = payload.questions.map((question, index) => {
    const parsed = requiredString(
      question,
      `Task plan intent question ${index}`,
    ).trim();
    if (parsed.length > 2_000)
      throw new TypeError(`Task plan intent question ${index} is too long`);
    return parsed;
  });
  if (new Set(questions).size !== questions.length)
    throw new TypeError("Task plan intent questions contain duplicates");
  return { planMarkdown, questions };
}

/** Parses one canonical GitHub pull-request URL. */
function parseGitHubLinkIntent(payload: JsonObject): string {
  exactKeys(payload, ["url"], "Task GitHub link intent");
  const value = requiredString(payload.url, "Task GitHub link intent url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Task GitHub link intent url is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname.toLowerCase() !== "github.com" ||
    !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/u.test(url.pathname) ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new TypeError("Task GitHub link intent url is invalid");
  return url.toString().replace(/\/$/u, "");
}

/** Replaces or appends the single manager-owned plan section. */
function upsertPlanSection(body: string, planMarkdown: string): string {
  const section = `${PLAN_SECTION.start}\n## Plan\n\n${planMarkdown}\n${PLAN_SECTION.end}`;
  const start = body.indexOf(PLAN_SECTION.start);
  const end = body.indexOf(PLAN_SECTION.end);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start))
    throw new Error("Task body contains an invalid managed plan section");
  if (start === -1) return `${body.trimEnd()}\n\n${section}\n`;
  const after = end + PLAN_SECTION.end.length;
  return `${body.slice(0, start)}${section}${body.slice(after)}`;
}

/** Appends one newline-delimited value without duplicating an existing entry. */
function appendLine(existing: string, value: string): string {
  const values = existing
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (!values.includes(value)) values.push(value);
  return values.join("\n");
}

/** Renders all Planner questions into one human-facing request. */
function planningQuestionsPrompt(questions: readonly string[]): string {
  return `Please answer all planning questions in one response:\n\n${questions
    .map((question, index) => `${index + 1}. ${question}`)
    .join("\n")}`;
}

/** Active leases currently owned by one logical harness assignment. */
interface OwnedAssignmentLeases {
  /** Active run lease owned by the assignment, when present. */
  readonly run: LeaseSnapshot | null;
  /** Active Task lease owned by the assignment, when present. */
  readonly task: LeaseSnapshot | null;
}

/** Finds active lease slots belonging to the exact assignment owner and Task. */
async function ownedAssignmentLeases(
  provider: AgentTaskProvider,
  promotion: AssignmentPromotion,
): Promise<OwnedAssignmentLeases> {
  /** Provider projection excluding released and expired leases. */
  const projection = await provider.getLeaseProjection(promotion.targetAgentId);
  /** Active lease snapshots named by the authoritative projection. */
  const snapshots = await Promise.all(
    [...projection.runLeaseIds, ...projection.taskLeaseIds].map((leaseId) =>
      provider.getLeaseSnapshot(leaseId),
    ),
  );
  if (snapshots.some((lease) => lease === null))
    throw new Error("Assignment lease projection changed during inspection");
  /** Matching run leases for the exact assignment owner. */
  const runs = (snapshots as LeaseSnapshot[]).filter(
    (lease) =>
      !lease.released &&
      lease.scope === "agent_run" &&
      lease.agentId === promotion.targetAgentId &&
      lease.ownerId === promotion.ownerId,
  );
  /** Matching Task leases for the exact assignment owner and Task. */
  const tasks = (snapshots as LeaseSnapshot[]).filter(
    (lease) =>
      !lease.released &&
      lease.scope === "task_assignment" &&
      lease.agentId === promotion.targetAgentId &&
      lease.ownerId === promotion.ownerId &&
      lease.taskId === promotion.taskId,
  );
  if (runs.length > 1 || tasks.length > 1)
    throw new Error("Harness assignment owns duplicate active leases");
  return { run: runs[0] ?? null, task: tasks[0] ?? null };
}

/** Returns the assignment promotion rewritten to its current active lease IDs. */
async function activeAssignmentPromotion(
  provider: AgentTaskProvider,
  promotion: AssignmentPromotion,
): Promise<AssignmentPromotion | null> {
  /** Active lease pair belonging to this logical assignment. */
  const leases = await ownedAssignmentLeases(provider, promotion);
  if (leases.run === null || leases.task === null) return null;
  return {
    ...promotion,
    runLeaseId: leases.run.leaseId,
    taskLeaseId: leases.task.leaseId,
  };
}

/** Reacquires missing assignment slots without weakening Task or owner identity. */
async function recoverAssignmentPromotion(
  provider: AgentTaskProvider,
  promotion: AssignmentPromotion,
  operationKey: string,
  requestedExpiresAt: string,
): Promise<AssignmentPromotion> {
  assertFutureLeaseExpiry(requestedExpiresAt);
  /** Any still-active half of a previously interrupted recovery. */
  const existing = await ownedAssignmentLeases(provider, promotion);
  /** One shared expiry, preserving an already-acquired half across retries. */
  const acquisitionExpiry =
    existing.run?.expiresAt ?? existing.task?.expiresAt ?? requestedExpiresAt;
  /** Stable suffix binding recovery acquisition to its canonical expiry. */
  const recoveryKey = `${operationKey}:lease-recovery:${sha256(acquisitionExpiry)}`;
  /** Run lease reused from partial recovery or acquired for this attempt. */
  let runLeaseId = existing.run?.leaseId ?? null;
  if (runLeaseId === null) {
    /** Provider decision for the assignment's exact run slot. */
    const run = await provider.acquireLease({
      expiresAt: acquisitionExpiry,
      idempotencyKey: `${recoveryKey}:run`,
      ownerId: promotion.ownerId,
      scope: "agent_run",
      agentId: promotion.targetAgentId,
      taskId: null,
    });
    if (!run.acquired || run.leaseId === null)
      throw new Error(
        `Assignment run lease recovery conflicts with ${run.conflictingLeaseId ?? "an unknown lease"}`,
      );
    runLeaseId = run.leaseId;
  }
  /** Task lease reused from partial recovery or acquired for this attempt. */
  let taskLeaseId = existing.task?.leaseId ?? null;
  if (taskLeaseId === null) {
    /** Provider decision for the assignment's exact Task slot. */
    const task = await provider.acquireLease({
      expiresAt: acquisitionExpiry,
      idempotencyKey: `${recoveryKey}:task`,
      ownerId: promotion.ownerId,
      scope: "task_assignment",
      agentId: promotion.targetAgentId,
      taskId: promotion.taskId,
    });
    if (!task.acquired || task.leaseId === null) {
      await releaseLease(provider, runLeaseId, promotion.ownerId);
      await provider.reconcileAgentActivity(
        promotion.targetAgentId,
        `${recoveryKey}:activity-compensate`,
      );
      throw new Error(
        `Assignment Task lease recovery conflicts with ${task.conflictingLeaseId ?? "an unknown lease"}`,
      );
    }
    taskLeaseId = task.leaseId;
  }
  await provider.reconcileAgentActivity(
    promotion.targetAgentId,
    `${recoveryKey}:activity`,
  );
  /** Promotion rewritten to the recovered live lease identities. */
  const recovered = await extendAssignmentPromotion(
    provider,
    { ...promotion, runLeaseId, taskLeaseId },
    operationKey,
    requestedExpiresAt,
  );
  await rebindAssignmentPromotion(provider, recovered);
  return recovered;
}

/** Convergently extends both active assignment leases to one requested expiry. */
async function extendAssignmentPromotion(
  provider: AgentTaskProvider,
  promotion: AssignmentPromotion,
  operationKey: string,
  nextExpiresAt: string,
): Promise<AssignmentPromotion> {
  assertFutureLeaseExpiry(nextExpiresAt);
  for (const leaseId of [promotion.runLeaseId, promotion.taskLeaseId]) {
    /** Current lease version and expiry used as the renewal CAS basis. */
    const lease = await provider.getLeaseSnapshot(leaseId);
    if (lease === null || lease.released || lease.ownerId !== promotion.ownerId)
      throw new Error(`Assignment lease ${leaseId} is not renewable`);
    if (lease.expiresAt === nextExpiresAt) continue;
    if (Date.parse(lease.expiresAt) > Date.parse(nextExpiresAt)) continue;
    /** Idempotent provider renewal preserving the current lease identifier. */
    const renewed = await provider.renewLease({
      expectedExpiresAt: lease.expiresAt,
      idempotencyKey: `${operationKey}:lease-renew:${leaseId}:${sha256(`${lease.expiresAt}\0${nextExpiresAt}`)}`,
      leaseId,
      nextExpiresAt,
      ownerId: promotion.ownerId,
    });
    if (!renewed.acquired || renewed.leaseId !== leaseId)
      throw new Error(`Assignment lease ${leaseId} could not be renewed`);
  }
  return promotion;
}

/** Rejects recovery when the assigned Task no longer matches its frozen basis. */
async function assertTaskBasis(
  provider: AgentTaskProvider,
  promotion: AssignmentPromotion,
): Promise<void> {
  /** Current Task snapshot compared before any expired authority is reacquired. */
  const task = await provider.getTaskSnapshot(promotion.taskId);
  if (
    task.archived ||
    task.version !== promotion.taskVersion ||
    task.status !== promotion.taskStatus
  )
    throw new Error("Assigned Task changed after selection");
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
  assertFutureLeaseExpiry(request.expiresAt);
  jsonObject(request.input, "Harness input");
}

/** Requires one canonical UTC timestamp strictly after the local clock. */
function assertFutureLeaseExpiry(value: string): void {
  /** Parsed canonical expiry compared with the local harness clock. */
  const expiresAt = Date.parse(value);
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== value ||
    expiresAt <= Date.now()
  )
    throw new TypeError(
      "Lease expiry must be a canonical future UTC timestamp",
    );
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
