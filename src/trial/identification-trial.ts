// Plans and records a read-only, fail-closed identification trial over ten provider Tasks.
import { digestJson } from "../core/digest.js";
import { resolveLoadedDefinition } from "../core/definition-resolver.js";
import { toJsonValue } from "../domain/json.js";
import type { ErrorMutation, TaskSnapshot } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";

export interface IdentificationTrialRequest {
  readonly definitionIds: readonly string[] | null;
  readonly schema: "identification-trial-request-v1";
  readonly taskIds: readonly string[];
  readonly trialId: string;
}

export interface TrialTaskBasis {
  readonly digest: string;
  readonly id: string;
  readonly title: string;
  readonly version: string;
}

export interface TrialDefinitionBasis {
  readonly digest: string;
  readonly id: string;
  readonly resourcePins: readonly {
    readonly digest: string;
    readonly key: string;
    readonly version: string;
  }[];
  readonly revision: number;
}

export interface IdentificationTrialPlan {
  readonly definitionBasis: readonly TrialDefinitionBasis[];
  readonly digest: string;
  readonly request: IdentificationTrialRequest;
  readonly schema: "identification-trial-plan-v1";
  readonly taskBasis: readonly TrialTaskBasis[];
  readonly workspaceSchemaDigest: string;
}

export interface IdentificationTrialBlocker {
  readonly code: string;
  readonly description: string;
  readonly error: ErrorMutation;
  readonly resolution: string;
  readonly title: string;
}

export type IdentificationTrialPreparation =
  | { readonly blocker: IdentificationTrialBlocker; readonly state: "blocked" }
  | { readonly plan: IdentificationTrialPlan; readonly state: "ready" };

export interface TrialRoleMetrics {
  readonly definitionId: string;
  readonly errors: number;
  readonly humanInterventions: number;
  readonly promptBytes: number;
  readonly providerCalls: number;
  readonly retries: number;
}

export interface TrialObservationIssue {
  readonly code: string;
  readonly description: string;
  readonly relatedSubAgentId: string | null;
  readonly resolution: string;
  readonly title: string;
}

export interface TrialTaskObservation {
  readonly issue: TrialObservationIssue | null;
  readonly outcome: "blocked" | "completed";
  readonly planDigest: string;
  readonly roleMetrics: readonly TrialRoleMetrics[];
  readonly taskDigest: string;
  readonly taskId: string;
  readonly taskVersion: string;
}

export interface TrialMetricTotals {
  readonly errors: number;
  readonly humanInterventions: number;
  readonly promptBytes: number;
  readonly providerCalls: number;
  readonly retries: number;
}

export interface IdentificationTrialReport {
  readonly blocker: IdentificationTrialBlocker | null;
  readonly digest: string;
  readonly nextTaskIndex: number;
  readonly observations: readonly TrialTaskObservation[];
  readonly planDigest: string;
  readonly schema: "identification-trial-report-v1";
  readonly state: "blocked" | "complete" | "running";
  readonly totals: TrialMetricTotals;
}

export interface IdentificationTrialStep {
  readonly errorProposal: ErrorMutation | null;
  readonly report: IdentificationTrialReport;
}

const EMPTY_TOTALS: TrialMetricTotals = {
  errors: 0,
  humanInterventions: 0,
  promptBytes: 0,
  providerCalls: 0,
  retries: 0,
};

export async function prepareIdentificationTrial(
  provider: AgentTaskProvider,
  request: IdentificationTrialRequest,
): Promise<IdentificationTrialPreparation> {
  assertRequest(request);
  try {
    const tableReport = await provider.validateTables();
    if (tableReport.state !== "ready") {
      return blocked(request, "workspace_not_ready", "Provider workspace is not ready", "Resolve every reported table or property mismatch, then create a fresh trial basis.");
    }
    const workspace = await provider.inspectWorkspaceSchema();
    const taskBasis: TrialTaskBasis[] = [];
    for (const taskId of request.taskIds) {
      const task = await provider.getTaskSnapshot(taskId);
      if (task.archived) {
        return blocked(request, "task_archived", "A trial Task is archived", "Restore or replace the archived Task, then create a fresh trial basis.", task.id);
      }
      taskBasis.push(taskBasisFor(task));
    }
    const definitions = await provider.listSubAgentDefinitions();
    const selectedIds = request.definitionIds === null
      ? definitions.filter((definition) => definition.enabled).map((definition) => definition.id).sort()
      : [...request.definitionIds];
    if (selectedIds.length === 0) {
      return blocked(request, "no_enabled_definitions", "No Sub-agent definition is available", "Enable at least one provider-defined Sub-agent and create a fresh trial basis.");
    }
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const definitionBasis: TrialDefinitionBasis[] = [];
    for (const definitionId of selectedIds) {
      const definition = byId.get(definitionId);
      if (definition === undefined || !definition.enabled) {
        return blocked(request, "definition_unavailable", "A requested Sub-agent definition is unavailable", "Restore or enable the requested provider definition, then create a fresh trial basis.", null, definitionId);
      }
      const resolved = await resolveLoadedDefinition(provider, definition);
      definitionBasis.push({
        digest: resolved.digest,
        id: definition.id,
        resourcePins: resolved.resources.map(({ digest, key, version }) => ({ digest, key, version })),
        revision: definition.revision,
      });
    }
    const core = {
      definitionBasis,
      request,
      schema: "identification-trial-plan-v1" as const,
      taskBasis,
      workspaceSchemaDigest: workspace.digest,
    };
    return { plan: { ...core, digest: digestJson(toJsonValue(core)) }, state: "ready" };
  } catch {
    return blocked(request, "provider_read_failed", "Provider trial preflight failed", "Inspect provider connectivity and the selected Tasks, definitions, and Resources before retrying.");
  }
}

