/** Validates typed selections and promotes them into provider-backed worker leases. */
import { digestJson, sha256 } from "./digest.js";
import {
  assertSelectionAuthority,
  parseTaskSelectionResult,
  type TaskSelectionResult,
} from "./selection-result.js";
import {
  finalizeCandidateSet,
  taskQueryForDefinition,
  type CandidateSet,
} from "./task-query-contract.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../domain/json.js";
import type {
  LeaseProjection,
  ResourceMutation,
  AgentActivity,
  AgentDefinition,
  TaskSnapshot,
} from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { ResolvedDefinition } from "./definition-resolver.js";
import {
  activateDefinitions,
  type ActivatedDefinition,
} from "./definition-activation.js";

/** Canonical fields for activation runtime. */
export interface ActivationRuntime {
  /** Installed capabilities included in activation runtime. */
  readonly installedCapabilities: readonly string[];
  /** Installed intents included in activation runtime. */
  readonly installedIntents: readonly string[];
  /** Installed runner profiles included in activation runtime. */
  readonly installedRunnerProfiles: readonly string[];
  /** Supported models included in activation runtime. */
  readonly supportedModels: Readonly<Record<string, readonly string[]>>;
}

/** Canonical fields for selection target. */
export interface SelectionTarget {
  /** SHA-256 digest of canonical activation content. */
  readonly activationDigest: string;
  /** Stable identifier for selection target. */
  readonly id: string;
  /** Revision for selection target. */
  readonly revision: number;
}

/** Digest-pinned context for selection. */
export interface SelectionContext {
  /** SHA-256 digest of canonical basis content. */
  readonly basisDigest: string;
  /** Digest-pinned candidate Tasks exposed to the selector. */
  readonly candidateSet: CandidateSet;
  /** SHA-256 digest of canonical selector definition content. */
  readonly selectorDefinitionDigest: string;
  /** Target catalog included in selection context. */
  readonly targetCatalog: readonly SelectionTarget[];
}

/** Canonical fields for assignment promotion. */
export interface AssignmentPromotion {
  /** SHA-256 digest of canonical operation content. */
  readonly operationDigest: string;
  /** Stable identifier for owner. */
  readonly ownerId: string;
  /** Stable identifier for run lease. */
  readonly runLeaseId: string;
  /** SHA-256 digest of canonical selection basis content. */
  readonly selectionBasisDigest: string;
  /** Stable identifier for target agent. */
  readonly targetAgentId: string;
  /** Stable identifier for task. */
  readonly taskId: string;
  /** Stable identifier for task lease. */
  readonly taskLeaseId: string;
  /** Task status for assignment promotion. */
  readonly taskStatus: string;
  /** Version token expected for task. */
  readonly taskVersion: string;
}

/** Canonical fields for explicit assignment core. */
export interface ExplicitAssignmentCore {
  /** Stable identifier for authority. */
  readonly authorityId: string;
  /** Key that identifies retries of the same logical operation. */
  readonly idempotencyKey: string;
  /** Schema discriminator for the serialized representation. */
  readonly schema: "explicit-assignment-v1";
  /** SHA-256 digest of canonical selection basis content. */
  readonly selectionBasisDigest: string;
  /** Stable identifier for target agent. */
  readonly targetAgentId: string;
  /** Target agent revision for explicit assignment core. */
  readonly targetAgentRevision: number;
  /** Stable identifier for task. */
  readonly taskId: string;
}

/** Canonical fields for explicit assignment. */
export interface ExplicitAssignment extends ExplicitAssignmentCore {
  /** SHA-256 digest of the explicit assignment fields. */
  readonly digest: string;
}

