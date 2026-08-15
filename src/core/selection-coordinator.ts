// Validates typed selections and promotes them into provider-backed worker leases.
import { digestJson } from "./digest.js";
import { assertSelectionAuthority, type TaskSelectionResult } from "./selection-result.js";
import { finalizeCandidateSet, taskQueryForDefinition, type CandidateSet } from "./task-query-contract.js";
import { toJsonValue } from "../domain/json.js";
import type { LeaseProjection, SubAgentActivity, SubAgentDefinition, TaskSnapshot } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { ResolvedDefinition } from "./definition-resolver.js";

export interface SelectionContext {
  readonly basisDigest: string;
  readonly candidateSet: CandidateSet;
  readonly selectorDefinitionDigest: string;
}

export interface AssignmentPromotion {
  readonly runLeaseId: string;
  readonly targetSubAgentId: string;
  readonly taskId: string;
  readonly taskLeaseId: string;
}

export async function prepareSelection(
  provider: AgentTaskProvider,
  resolved: ResolvedDefinition,
): Promise<SelectionContext> {
  const summaries = resolved.taskQuery === null
    ? []
    : await provider.listTaskSummaries(taskQueryForDefinition(resolved.taskQuery, resolved.definition));
  const candidateSet = resolved.taskQuery === null
    ? finalizeCandidateSet({ dependencySatisfiedStatuses: [], limit: 1, predicate: {}, schema: "task-query-v1" }, [])
    : finalizeCandidateSet(resolved.taskQuery, summaries);
  const basisDigest = digestJson(toJsonValue({
    candidateSetDigest: candidateSet.digest,
    mode: resolved.definition.selection.mode,
    selectorDefinitionDigest: resolved.digest,
  }));
  return { basisDigest, candidateSet, selectorDefinitionDigest: resolved.digest };
}

export async function promoteSelection(input: {
  readonly assignmentDepth: number;
  readonly expiresAt: string;
  readonly ownerId: string;
  readonly provider: AgentTaskProvider;
  readonly resolvedSelector: ResolvedDefinition;
  readonly result: TaskSelectionResult;
  readonly selectionContext: SelectionContext;
  readonly selectorRunLeaseId: string;
}): Promise<AssignmentPromotion | null> {
  const selector = input.resolvedSelector.definition;
  if (input.assignmentDepth > selector.maxAssignmentDepth) throw new Error("Selection exceeds the definition assignment-depth limit");
  if (input.result.selectionBasisDigest !== input.selectionContext.basisDigest || input.result.candidateSetDigest !== input.selectionContext.candidateSet.digest) {
    throw new Error("Selection result does not match its immutable candidate basis");
  }
  if (input.result.selectorRunId !== input.ownerId) throw new Error("Selection result does not match the active run owner");
  const selectorProjection = await input.provider.getLeaseProjection(selector.id);
  if (!selectorProjection.runLeaseIds.includes(input.selectorRunLeaseId)) throw new Error("Selector run lease is not active");
  if (input.result.outcome === "no_work") {
    assertSelectionAuthority(input.result, selector, null);
    return null;
  }

  const targetId = requiredString(input.result.targetSubAgentId, "Selection target");
  const target = await input.provider.getSubAgentDefinition(targetId);
  assertSelectionAuthority(input.result, selector, target);
  if (!target.enabled) throw new Error("Selection target is disabled");
  const taskId = requiredString(input.result.taskId, "Selected Task");
  const candidate = input.selectionContext.candidateSet.summaries.find((summary) => summary.id === taskId);
  if (selector.selection.taskQueryResource !== null && candidate === undefined) throw new Error("Selected Task is outside the bounded candidate set");
  const task = await input.provider.getTaskSnapshot(taskId);
  verifyTaskCandidate(task, candidate);
  await verifyDependencies(input.provider, task, input.resolvedSelector.taskQuery?.dependencySatisfiedStatuses ?? []);

  const beforeProjection = await input.provider.getLeaseProjection(target.id);
  const beforeActivity = await input.provider.getSubAgentActivity(target.id);
  verifyActivity(beforeActivity, beforeProjection);
  const taskLease = await input.provider.acquireLease({
    expiresAt: input.expiresAt,
    idempotencyKey: `selection:${input.result.digest}:task`,
    ownerId: input.ownerId,
    scope: "task_assignment",
    subAgentId: target.id,
    taskId,
  });
  if (!taskLease.acquired || taskLease.leaseId === null) throw new Error(`Selected Task lease conflicts with ${taskLease.conflictingLeaseId ?? "an unknown lease"}`);

  let runLeaseId = input.selectorRunLeaseId;
  if (input.result.mode !== "self") {
    const runLease = await input.provider.acquireLease({
      expiresAt: input.expiresAt,
      idempotencyKey: `selection:${input.result.digest}:run`,
      ownerId: input.ownerId,
      scope: "agent_run",
      subAgentId: target.id,
      taskId: null,
    });
    if (!runLease.acquired || runLease.leaseId === null) {
      await input.provider.releaseLease({ leaseId: taskLease.leaseId, ownerId: input.ownerId });
      throw new Error(`Target run lease conflicts with ${runLease.conflictingLeaseId ?? "an unknown lease"}`);
    }
    runLeaseId = runLease.leaseId;
  } else if (target.id !== selector.id) {
    throw new Error("Self selection cannot promote another definition");
  }

  const afterProjection = await input.provider.getLeaseProjection(target.id);
  if (afterProjection.runLeaseIds.length > target.concurrency) {
    if (input.result.mode !== "self") await input.provider.releaseLease({ leaseId: runLeaseId, ownerId: input.ownerId });
    await input.provider.releaseLease({ leaseId: taskLease.leaseId, ownerId: input.ownerId });
    throw new Error("Selection exceeds target concurrency");
  }
  const currentActivity = await input.provider.getSubAgentActivity(target.id);
  if (!activityMatches(currentActivity, afterProjection)) {
    await input.provider.updateSubAgentActivity({
      expectedRunLeaseIds: beforeProjection.runLeaseIds,
      expectedTaskIds: beforeActivity.taskIds,
      idempotencyKey: `selection:${input.result.digest}:activity`,
      nextRunLeaseIds: afterProjection.runLeaseIds,
      nextTaskIds: afterProjection.taskIds,
      subAgentId: target.id,
    });
  }
  const verifiedActivity = await input.provider.getSubAgentActivity(target.id);
  if (!activityMatches(verifiedActivity, afterProjection)) throw new Error("Selected Sub-agent activity did not verify");
  return { runLeaseId, targetSubAgentId: target.id, taskId, taskLeaseId: taskLease.leaseId };
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