export function startIdentificationTrial(plan: IdentificationTrialPlan): IdentificationTrialReport {
  assertPlan(plan);
  return finalizeReport({
    blocker: null,
    nextTaskIndex: 0,
    observations: [],
    planDigest: plan.digest,
    schema: "identification-trial-report-v1",
    state: "running",
    totals: EMPTY_TOTALS,
  });
}

export async function recordIdentificationTrialObservation(
  provider: AgentTaskProvider,
  plan: IdentificationTrialPlan,
  report: IdentificationTrialReport,
  observation: TrialTaskObservation,
): Promise<IdentificationTrialStep> {
  assertPlan(plan);
  assertReport(report, plan);
  if (report.state !== "running") throw new Error("Identification trial has already stopped");
  const fresh = await prepareIdentificationTrial(provider, plan.request);
  if (fresh.state === "blocked") return stopWithBlocker(report, fresh.blocker);
  if (fresh.plan.digest !== plan.digest) {
    return stopWithBlocker(
      report,
      createBlocker(plan.request, "trial_basis_changed", "The frozen trial basis changed", "Review the provider change and create a new trial basis before continuing."),
    );
  }
  const expectedTask = plan.taskBasis[report.nextTaskIndex];
  if (expectedTask === undefined) throw new Error("Identification trial has no remaining Task");
  assertObservation(observation, plan, expectedTask);
  const totals = addMetrics(report.totals, observation.roleMetrics);
  if (observation.outcome === "blocked") {
    const issue = observation.issue!;
    const blocker = createBlocker(
      plan.request,
      issue.code,
      issue.title,
      issue.resolution,
      observation.taskId,
      issue.relatedSubAgentId,
      issue.description,
    );
    return {
      errorProposal: blocker.error,
      report: finalizeReport({ ...withoutDigest(report), blocker, observations: [...report.observations, observation], state: "blocked", totals }),
    };
  }
  const nextTaskIndex = report.nextTaskIndex + 1;
  return {
    errorProposal: null,
    report: finalizeReport({
      ...withoutDigest(report),
      nextTaskIndex,
      observations: [...report.observations, observation],
      state: nextTaskIndex === plan.taskBasis.length ? "complete" : "running",
      totals,
    }),
  };
}

function blocked(
  request: IdentificationTrialRequest,
  code: string,
  title: string,
  resolution: string,
  taskId: string | null = null,
  subAgentId: string | null = null,
): IdentificationTrialPreparation {
  return { blocker: createBlocker(request, code, title, resolution, taskId, subAgentId), state: "blocked" };
}

function createBlocker(
  request: IdentificationTrialRequest,
  code: string,
  title: string,
  resolution: string,
  taskId: string | null = null,
  subAgentId: string | null = null,
  description = title,
): IdentificationTrialBlocker {
  assertBoundedString(code, "Blocker code", 100);
  assertBoundedString(title, "Blocker title", 200);
  assertBoundedString(description, "Blocker description", 4_000);
  assertBoundedString(resolution, "Blocker resolution", 4_000);
  const identity = digestJson(toJsonValue({ code, taskId, trialId: request.trialId }));
  const error: ErrorMutation = {
    description,
    errorKey: `trial/${request.trialId}/${identity}`,
    idempotencyKey: `trial-error/${identity}`,
    relatedRunId: request.trialId,
    relatedSubAgentId: subAgentId,
    relatedTaskId: taskId,
    resolution,
    severity: "high",
    title,
  };
  return { code, description, error, resolution, title };
}