/** Attaches a canonical digest to an explicit assignment request. */
export function finalizeExplicitAssignment(
  core: ExplicitAssignmentCore,
): ExplicitAssignment {
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

/** Confirms that a recorded assignment promotion matches provider state. */
export async function verifyAssignmentPromotion(
  provider: AgentTaskProvider,
  promotion: AssignmentPromotion,
): Promise<void> {
  /** Resource loaded during verify assignment promotion. */
  const resource = await provider.getOptionalResource(
    `assignment-intent/${promotion.operationDigest}`,
  );
  if (
    resource === null ||
    resource.kind !== "system/assignment-intent" ||
    resource.state !== "active" ||
    resource.version !== "v1" ||
    resource.digest !== sha256(resource.body)
  ) {
    throw new Error("Assignment promotion Resource is missing or invalid");
  }
  /** JSON-decoded input before structural validation. */
  const parsed: unknown = JSON.parse(resource.body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Assignment promotion receipt is malformed");
  /** Object currently undergoing field-level validation. */
  const value = parsed as Record<string, unknown>;
  /** Promotion fields expected from the persisted operation. */
  const expected = {
    operationDigest: promotion.operationDigest,
    ownerId: promotion.ownerId,
    runLeaseId: promotion.runLeaseId,
    schema: "assignment-intent-v1",
    selectionBasisDigest: promotion.selectionBasisDigest,
    state: "complete",
    targetAgentId: promotion.targetAgentId,
    taskId: promotion.taskId,
    taskLeaseId: promotion.taskLeaseId,
    taskStatus: promotion.taskStatus,
    taskVersion: promotion.taskVersion,
  };
  if (
    Object.keys(value).sort().join("\0") !==
    Object.keys(expected).sort().join("\0")
  )
    throw new Error("Assignment promotion receipt has unexpected fields");
  for (const [key, expectedValue] of Object.entries(expected))
    if (value[key] !== expectedValue)
      throw new Error(
        "Assignment promotion receipt does not match the dispatch",
      );
}

/** Parses an explicit assignment and verifies its canonical digest. */
export function parseExplicitAssignment(value: JsonValue): ExplicitAssignment {
  /** Object used during parse explicit assignment. */
  const object = objectValue(value, "Explicit assignment");
  /** Keys used during parse explicit assignment. */
  const keys = [
    "authorityId",
    "digest",
    "idempotencyKey",
    "schema",
    "selectionBasisDigest",
    "targetAgentId",
    "targetAgentRevision",
    "taskId",
  ];
  if (Object.keys(object).sort().join("\0") !== keys.sort().join("\0"))
    throw new TypeError("Explicit assignment has unexpected or missing fields");
  if (object.schema !== "explicit-assignment-v1")
    throw new TypeError("Explicit assignment schema is invalid");
  if (
    !Number.isSafeInteger(object.targetAgentRevision) ||
    (object.targetAgentRevision as number) < 1
  )
    throw new TypeError("Explicit assignment revision is invalid");
  /** Parsed used during parse explicit assignment. */
  const parsed = object as unknown as ExplicitAssignment;
  /** Digest and core used during parse explicit assignment. */
  const { digest: _digest, ...core } = parsed;
  if (finalizeExplicitAssignment(core).digest !== parsed.digest)
    throw new TypeError("Explicit assignment digest is invalid");
  for (const key of [
    "authorityId",
    "digest",
    "idempotencyKey",
    "selectionBasisDigest",
    "targetAgentId",
    "taskId",
  ] as const)
    requiredString(parsed[key], key);
  return structuredClone(parsed);
}

/** Builds digest-pinned candidate and target context for a selector. */
export async function prepareSelection(
  provider: AgentTaskProvider,
  resolved: ResolvedDefinition,
  activatedDefinitions: readonly ActivatedDefinition[],
): Promise<SelectionContext> {
  /** Summaries loaded during prepare selection. */
  const summaries =
    resolved.taskQuery === null
      ? []
      : await provider.listTaskSummaries(
          taskQueryForDefinition(resolved.taskQuery, resolved.definition),
        );
  /** Bounded, digest-pinned Task summaries exposed to selection. */
  const candidateSet =
    resolved.taskQuery === null
      ? finalizeCandidateSet(
          {
            dependencySatisfiedStatuses: [],
            limit: 1,
            predicate: {},
            schema: "task-query-v1",
          },
          [],
        )
      : finalizeCandidateSet(resolved.taskQuery, summaries);
  /** Target catalog arranged in deterministic order. */
  const targetCatalog = activatedDefinitions
    .filter(({ resolved: target }) =>
      target.definition.selection.acceptsAssignmentsFrom.includes(
        resolved.definition.selection.mode,
      ),
    )
    .map(({ digest, resolved: target }) => ({
      activationDigest: digest,
      id: target.definition.id,
      revision: target.definition.revision,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    resolved.definition.selection.mode === "self" &&
    !targetCatalog.some((target) => target.id === resolved.definition.id)
  ) {
    throw new Error(
      "Self selector is absent from the activated target catalog",
    );
  }
  /** Canonical digest of basis. */
  const basisDigest = digestJson(
    toJsonValue({
      candidateSetDigest: candidateSet.digest,
      mode: resolved.definition.selection.mode,
      selectorDefinitionDigest: resolved.digest,
      targetCatalog,
    }),
  );
  return {
    basisDigest,
    candidateSet,
    selectorDefinitionDigest: resolved.digest,
    targetCatalog,
  };
}

/** Validates and promotes a selector result into provider-backed leases. */
export async function promoteSelection(input: {
  /** Assignment depth for promote selection input. */
  readonly assignmentDepth: number;
  /** Activation runtime for promote selection input. */
  readonly activationRuntime: ActivationRuntime;
  /** Timestamp at which the lease expires. */
  readonly expiresAt: string;
  /** Stable identifier for owner. */
  readonly ownerId: string;
  /** Provider for promote selection input. */
  readonly provider: AgentTaskProvider;
  /** Resolved selector for promote selection input. */
  readonly resolvedSelector: ResolvedDefinition;
  /** Result for promote selection input. */
  readonly result: TaskSelectionResult;
  /** Selection context for promote selection input. */
  readonly selectionContext: SelectionContext;
  /** Stable identifier for selector run lease. */
  readonly selectorRunLeaseId: string;
}): Promise<AssignmentPromotion | null> {
  if (!Number.isSafeInteger(input.assignmentDepth) || input.assignmentDepth < 0)
    throw new Error("Selection assignment depth is invalid");
  /** Result produced by promote selection. */
  const result = parseTaskSelectionResult(toJsonValue(input.result));
  /** Activated loaded during promote selection. */
  const activated = await activateDefinitions({
    ...input.activationRuntime,
    provider: input.provider,
  });
  /** Active selector used during promote selection. */
  const activeSelector = requiredActivated(
    activated,
    input.resolvedSelector.definition.id,
  );
  if (activeSelector.resolved.digest !== input.resolvedSelector.digest)
    throw new Error(
      "Selector definition or Resources changed after preparation",
    );
  /** Selector used during promote selection. */
  const selector = activeSelector.resolved.definition;
  /** Fresh context loaded during promote selection. */
  const freshContext = await prepareSelection(
    input.provider,
    activeSelector.resolved,
    activated,
  );
  if (
    freshContext.basisDigest !== input.selectionContext.basisDigest ||
    freshContext.candidateSet.digest !==
      input.selectionContext.candidateSet.digest
  ) {
    throw new Error("Selection basis changed after preparation");
  }
  if (
    input.selectionContext.selectorDefinitionDigest !==
    input.resolvedSelector.digest
  )
    throw new Error("Selection context selector digest is invalid");
  if (input.assignmentDepth > selector.maxAssignmentDepth)
    throw new Error("Selection exceeds the definition assignment-depth limit");
  if (
    result.selectionBasisDigest !== input.selectionContext.basisDigest ||
    result.candidateSetDigest !== input.selectionContext.candidateSet.digest
  ) {
    throw new Error(
      "Selection result does not match its immutable candidate basis",
    );
  }
  if (result.selectorRunId !== input.ownerId)
    throw new Error("Selection result does not match the active run owner");
  /** Selector projection loaded during promote selection. */
  const selectorProjection = await input.provider.getLeaseProjection(
    selector.id,
  );
  if (!selectorProjection.runLeaseIds.includes(input.selectorRunLeaseId))
    throw new Error("Selector run lease is not active");
  if (result.outcome === "no_work") {
    assertSelectionAuthority(result, selector, null);
    await releaseAndProjectSelector(
      input.provider,
      selector.id,
      input.selectorRunLeaseId,
      input.ownerId,
      result.digest,
    );
    return null;
  }

  /** Target ID used during promote selection. */
  const targetId = requiredString(result.targetAgentId, "Selection target");
  /** Active target used during promote selection. */
  const activeTarget = requiredActivated(activated, targetId);
  /** Target catalog entry used during promote selection. */
  const targetCatalogEntry = input.selectionContext.targetCatalog.find(
    (entry) => entry.id === targetId,
  );
  if (
    targetCatalogEntry === undefined ||
    targetCatalogEntry.activationDigest !== activeTarget.digest ||
    targetCatalogEntry.revision !== activeTarget.resolved.definition.revision
  ) {
    throw new Error("Selection target is outside the activated target catalog");
  }
  /** Target used during promote selection. */
  const target = activeTarget.resolved.definition;
  assertSelectionAuthority(result, selector, target);
  if (input.assignmentDepth > target.maxAssignmentDepth)
    throw new Error("Selection exceeds the target assignment-depth limit");
  /** Task ID used during promote selection. */
  const taskId = requiredString(result.taskId, "Selected Task");
  /** Candidate summary matching the selected Task, when present. */
  const candidate = input.selectionContext.candidateSet.summaries.find(
    (summary) => summary.id === taskId,
  );
  if (selector.selection.taskQueryResource !== null && candidate === undefined)
    throw new Error("Selected Task is outside the bounded candidate set");
  /** Task loaded during promote selection. */
  const task = await input.provider.getTaskSnapshot(taskId);
  verifyTaskCandidate(task, candidate);
  await verifyDependencies(
    input.provider,
    task,
    activeSelector.resolved.taskQuery?.dependencySatisfiedStatuses ?? [],
  );
  if (result.mode === "self" && target.id !== selector.id)
    throw new Error("Self selection cannot promote another definition");
  await reserveAssignmentBudget(
    input.provider,
    selector,
    input.selectorRunLeaseId,
    result.digest,
  );
  /** Promotion loaded during promote selection. */
  const promotion = await acquireAndProject({
    existingRunLeaseId:
      result.mode === "self" ? input.selectorRunLeaseId : null,
    expiresAt: input.expiresAt,
    operationDigest: result.digest,
    ownerId: input.ownerId,
    provider: input.provider,
    selectionBasisDigest: input.selectionContext.basisDigest,
    target,
    taskId,
    taskStatus: task.status,
    taskVersion: task.version,
  });
  if (result.mode !== "self")
    await releaseAndProjectSelector(
      input.provider,
      selector.id,
      input.selectorRunLeaseId,
      input.ownerId,
      result.digest,
    );
  return promotion;
}

/** Validates and promotes an explicit assignment into provider-backed leases. */
export async function promoteExplicitAssignment(input: {
  /** Assignment for promote explicit assignment input. */
  readonly assignment: ExplicitAssignment;
  /** Assignment depth for promote explicit assignment input. */
  readonly assignmentDepth: number;
  /** Activation runtime for promote explicit assignment input. */
  readonly activationRuntime: ActivationRuntime;
  /** Timestamp at which the lease expires. */
  readonly expiresAt: string;
  /** Stable identifier for owner. */
  readonly ownerId: string;
  /** Provider for promote explicit assignment input. */
  readonly provider: AgentTaskProvider;
  /** Resolved target for promote explicit assignment input. */
  readonly resolvedTarget: ResolvedDefinition;
  /** Selection context for promote explicit assignment input. */
  readonly selectionContext: SelectionContext;
}): Promise<AssignmentPromotion> {
  /** Parsed used during promote explicit assignment. */
  const parsed = parseExplicitAssignment(toJsonValue(input.assignment));
  if (!Number.isSafeInteger(input.assignmentDepth) || input.assignmentDepth < 0)
    throw new Error("Explicit assignment depth is invalid");
  /** Activated loaded during promote explicit assignment. */
  const activated = await activateDefinitions({
    ...input.activationRuntime,
    definitionIds: [input.resolvedTarget.definition.id],
    provider: input.provider,
  });
  /** Active target used during promote explicit assignment. */
  const activeTarget = requiredActivated(
    activated,
    input.resolvedTarget.definition.id,
  );
  if (activeTarget.resolved.digest !== input.resolvedTarget.digest)
    throw new Error(
      "Explicit target definition or Resources changed after preparation",
    );
  /** Fresh context loaded during promote explicit assignment. */
  const freshContext = await prepareSelection(
    input.provider,
    activeTarget.resolved,
    activated,
  );
  if (
    freshContext.basisDigest !== input.selectionContext.basisDigest ||
    freshContext.candidateSet.digest !==
      input.selectionContext.candidateSet.digest
  ) {
    throw new Error("Explicit assignment basis changed after preparation");
  }
  /** Target used during promote explicit assignment. */
  const target = activeTarget.resolved.definition;
  if (parsed.authorityId !== input.ownerId)
    throw new Error("Explicit assignment does not match its trusted authority");
  if (parsed.selectionBasisDigest !== input.selectionContext.basisDigest)
    throw new Error(
      "Explicit assignment does not match its immutable candidate basis",
    );
  if (
    parsed.targetAgentId !== target.id ||
    parsed.targetAgentRevision !== target.revision
  )
    throw new Error("Explicit assignment target revision changed");
  if (
    !target.enabled ||
    !target.selection.acceptsAssignmentsFrom.includes("explicit")
  )
    throw new Error("Target does not accept explicit assignments");
  if (input.assignmentDepth > target.maxAssignmentDepth)
    throw new Error(
      "Explicit assignment exceeds the target assignment-depth limit",
    );
  /** Candidate summary matching the selected Task, when present. */
  const candidate = input.selectionContext.candidateSet.summaries.find(
    (summary) => summary.id === parsed.taskId,
  );
  if (target.selection.taskQueryResource !== null && candidate === undefined)
    throw new Error("Explicit Task is outside the target candidate scope");
  /** Task loaded during promote explicit assignment. */
  const task = await input.provider.getTaskSnapshot(parsed.taskId);
  verifyTaskCandidate(task, candidate);
  await verifyDependencies(
    input.provider,
    task,
    activeTarget.resolved.taskQuery?.dependencySatisfiedStatuses ?? [],
  );
  await reserveAssignmentBudget(
    input.provider,
    target,
    input.ownerId,
    parsed.digest,
  );
  return acquireAndProject({
    existingRunLeaseId: null,
    expiresAt: input.expiresAt,
    operationDigest: parsed.digest,
    ownerId: input.ownerId,
    provider: input.provider,
    selectionBasisDigest: input.selectionContext.basisDigest,
    target,
    taskId: parsed.taskId,
    taskStatus: task.status,
    taskVersion: task.version,
  });
}

/** Acquires assignment leases and synchronizes their provider projections. */
async function acquireAndProject(input: {
  /** Stable identifier for existing run lease. */
  readonly existingRunLeaseId: string | null;
  /** Timestamp at which the lease expires. */
  readonly expiresAt: string;
  /** SHA-256 digest of canonical operation content. */
  readonly operationDigest: string;
  /** Stable identifier for owner. */
  readonly ownerId: string;
  /** Provider for acquire and project input. */
  readonly provider: AgentTaskProvider;
  /** SHA-256 digest of canonical selection basis content. */
  readonly selectionBasisDigest: string;
  /** Target for acquire and project input. */
  readonly target: AgentDefinition;
  /** Stable identifier for task. */
  readonly taskId: string;
  /** Task status for acquire and project input. */
  readonly taskStatus: string;
  /** Version token expected for task. */
  readonly taskVersion: string;
}): Promise<AssignmentPromotion> {
  /** Intent key used during acquire and project. */
  const intentKey = `assignment-intent/${input.operationDigest}`;
  /** Prior intent loaded during acquire and project. */
  const priorIntent = await readAssignmentIntent(
    input.provider,
    intentKey,
    input,
  );
  if (priorIntent?.state === "complete") {
    if (priorIntent.runLeaseId === null || priorIntent.taskLeaseId === null)
      throw new Error(
        "Completed assignment intent is missing lease identities",
      );
    return {
      operationDigest: input.operationDigest,
      ownerId: input.ownerId,
      runLeaseId: priorIntent.runLeaseId,
      selectionBasisDigest: input.selectionBasisDigest,
      targetAgentId: input.target.id,
      taskId: input.taskId,
      taskLeaseId: priorIntent.taskLeaseId,
      taskStatus: input.taskStatus,
      taskVersion: input.taskVersion,
    };
  }
  await writeAssignmentIntent(
    input.provider,
    intentKey,
    input,
    priorIntent ?? {
      runLeaseId: input.existingRunLeaseId,
      state: "prepared",
      taskLeaseId: null,
    },
  );
  /** Before projection loaded during acquire and project. */
  const beforeProjection = await input.provider.getLeaseProjection(
    input.target.id,
  );
  /** Before activity loaded during acquire and project. */
  const beforeActivity = await input.provider.getAgentActivity(input.target.id);
  verifyActivity(beforeActivity, beforeProjection);
  /** Run lease ID used during acquire and project. */
  let runLeaseId = input.existingRunLeaseId;
  if (runLeaseId === null) {
    /** Run lease loaded during acquire and project. */
    const runLease = await input.provider.acquireLease({
      expiresAt: input.expiresAt,
      idempotencyKey: `selection:${input.operationDigest}:run`,
      ownerId: input.ownerId,
      scope: "agent_run",
      agentId: input.target.id,
      taskId: null,
    });
    if (!runLease.acquired || runLease.leaseId === null) {
      throw new Error(
        `Target run lease conflicts with ${runLease.conflictingLeaseId ?? "an unknown lease"}`,
      );
    }
    runLeaseId = runLease.leaseId;
    await writeAssignmentIntent(input.provider, intentKey, input, {
      runLeaseId,
      state: "run_acquired",
      taskLeaseId: null,
    });
  }
  /** Task lease loaded during acquire and project. */
  const taskLease = await input.provider.acquireLease({
    expiresAt: input.expiresAt,
    idempotencyKey: `selection:${input.operationDigest}:task`,
    ownerId: input.ownerId,
    scope: "task_assignment",
    agentId: input.target.id,
    taskId: input.taskId,
  });
  if (!taskLease.acquired || taskLease.leaseId === null) {
    if (input.existingRunLeaseId === null)
      await input.provider.releaseLease({
        expectedVersion: null,
        leaseId: runLeaseId,
        ownerId: input.ownerId,
      });
    await writeAssignmentIntent(input.provider, intentKey, input, {
      runLeaseId: null,
      state: "compensated",
      taskLeaseId: null,
    });
    throw new Error(
      `Selected Task lease conflicts with ${taskLease.conflictingLeaseId ?? "an unknown lease"}`,
    );
  }
  await writeAssignmentIntent(input.provider, intentKey, input, {
    runLeaseId,
    state: "task_acquired",
    taskLeaseId: taskLease.leaseId,
  });
  /** After projection loaded during acquire and project. */
  const afterProjection = await input.provider.getLeaseProjection(
    input.target.id,
  );
  if (!afterProjection.runLeaseIds.includes(runLeaseId))
    throw new Error("Target run lease is not active");
  if (afterProjection.runLeaseIds.length > input.target.maxConcurrency) {
    if (input.existingRunLeaseId === null)
      await input.provider.releaseLease({
        expectedVersion: null,
        leaseId: runLeaseId,
        ownerId: input.ownerId,
      });
    await input.provider.releaseLease({
      expectedVersion: null,
      leaseId: taskLease.leaseId,
      ownerId: input.ownerId,
    });
    throw new Error("Selection exceeds target concurrency");
  }
  /** Current activity loaded during acquire and project. */
  const currentActivity = await input.provider.getAgentActivity(
    input.target.id,
  );
  if (!activityMatches(currentActivity, afterProjection)) {
    await input.provider.updateAgentActivity({
      expectedRunLeaseIds: beforeProjection.runLeaseIds,
      expectedTaskIds: beforeActivity.taskIds,
      idempotencyKey: `selection:${input.operationDigest}:activity`,
      nextRunLeaseIds: afterProjection.runLeaseIds,
      nextTaskIds: afterProjection.taskIds,
      agentId: input.target.id,
    });
  }
  if (
    !activityMatches(
      await input.provider.getAgentActivity(input.target.id),
      afterProjection,
    )
  )
    throw new Error("Selected Agent activity did not verify");
  await writeAssignmentIntent(input.provider, intentKey, input, {
    runLeaseId,
    state: "complete",
    taskLeaseId: taskLease.leaseId,
  });
  return {
    operationDigest: input.operationDigest,
    ownerId: input.ownerId,
    runLeaseId,
    selectionBasisDigest: input.selectionBasisDigest,
    targetAgentId: input.target.id,
    taskId: input.taskId,
    taskLeaseId: taskLease.leaseId,
    taskStatus: input.taskStatus,
    taskVersion: input.taskVersion,
  };
}

/** Allowed assignment intent state literals. */
type AssignmentIntentState =
  "compensated" | "complete" | "prepared" | "run_acquired" | "task_acquired";

/** Canonical fields for assignment intent progress. */
interface AssignmentIntentProgress {
  /** Stable identifier for run lease. */
  readonly runLeaseId: string | null;
  /** Current state of assignment intent progress. */
  readonly state: AssignmentIntentState;
  /** Stable identifier for task lease. */
  readonly taskLeaseId: string | null;
}

/** Reads and validates durable progress for an assignment operation. */
async function readAssignmentIntent(
  provider: AgentTaskProvider,
  key: string,
  input: {
    /** SHA-256 digest of canonical operation content. */
    readonly operationDigest: string;
    /** Stable identifier for owner. */
    readonly ownerId: string;
    /** SHA-256 digest of canonical selection basis content. */
    readonly selectionBasisDigest: string;
    /** Target for read assignment intent input. */
    readonly target: AgentDefinition;
    /** Stable identifier for task. */
    readonly taskId: string;
    /** Task status for read assignment intent input. */
    readonly taskStatus: string;
    /** Version token expected for task. */
    readonly taskVersion: string;
  },
): Promise<AssignmentIntentProgress | null> {
  /** Resource loaded during read assignment intent. */
  const resource = await provider.getOptionalResource(key);
  if (resource === null) return null;
  /** JSON-decoded input before structural validation. */
  const parsed: unknown = JSON.parse(resource.body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Assignment intent is malformed");
  /** Object currently undergoing field-level validation. */
  const value = parsed as Record<string, unknown>;
  if (
    value.schema !== "assignment-intent-v1" ||
    value.operationDigest !== input.operationDigest ||
    value.ownerId !== input.ownerId ||
    value.selectionBasisDigest !== input.selectionBasisDigest ||
    value.targetAgentId !== input.target.id ||
    value.taskId !== input.taskId ||
    value.taskStatus !== input.taskStatus ||
    value.taskVersion !== input.taskVersion
  ) {
    throw new Error(
      "Assignment intent identity conflicts with the requested promotion",
    );
  }
  if (
    !(
      [
        "compensated",
        "complete",
        "prepared",
        "run_acquired",
        "task_acquired",
      ] as const
    ).includes(value.state as AssignmentIntentState)
  ) {
    throw new Error("Assignment intent state is invalid");
  }
  if (
    (value.runLeaseId !== null && typeof value.runLeaseId !== "string") ||
    (value.taskLeaseId !== null && typeof value.taskLeaseId !== "string")
  ) {
    throw new Error("Assignment intent lease identity is invalid");
  }
  return {
    runLeaseId: value.runLeaseId as string | null,
    state: value.state as AssignmentIntentState,
    taskLeaseId: value.taskLeaseId as string | null,
  };
}

/** Persists assignment progress as an idempotent Resource mutation. */
async function writeAssignmentIntent(
  provider: AgentTaskProvider,
  key: string,
  input: {
    /** SHA-256 digest of canonical operation content. */
    readonly operationDigest: string;
    /** Stable identifier for owner. */
    readonly ownerId: string;
    /** SHA-256 digest of canonical selection basis content. */
    readonly selectionBasisDigest: string;
    /** Target for write assignment intent input. */
    readonly target: AgentDefinition;
    /** Stable identifier for task. */
    readonly taskId: string;
    /** Task status for write assignment intent input. */
    readonly taskStatus: string;
    /** Version token expected for task. */
    readonly taskVersion: string;
  },
  progress: AssignmentIntentProgress,
): Promise<void> {
  /** Body used during write assignment intent. */
  const body = JSON.stringify({
    operationDigest: input.operationDigest,
    ownerId: input.ownerId,
    runLeaseId: progress.runLeaseId,
    schema: "assignment-intent-v1",
    state: progress.state,
    selectionBasisDigest: input.selectionBasisDigest,
    targetAgentId: input.target.id,
    taskId: input.taskId,
    taskLeaseId: progress.taskLeaseId,
    taskStatus: input.taskStatus,
    taskVersion: input.taskVersion,
  });
  /** Canonical digest of record. */
  const record: ResourceMutation = {
    body,
    dependencies: [],
    digest: sha256(body),
    idempotencyKey: `${key}:${progress.state}:${sha256(body)}`,
    key,
    kind: "system/assignment-intent",
    state: "active",
    version: "v1",
  };
  await provider.putResource(record);
}

/** Atomically reserves one assignment slot in the run's durable budget. */
async function reserveAssignmentBudget(
  provider: AgentTaskProvider,
  definition: AgentDefinition,
  runIdentity: string,
  operationDigest: string,
): Promise<void> {
  /** Key used during reserve assignment budget. */
  const key = `assignment-budget/${definition.id}/${runIdentity}`;
  /** Prior loaded during reserve assignment budget. */
  const prior = await provider.getOptionalResource(key);
  /** Operations used during reserve assignment budget. */
  let operations: string[] = [];
  if (prior !== null) {
    /** JSON-decoded input before structural validation. */
    const parsed: unknown = JSON.parse(prior.body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Assignment budget is malformed");
    /** Object currently undergoing field-level validation. */
    const value = parsed as Record<string, unknown>;
    if (
      value.schema !== "assignment-budget-v1" ||
      value.agentId !== definition.id ||
      value.runIdentity !== runIdentity ||
      !Array.isArray(value.operationDigests) ||
      value.operationDigests.some((item) => typeof item !== "string")
    ) {
      throw new Error("Assignment budget identity is invalid");
    }
    operations = [...new Set(value.operationDigests as string[])];
  }
  if (!operations.includes(operationDigest)) operations.push(operationDigest);
  if (operations.length > definition.maxAssignmentsPerRun)
    throw new Error("Agent assignment budget is exhausted");
  operations.sort();
  /** Body used during reserve assignment budget. */
  const body = JSON.stringify({
    operationDigests: operations,
    runIdentity,
    schema: "assignment-budget-v1",
    agentId: definition.id,
  });
  await provider.putResource({
    body,
    dependencies: [],
    digest: sha256(body),
    idempotencyKey: `${key}:${sha256(body)}`,
    key,
    kind: "system/assignment-budget",
    state: "active",
    version: "v1",
  });
}

/** Confirms that a loaded Task still matches its selected candidate summary. */
function verifyTaskCandidate(
  task: TaskSnapshot,
  candidate: CandidateSet["summaries"][number] | undefined,
): void {
  if (task.archived) throw new Error("Selected Task is archived");
  if (
    candidate !== undefined &&
    (task.version !== candidate.version || task.status !== candidate.status)
  )
    throw new Error("Selected Task changed after candidate compilation");
}

/** Confirms that every Task dependency has an accepted status. */
async function verifyDependencies(
  provider: AgentTaskProvider,
  task: TaskSnapshot,
  satisfiedStatuses: readonly string[],
): Promise<void> {
  for (const dependencyId of task.dependencies) {
    /** Dependency loaded during verify dependencies. */
    const dependency = await provider.getTaskSnapshot(dependencyId);
    if (dependency.archived || !satisfiedStatuses.includes(dependency.status))
      throw new Error(
        `Selected Task has an unresolved dependency: ${dependencyId}`,
      );
  }
}

/** Releases the selector lease and synchronizes its activity projection. */
async function releaseAndProjectSelector(
  provider: AgentTaskProvider,
  agentId: string,
  leaseId: string,
  ownerId: string,
  operationDigest: string,
): Promise<void> {
  /** Before projection loaded during release and project selector. */
  const beforeProjection = await provider.getLeaseProjection(agentId);
  /** Before activity loaded during release and project selector. */
  const beforeActivity = await provider.getAgentActivity(agentId);
  verifyActivity(beforeActivity, beforeProjection);
  await provider.releaseLease({ expectedVersion: null, leaseId, ownerId });
  /** After projection loaded during release and project selector. */
  const afterProjection = await provider.getLeaseProjection(agentId);
  if (!activityMatches(beforeActivity, afterProjection)) {
    await provider.updateAgentActivity({
      expectedRunLeaseIds: beforeProjection.runLeaseIds,
      expectedTaskIds: beforeProjection.taskIds,
      idempotencyKey: `selection:${operationDigest}:selector-finalize`,
      nextRunLeaseIds: afterProjection.runLeaseIds,
      nextTaskIds: afterProjection.taskIds,
      agentId,
    });
  }
  verifyActivity(await provider.getAgentActivity(agentId), afterProjection);
}

/** Returns the single active definition matching an ID and revision. */
function requiredActivated(
  values: readonly ActivatedDefinition[],
  id: string,
): ActivatedDefinition {
  /** Matches satisfying the current constraints. */
  const matches = values.filter(
    ({ resolved }) => resolved.definition.id === id,
  );
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error(`Agent ${id} is not uniquely activated`);
  return matches[0];
}

/** Confirms that provider activity matches the expected lease projection. */
function verifyActivity(
  activity: AgentActivity,
  projection: LeaseProjection,
): void {
  if (!activityMatches(activity, projection))
    throw new Error("Agent activity does not match active leases");
}

/** Checks whether activity contains exactly the expected Tasks and online state. */
function activityMatches(
  activity: AgentActivity,
  projection: LeaseProjection,
): boolean {
  /** Expected status used for comparison. */
  const expectedStatus =
    projection.runLeaseIds.length === 0 ? "Offline" : "Online";
  return (
    activity.status === expectedStatus &&
    sameSet(activity.taskIds, projection.taskIds)
  );
}

/** Checks whether two string collections contain the same values. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    [...new Set(left)].sort().join("\0") ===
    [...new Set(right)].sort().join("\0")
  );
}

/** Requires a non-empty string field value. */
function requiredString(value: string | null, label: string): string {
  if (value === null || value === "")
    throw new TypeError(`${label} is missing`);
  return value;
}

/** Requires a field value to be a non-array JSON object. */
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new TypeError(`${label} must be an object`);
  return value;
}
