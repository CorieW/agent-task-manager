// Validates typed selections and promotes them into provider-backed worker leases.
import { digestJson, sha256 } from "./digest.js";
import { assertSelectionAuthority, parseTaskSelectionResult, type TaskSelectionResult } from "./selection-result.js";
import { finalizeCandidateSet, taskQueryForDefinition, type CandidateSet } from "./task-query-contract.js";
import { toJsonValue, type JsonObject, type JsonValue } from "../domain/json.js";
import type { LeaseProjection, ResourceMutation, SubAgentActivity, SubAgentDefinition, TaskSnapshot } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { ResolvedDefinition } from "./definition-resolver.js";
import { activateDefinitions, type ActivatedDefinition } from "./definition-activation.js";

export interface ActivationRuntime {
  readonly installedCapabilities: readonly string[];
  readonly installedIntents: readonly string[];
  readonly installedRunnerProfiles: readonly string[];
  readonly supportedModels: Readonly<Record<string, readonly string[]>>;
}

export interface SelectionTarget {
  readonly activationDigest: string;
  readonly id: string;
  readonly revision: number;
}

export interface SelectionContext {
  readonly basisDigest: string;
  readonly candidateSet: CandidateSet;
  readonly selectorDefinitionDigest: string;
  readonly targetCatalog: readonly SelectionTarget[];
}

export interface AssignmentPromotion {
  readonly operationDigest: string;
  readonly ownerId: string;
  readonly runLeaseId: string;
  readonly selectionBasisDigest: string;
  readonly targetSubAgentId: string;
  readonly taskId: string;
  readonly taskLeaseId: string;
  readonly taskStatus: string;
  readonly taskVersion: string;
}

export interface ExplicitAssignmentCore {
  readonly authorityId: string;
  readonly idempotencyKey: string;
  readonly schema: "explicit-assignment-v1";
  readonly selectionBasisDigest: string;
  readonly targetSubAgentId: string;
  readonly targetSubAgentRevision: number;
  readonly taskId: string;
}

export interface ExplicitAssignment extends ExplicitAssignmentCore {
  readonly digest: string;
}