function stopWithBlocker(report: IdentificationTrialReport, blocker: IdentificationTrialBlocker): IdentificationTrialStep {
  return {
    errorProposal: blocker.error,
    report: finalizeReport({ ...withoutDigest(report), blocker, state: "blocked" }),
  };
}

function taskBasisFor(task: TaskSnapshot): TrialTaskBasis {
  return { digest: digestJson(toJsonValue(task)), id: task.id, title: task.title, version: task.version };
}

function addMetrics(total: TrialMetricTotals, rows: readonly TrialRoleMetrics[]): TrialMetricTotals {
  return rows.reduce((next, row) => ({
    errors: next.errors + row.errors,
    humanInterventions: next.humanInterventions + row.humanInterventions,
    promptBytes: next.promptBytes + row.promptBytes,
    providerCalls: next.providerCalls + row.providerCalls,
    retries: next.retries + row.retries,
  }), total);
}

function finalizeReport(core: Omit<IdentificationTrialReport, "digest">): IdentificationTrialReport {
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

function withoutDigest(report: IdentificationTrialReport): Omit<IdentificationTrialReport, "digest"> {
  const { digest: _digest, ...core } = report;
  return core;
}

function assertRequest(request: IdentificationTrialRequest): void {
  if (request.schema !== "identification-trial-request-v1") throw new TypeError("Identification trial request schema is invalid");
  assertBoundedString(request.trialId, "Trial ID", 200);
  if (request.taskIds.length !== 10 || new Set(request.taskIds).size !== request.taskIds.length) throw new TypeError("Identification trial requires exactly ten unique Task IDs");
  for (const taskId of request.taskIds) assertBoundedString(taskId, "Task ID", 500);
  if (request.definitionIds !== null) {
    if (request.definitionIds.length === 0 || new Set(request.definitionIds).size !== request.definitionIds.length) throw new TypeError("Definition IDs must be null or a non-empty unique list");
    for (const definitionId of request.definitionIds) assertBoundedString(definitionId, "Definition ID", 200);
  }
}

function assertPlan(plan: IdentificationTrialPlan): void {
  if (plan.schema !== "identification-trial-plan-v1") throw new TypeError("Identification trial plan schema is invalid");
  const { digest: _digest, ...core } = plan;
  if (digestJson(toJsonValue(core)) !== plan.digest) throw new Error("Identification trial plan digest is invalid");
  assertRequest(plan.request);
  if (plan.taskBasis.length !== 10) throw new Error("Identification trial plan Task basis is incomplete");
}

function assertReport(report: IdentificationTrialReport, plan: IdentificationTrialPlan): void {
  const { digest: _digest, ...core } = report;
  if (report.schema !== "identification-trial-report-v1" || digestJson(toJsonValue(core)) !== report.digest) throw new Error("Identification trial report is invalid");
  if (report.planDigest !== plan.digest || report.nextTaskIndex !== report.observations.filter(({ outcome }) => outcome === "completed").length) throw new Error("Identification trial report does not match its plan progress");
}

function assertObservation(observation: TrialTaskObservation, plan: IdentificationTrialPlan, expected: TrialTaskBasis): void {
  if (observation.planDigest !== plan.digest || observation.taskId !== expected.id || observation.taskVersion !== expected.version || observation.taskDigest !== expected.digest) throw new Error("Trial observation does not match the next frozen Task");
  if (observation.outcome === "blocked" ? observation.issue === null : observation.issue !== null) throw new TypeError("Trial observation issue does not match its outcome");
  if (observation.roleMetrics.length === 0) throw new TypeError("Trial observation requires role metrics");
  const knownDefinitions = new Set(plan.definitionBasis.map(({ id }) => id));
  for (const row of observation.roleMetrics) {
    if (!knownDefinitions.has(row.definitionId)) throw new Error(`Trial metrics reference an unknown definition: ${row.definitionId}`);
    for (const [key, value] of Object.entries(row).filter(([key]) => key !== "definitionId")) {
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`Trial metric ${key} must be a non-negative safe integer`);
    }
  }
  if (observation.issue !== null) {
    assertBoundedString(observation.issue.code, "Issue code", 100);
    assertBoundedString(observation.issue.title, "Issue title", 200);
    assertBoundedString(observation.issue.description, "Issue description", 4_000);
    assertBoundedString(observation.issue.resolution, "Issue resolution", 4_000);
  }
}

function assertBoundedString(value: string, label: string, maximumBytes: number): void {
  if (value.trim() === "" || Buffer.byteLength(value, "utf8") > maximumBytes) throw new TypeError(`${label} is empty or too large`);
}