export function finalizeExplicitAssignment(core: ExplicitAssignmentCore): ExplicitAssignment {
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

export async function verifyAssignmentPromotion(provider: AgentTaskProvider, promotion: AssignmentPromotion): Promise<void> {
  const resource = await provider.getOptionalResource(`assignment-intent/${promotion.operationDigest}`);
  if (resource === null || resource.kind !== "system/assignment-intent" || resource.state !== "active" || resource.version !== "v1" || resource.digest !== sha256(resource.body)) {
    throw new Error("Assignment promotion Resource is missing or invalid");
  }
  const parsed: unknown = JSON.parse(resource.body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Assignment promotion receipt is malformed");
  const value = parsed as Record<string, unknown>;
  const expected = {
    operationDigest: promotion.operationDigest, ownerId: promotion.ownerId, runLeaseId: promotion.runLeaseId,
    schema: "assignment-intent-v1", selectionBasisDigest: promotion.selectionBasisDigest, state: "complete",
    targetSubAgentId: promotion.targetSubAgentId, taskId: promotion.taskId, taskLeaseId: promotion.taskLeaseId,
    taskStatus: promotion.taskStatus, taskVersion: promotion.taskVersion,
  };
  if (Object.keys(value).sort().join("\0") !== Object.keys(expected).sort().join("\0")) throw new Error("Assignment promotion receipt has unexpected fields");
  for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) throw new Error("Assignment promotion receipt does not match the dispatch");
}

export function parseExplicitAssignment(value: JsonValue): ExplicitAssignment {
  const object = objectValue(value, "Explicit assignment");
  const keys = ["authorityId", "digest", "idempotencyKey", "schema", "selectionBasisDigest", "targetSubAgentId", "targetSubAgentRevision", "taskId"];
  if (Object.keys(object).sort().join("\0") !== keys.sort().join("\0")) throw new TypeError("Explicit assignment has unexpected or missing fields");
  if (object.schema !== "explicit-assignment-v1") throw new TypeError("Explicit assignment schema is invalid");
  if (!Number.isSafeInteger(object.targetSubAgentRevision) || (object.targetSubAgentRevision as number) < 1) throw new TypeError("Explicit assignment revision is invalid");
  const parsed = object as unknown as ExplicitAssignment;
  const { digest: _digest, ...core } = parsed;
  if (finalizeExplicitAssignment(core).digest !== parsed.digest) throw new TypeError("Explicit assignment digest is invalid");
  for (const key of ["authorityId", "digest", "idempotencyKey", "selectionBasisDigest", "targetSubAgentId", "taskId"] as const) requiredString(parsed[key], key);
  return structuredClone(parsed);
}

export async function prepareSelection(
  provider: AgentTaskProvider,
  resolved: ResolvedDefinition,
  activatedDefinitions: readonly ActivatedDefinition[],
): Promise<SelectionContext> {
  const summaries = resolved.taskQuery === null
    ? []
    : await provider.listTaskSummaries(taskQueryForDefinition(resolved.taskQuery, resolved.definition));
  const candidateSet = resolved.taskQuery === null
    ? finalizeCandidateSet({ dependencySatisfiedStatuses: [], limit: 1, predicate: {}, schema: "task-query-v1" }, [])
    : finalizeCandidateSet(resolved.taskQuery, summaries);
  const targetCatalog = activatedDefinitions
    .filter(({ resolved: target }) => target.definition.selection.acceptsAssignmentsFrom.includes(resolved.definition.selection.mode))
    .map(({ digest, resolved: target }) => ({ activationDigest: digest, id: target.definition.id, revision: target.definition.revision }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (resolved.definition.selection.mode === "self" && !targetCatalog.some((target) => target.id === resolved.definition.id)) {
    throw new Error("Self selector is absent from the activated target catalog");
  }
  const basisDigest = digestJson(toJsonValue({
    candidateSetDigest: candidateSet.digest,
    mode: resolved.definition.selection.mode,
    selectorDefinitionDigest: resolved.digest,
    targetCatalog,
  }));
  return { basisDigest, candidateSet, selectorDefinitionDigest: resolved.digest, targetCatalog };
}

export async function promoteSelection(input: {
  readonly assignmentDepth: number;
  readonly activationRuntime: ActivationRuntime;
  readonly expiresAt: string;
  readonly ownerId: string;
  readonly provider: AgentTaskProvider;
  readonly resolvedSelector: ResolvedDefinition;
  readonly result: TaskSelectionResult;
  readonly selectionContext: SelectionContext;
  readonly selectorRunLeaseId: string;
}): Promise<AssignmentPromotion | null> {
  if (!Number.isSafeInteger(input.assignmentDepth) || input.assignmentDepth < 0) throw new Error("Selection assignment depth is invalid");
  const result = parseTaskSelectionResult(toJsonValue(input.result));
  const activated = await activateDefinitions({ ...input.activationRuntime, provider: input.provider });
  const activeSelector = requiredActivated(activated, input.resolvedSelector.definition.id);
  if (activeSelector.resolved.digest !== input.resolvedSelector.digest) throw new Error("Selector definition or Resources changed after preparation");
  const selector = activeSelector.resolved.definition;
  const freshContext = await prepareSelection(input.provider, activeSelector.resolved, activated);
  if (freshContext.basisDigest !== input.selectionContext.basisDigest || freshContext.candidateSet.digest !== input.selectionContext.candidateSet.digest) {
    throw new Error("Selection basis changed after preparation");
  }
  if (input.selectionContext.selectorDefinitionDigest !== input.resolvedSelector.digest) throw new Error("Selection context selector digest is invalid");
  if (input.assignmentDepth > selector.maxAssignmentDepth) throw new Error("Selection exceeds the definition assignment-depth limit");
  if (result.selectionBasisDigest !== input.selectionContext.basisDigest || result.candidateSetDigest !== input.selectionContext.candidateSet.digest) {
    throw new Error("Selection result does not match its immutable candidate basis");
  }
  if (result.selectorRunId !== input.ownerId) throw new Error("Selection result does not match the active run owner");
  const selectorProjection = await input.provider.getLeaseProjection(selector.id);
  if (!selectorProjection.runLeaseIds.includes(input.selectorRunLeaseId)) throw new Error("Selector run lease is not active");
  if (result.outcome === "no_work") {
    assertSelectionAuthority(result, selector, null);
    await releaseAndProjectSelector(input.provider, selector.id, input.selectorRunLeaseId, input.ownerId, result.digest);
    return null;
  }

  const targetId = requiredString(result.targetSubAgentId, "Selection target");
  const activeTarget = requiredActivated(activated, targetId);
  const targetCatalogEntry = input.selectionContext.targetCatalog.find((entry) => entry.id === targetId);
  if (targetCatalogEntry === undefined || targetCatalogEntry.activationDigest !== activeTarget.digest || targetCatalogEntry.revision !== activeTarget.resolved.definition.revision) {
    throw new Error("Selection target is outside the activated target catalog");
  }
  const target = activeTarget.resolved.definition;
  assertSelectionAuthority(result, selector, target);
  if (input.assignmentDepth > target.maxAssignmentDepth) throw new Error("Selection exceeds the target assignment-depth limit");
  const taskId = requiredString(result.taskId, "Selected Task");
  const candidate = input.selectionContext.candidateSet.summaries.find((summary) => summary.id === taskId);
  if (selector.selection.taskQueryResource !== null && candidate === undefined) throw new Error("Selected Task is outside the bounded candidate set");
  const task = await input.provider.getTaskSnapshot(taskId);
  verifyTaskCandidate(task, candidate);
  await verifyDependencies(input.provider, task, activeSelector.resolved.taskQuery?.dependencySatisfiedStatuses ?? []);
  if (result.mode === "self" && target.id !== selector.id) throw new Error("Self selection cannot promote another definition");
  await reserveAssignmentBudget(input.provider, selector, input.selectorRunLeaseId, result.digest);
  const promotion = await acquireAndProject({
    existingRunLeaseId: result.mode === "self" ? input.selectorRunLeaseId : null,
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
  if (result.mode !== "self") await releaseAndProjectSelector(input.provider, selector.id, input.selectorRunLeaseId, input.ownerId, result.digest);
  return promotion;
}

export async function promoteExplicitAssignment(input: {
  readonly assignment: ExplicitAssignment;
  readonly assignmentDepth: number;
  readonly activationRuntime: ActivationRuntime;
  readonly expiresAt: string;
  readonly ownerId: string;
  readonly provider: AgentTaskProvider;
  readonly resolvedTarget: ResolvedDefinition;
  readonly selectionContext: SelectionContext;
}): Promise<AssignmentPromotion> {
  const parsed = parseExplicitAssignment(toJsonValue(input.assignment));
  if (!Number.isSafeInteger(input.assignmentDepth) || input.assignmentDepth < 0) throw new Error("Explicit assignment depth is invalid");
  const activated = await activateDefinitions({ ...input.activationRuntime, provider: input.provider });
  const activeTarget = requiredActivated(activated, input.resolvedTarget.definition.id);
  if (activeTarget.resolved.digest !== input.resolvedTarget.digest) throw new Error("Explicit target definition or Resources changed after preparation");
  const freshContext = await prepareSelection(input.provider, activeTarget.resolved, activated);
  if (freshContext.basisDigest !== input.selectionContext.basisDigest || freshContext.candidateSet.digest !== input.selectionContext.candidateSet.digest) {
    throw new Error("Explicit assignment basis changed after preparation");
  }
  const target = activeTarget.resolved.definition;
  if (parsed.authorityId !== input.ownerId) throw new Error("Explicit assignment does not match its trusted authority");
  if (parsed.selectionBasisDigest !== input.selectionContext.basisDigest) throw new Error("Explicit assignment does not match its immutable candidate basis");
  if (parsed.targetSubAgentId !== target.id || parsed.targetSubAgentRevision !== target.revision) throw new Error("Explicit assignment target revision changed");
  if (!target.enabled || !target.selection.acceptsAssignmentsFrom.includes("explicit")) throw new Error("Target does not accept explicit assignments");
  if (input.assignmentDepth > target.maxAssignmentDepth) throw new Error("Explicit assignment exceeds the target assignment-depth limit");
  const candidate = input.selectionContext.candidateSet.summaries.find((summary) => summary.id === parsed.taskId);
  if (target.selection.taskQueryResource !== null && candidate === undefined) throw new Error("Explicit Task is outside the target candidate scope");
  const task = await input.provider.getTaskSnapshot(parsed.taskId);
  verifyTaskCandidate(task, candidate);
  await verifyDependencies(input.provider, task, activeTarget.resolved.taskQuery?.dependencySatisfiedStatuses ?? []);
  await reserveAssignmentBudget(input.provider, target, input.ownerId, parsed.digest);
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

async function acquireAndProject(input: {
  readonly existingRunLeaseId: string | null;
  readonly expiresAt: string;
  readonly operationDigest: string;
  readonly ownerId: string;
  readonly provider: AgentTaskProvider;
  readonly selectionBasisDigest: string;
  readonly target: SubAgentDefinition;
  readonly taskId: string;
  readonly taskStatus: string;
  readonly taskVersion: string;
}): Promise<AssignmentPromotion> {
  const intentKey = `assignment-intent/${input.operationDigest}`;
  const priorIntent = await readAssignmentIntent(input.provider, intentKey, input);
  if (priorIntent?.state === "complete") {
    if (priorIntent.runLeaseId === null || priorIntent.taskLeaseId === null) throw new Error("Completed assignment intent is missing lease identities");
    return { operationDigest: input.operationDigest, ownerId: input.ownerId, runLeaseId: priorIntent.runLeaseId, selectionBasisDigest: input.selectionBasisDigest, targetSubAgentId: input.target.id, taskId: input.taskId, taskLeaseId: priorIntent.taskLeaseId, taskStatus: input.taskStatus, taskVersion: input.taskVersion };
  }
  await writeAssignmentIntent(input.provider, intentKey, input, priorIntent ?? {
    runLeaseId: input.existingRunLeaseId,
    state: "prepared",
    taskLeaseId: null,
  });
  const beforeProjection = await input.provider.getLeaseProjection(input.target.id);
  const beforeActivity = await input.provider.getSubAgentActivity(input.target.id);
  verifyActivity(beforeActivity, beforeProjection);
  let runLeaseId = input.existingRunLeaseId;
  if (runLeaseId === null) {
    const runLease = await input.provider.acquireLease({
      expiresAt: input.expiresAt, idempotencyKey: `selection:${input.operationDigest}:run`, ownerId: input.ownerId,
      scope: "agent_run", subAgentId: input.target.id, taskId: null,
    });
    if (!runLease.acquired || runLease.leaseId === null) {
      throw new Error(`Target run lease conflicts with ${runLease.conflictingLeaseId ?? "an unknown lease"}`);
    }
    runLeaseId = runLease.leaseId;
    await writeAssignmentIntent(input.provider, intentKey, input, { runLeaseId, state: "run_acquired", taskLeaseId: null });
  }
  const taskLease = await input.provider.acquireLease({
    expiresAt: input.expiresAt, idempotencyKey: `selection:${input.operationDigest}:task`, ownerId: input.ownerId,
    scope: "task_assignment", subAgentId: input.target.id, taskId: input.taskId,
  });
  if (!taskLease.acquired || taskLease.leaseId === null) {
    if (input.existingRunLeaseId === null) await input.provider.releaseLease({ expectedVersion: null, leaseId: runLeaseId, ownerId: input.ownerId });
    await writeAssignmentIntent(input.provider, intentKey, input, { runLeaseId: null, state: "compensated", taskLeaseId: null });
    throw new Error(`Selected Task lease conflicts with ${taskLease.conflictingLeaseId ?? "an unknown lease"}`);
  }
  await writeAssignmentIntent(input.provider, intentKey, input, { runLeaseId, state: "task_acquired", taskLeaseId: taskLease.leaseId });
  const afterProjection = await input.provider.getLeaseProjection(input.target.id);
  if (!afterProjection.runLeaseIds.includes(runLeaseId)) throw new Error("Target run lease is not active");
  if (afterProjection.runLeaseIds.length > input.target.maxConcurrency) {
    if (input.existingRunLeaseId === null) await input.provider.releaseLease({ expectedVersion: null, leaseId: runLeaseId, ownerId: input.ownerId });
    await input.provider.releaseLease({ expectedVersion: null, leaseId: taskLease.leaseId, ownerId: input.ownerId });
    throw new Error("Selection exceeds target concurrency");
  }
  const currentActivity = await input.provider.getSubAgentActivity(input.target.id);
  if (!activityMatches(currentActivity, afterProjection)) {
    await input.provider.updateSubAgentActivity({
      expectedRunLeaseIds: beforeProjection.runLeaseIds, expectedTaskIds: beforeActivity.taskIds,
      idempotencyKey: `selection:${input.operationDigest}:activity`, nextRunLeaseIds: afterProjection.runLeaseIds,
      nextTaskIds: afterProjection.taskIds, subAgentId: input.target.id,
    });
  }
  if (!activityMatches(await input.provider.getSubAgentActivity(input.target.id), afterProjection)) throw new Error("Selected Sub-agent activity did not verify");
  await writeAssignmentIntent(input.provider, intentKey, input, { runLeaseId, state: "complete", taskLeaseId: taskLease.leaseId });
  return { operationDigest: input.operationDigest, ownerId: input.ownerId, runLeaseId, selectionBasisDigest: input.selectionBasisDigest, targetSubAgentId: input.target.id, taskId: input.taskId, taskLeaseId: taskLease.leaseId, taskStatus: input.taskStatus, taskVersion: input.taskVersion };
}

type AssignmentIntentState = "compensated" | "complete" | "prepared" | "run_acquired" | "task_acquired";
interface AssignmentIntentProgress {
  readonly runLeaseId: string | null;
  readonly state: AssignmentIntentState;
  readonly taskLeaseId: string | null;
}

async function readAssignmentIntent(
  provider: AgentTaskProvider,
  key: string,
  input: { readonly operationDigest: string; readonly ownerId: string; readonly selectionBasisDigest: string; readonly target: SubAgentDefinition; readonly taskId: string; readonly taskStatus: string; readonly taskVersion: string },
): Promise<AssignmentIntentProgress | null> {
  const resource = await provider.getOptionalResource(key);
  if (resource === null) return null;
  const parsed: unknown = JSON.parse(resource.body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Assignment intent is malformed");
  const value = parsed as Record<string, unknown>;
  if (value.schema !== "assignment-intent-v1" || value.operationDigest !== input.operationDigest || value.ownerId !== input.ownerId || value.selectionBasisDigest !== input.selectionBasisDigest || value.targetSubAgentId !== input.target.id || value.taskId !== input.taskId || value.taskStatus !== input.taskStatus || value.taskVersion !== input.taskVersion) {
    throw new Error("Assignment intent identity conflicts with the requested promotion");
  }
  if (!(["compensated", "complete", "prepared", "run_acquired", "task_acquired"] as const).includes(value.state as AssignmentIntentState)) {
    throw new Error("Assignment intent state is invalid");
  }
  if (value.runLeaseId !== null && typeof value.runLeaseId !== "string" || value.taskLeaseId !== null && typeof value.taskLeaseId !== "string") {
    throw new Error("Assignment intent lease identity is invalid");
  }
  return { runLeaseId: value.runLeaseId as string | null, state: value.state as AssignmentIntentState, taskLeaseId: value.taskLeaseId as string | null };
}

async function writeAssignmentIntent(
  provider: AgentTaskProvider,
  key: string,
  input: { readonly operationDigest: string; readonly ownerId: string; readonly selectionBasisDigest: string; readonly target: SubAgentDefinition; readonly taskId: string; readonly taskStatus: string; readonly taskVersion: string },
  progress: AssignmentIntentProgress,
): Promise<void> {
  const body = JSON.stringify({
    operationDigest: input.operationDigest,
    ownerId: input.ownerId,
    runLeaseId: progress.runLeaseId,
    schema: "assignment-intent-v1",
    state: progress.state,
    selectionBasisDigest: input.selectionBasisDigest,
    targetSubAgentId: input.target.id,
    taskId: input.taskId,
    taskLeaseId: progress.taskLeaseId,
    taskStatus: input.taskStatus,
    taskVersion: input.taskVersion,
  });
  const record: ResourceMutation = {
    body, dependencies: [], digest: sha256(body), idempotencyKey: `${key}:${progress.state}:${sha256(body)}`,
    key, kind: "system/assignment-intent", state: "active", version: "v1",
  };
  await provider.putResource(record);
}

async function reserveAssignmentBudget(
  provider: AgentTaskProvider,
  definition: SubAgentDefinition,
  runIdentity: string,
  operationDigest: string,
): Promise<void> {
  const key = `assignment-budget/${definition.id}/${runIdentity}`;
  const prior = await provider.getOptionalResource(key);
  let operations: string[] = [];
  if (prior !== null) {
    const parsed: unknown = JSON.parse(prior.body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Assignment budget is malformed");
    const value = parsed as Record<string, unknown>;
    if (value.schema !== "assignment-budget-v1" || value.subAgentId !== definition.id || value.runIdentity !== runIdentity || !Array.isArray(value.operationDigests) || value.operationDigests.some((item) => typeof item !== "string")) {
      throw new Error("Assignment budget identity is invalid");
    }
    operations = [...new Set(value.operationDigests as string[])];
  }
  if (!operations.includes(operationDigest)) operations.push(operationDigest);
  if (operations.length > definition.maxAssignmentsPerRun) throw new Error("Sub-agent assignment budget is exhausted");
  operations.sort();
  const body = JSON.stringify({ operationDigests: operations, runIdentity, schema: "assignment-budget-v1", subAgentId: definition.id });
  await provider.putResource({
    body, dependencies: [], digest: sha256(body), idempotencyKey: `${key}:${sha256(body)}`, key,
    kind: "system/assignment-budget", state: "active", version: "v1",
  });
}

function verifyTaskCandidate(task: TaskSnapshot, candidate: CandidateSet["summaries"][number] | undefined): void {
  if (task.archived) throw new Error("Selected Task is archived");
  if (candidate !== undefined && (task.version !== candidate.version || task.status !== candidate.status)) throw new Error("Selected Task changed after candidate compilation");
}

async function verifyDependencies(provider: AgentTaskProvider, task: TaskSnapshot, satisfiedStatuses: readonly string[]): Promise<void> {
  for (const dependencyId of task.dependencies) {
    const dependency = await provider.getTaskSnapshot(dependencyId);
    if (dependency.archived || !satisfiedStatuses.includes(dependency.status)) throw new Error(`Selected Task has an unresolved dependency: ${dependencyId}`);
  }
}

async function releaseAndProjectSelector(
  provider: AgentTaskProvider,
  subAgentId: string,
  leaseId: string,
  ownerId: string,
  operationDigest: string,
): Promise<void> {
  const beforeProjection = await provider.getLeaseProjection(subAgentId);
  const beforeActivity = await provider.getSubAgentActivity(subAgentId);
  verifyActivity(beforeActivity, beforeProjection);
  await provider.releaseLease({ expectedVersion: null, leaseId, ownerId });
  const afterProjection = await provider.getLeaseProjection(subAgentId);
  if (!activityMatches(beforeActivity, afterProjection)) {
    await provider.updateSubAgentActivity({
      expectedRunLeaseIds: beforeProjection.runLeaseIds,
      expectedTaskIds: beforeProjection.taskIds,
      idempotencyKey: `selection:${operationDigest}:selector-finalize`,
      nextRunLeaseIds: afterProjection.runLeaseIds,
      nextTaskIds: afterProjection.taskIds,
      subAgentId,
    });
  }
  verifyActivity(await provider.getSubAgentActivity(subAgentId), afterProjection);
}

function requiredActivated(values: readonly ActivatedDefinition[], id: string): ActivatedDefinition {
  const matches = values.filter(({ resolved }) => resolved.definition.id === id);
  if (matches.length !== 1 || matches[0] === undefined) throw new Error(`Sub-agent ${id} is not uniquely activated`);
  return matches[0];
}

function verifyActivity(activity: SubAgentActivity, projection: LeaseProjection): void {
  if (!activityMatches(activity, projection)) throw new Error("Sub-agent activity does not match active leases");
}
function activityMatches(activity: SubAgentActivity, projection: LeaseProjection): boolean {
  const expectedStatus = projection.runLeaseIds.length === 0 ? "Offline" : "Online";
  return activity.status === expectedStatus && sameSet(activity.taskIds, projection.taskIds);
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join("\0") === [...new Set(right)].sort().join("\0");
}
function requiredString(value: string | null, label: string): string {
  if (value === null || value === "") throw new TypeError(`${label} is missing`);
  return value;
}
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
