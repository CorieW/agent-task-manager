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
  readonly providerIdentity: string;
  readonly request: IdentificationTrialRequest;
  readonly schema: "identification-trial-plan-v1";
  readonly taskBasis: readonly TrialTaskBasis[];
  readonly workspaceIdentityDigest: string;
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

interface TrialTaskObservationCore {
  readonly planDigest: string;
  readonly roleMetrics: readonly TrialRoleMetrics[];
  readonly taskDigest: string;
  readonly taskId: string;
  readonly taskVersion: string;
}

export type TrialTaskObservation = TrialTaskObservationCore & (
  | { readonly issue: TrialObservationIssue; readonly outcome: "blocked" }
  | { readonly issue: null; readonly outcome: "completed" }
);

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

interface BlockerDetails {
  readonly code: string;
  readonly description?: string;
  readonly request: IdentificationTrialRequest;
  readonly resolution: string;
  readonly subAgentId?: string | null;
  readonly taskId?: string | null;
  readonly title: string;
}

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
      providerIdentity: workspace.providerIdentity,
      request,
      schema: "identification-trial-plan-v1" as const,
      taskBasis,
      workspaceIdentityDigest: digestJson(toJsonValue({
        providerIdentity: workspace.providerIdentity,
        tables: workspace.tables.map(({ id, kind }) => ({ id, kind })).sort((left, right) => (left.kind ?? "").localeCompare(right.kind ?? "")),
      })),
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
    return stopWithBlocker(report, createBlocker({
      code: "trial_basis_changed",
      request: plan.request,
      resolution: "Review the provider change and create a new trial basis before continuing.",
      title: "The frozen trial basis changed",
    }));
  }
  const expectedTask = plan.taskBasis[report.nextTaskIndex];
  if (expectedTask === undefined) throw new Error("Identification trial has no remaining Task");
  assertObservation(observation, plan, expectedTask);
  const totals = addMetrics(report.totals, observation.roleMetrics);
  if (observation.outcome === "blocked") {
    const issue = observation.issue;
    const blocker = createBlocker({
      code: issue.code,
      description: issue.description,
      request: plan.request,
      resolution: issue.resolution,
      subAgentId: issue.relatedSubAgentId,
      taskId: observation.taskId,
      title: issue.title,
    });
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
  return { blocker: createBlocker({ code, request, resolution, subAgentId, taskId, title }), state: "blocked" };
}

function createBlocker(details: BlockerDetails): IdentificationTrialBlocker {
  const { code, request, resolution, title } = details;
  const description = details.description ?? title;
  const taskId = details.taskId ?? null;
  const subAgentId = details.subAgentId ?? null;
  assertBoundedString(code, "Blocker code", 100);
  assertBoundedString(title, "Blocker title", 200);
  assertBoundedString(description, "Blocker description", 4_000);
  assertBoundedString(resolution, "Blocker resolution", 4_000);
  const entityIdentity = digestJson(toJsonValue({ code, subAgentId, taskId, trialId: request.trialId }));
  const errorCore = {
    description,
    errorKey: `trial/${request.trialId}/${entityIdentity}`,
    relatedRunId: request.trialId,
    relatedSubAgentId: subAgentId,
    relatedTaskId: taskId,
    resolution,
    severity: "high",
    title,
  } as const;
  const operationIdentity = digestJson(toJsonValue(errorCore));
  const error: ErrorMutation = { ...errorCore, idempotencyKey: `trial-error/${operationIdentity}` };
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
    errors: safeSum(next.errors, row.errors, "errors"),
    humanInterventions: safeSum(next.humanInterventions, row.humanInterventions, "humanInterventions"),
    promptBytes: safeSum(next.promptBytes, row.promptBytes, "promptBytes"),
    providerCalls: safeSum(next.providerCalls, row.providerCalls, "providerCalls"),
    retries: safeSum(next.retries, row.retries, "retries"),
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
  assertExactKeys(request, ["definitionIds", "schema", "taskIds", "trialId"], "Identification trial request");
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
  assertExactKeys(plan, ["definitionBasis", "digest", "providerIdentity", "request", "schema", "taskBasis", "workspaceIdentityDigest", "workspaceSchemaDigest"], "Identification trial plan");
  if (plan.schema !== "identification-trial-plan-v1") throw new TypeError("Identification trial plan schema is invalid");
  const { digest: _digest, ...core } = plan;
  if (digestJson(toJsonValue(core)) !== plan.digest) throw new Error("Identification trial plan digest is invalid");
  assertRequest(plan.request);
  if (plan.taskBasis.length !== 10) throw new Error("Identification trial plan Task basis is incomplete");
  if (plan.taskBasis.map(({ id }) => id).join("\0") !== plan.request.taskIds.join("\0")) throw new Error("Identification trial Task basis order is invalid");
  for (const task of plan.taskBasis) {
    assertExactKeys(task, ["digest", "id", "title", "version"], "Trial Task basis");
    assertSha256(task.digest, "Trial Task digest");
    assertBoundedString(task.id, "Trial Task ID", 500);
    assertBoundedString(task.title, "Trial Task title", 1_000);
    assertBoundedString(task.version, "Trial Task version", 1_000);
  }
  if (plan.definitionBasis.length === 0 || new Set(plan.definitionBasis.map(({ id }) => id)).size !== plan.definitionBasis.length) throw new Error("Identification trial definition basis is incomplete or duplicated");
  if (plan.request.definitionIds !== null && plan.definitionBasis.map(({ id }) => id).join("\0") !== plan.request.definitionIds.join("\0")) throw new Error("Identification trial definition basis order is invalid");
  for (const definition of plan.definitionBasis) {
    assertExactKeys(definition, ["digest", "id", "resourcePins", "revision"], "Trial definition basis");
    assertSha256(definition.digest, "Trial definition digest");
    assertBoundedString(definition.id, "Trial definition ID", 200);
    if (!Number.isSafeInteger(definition.revision) || definition.revision < 1) throw new TypeError("Trial definition revision is invalid");
    if (new Set(definition.resourcePins.map(({ key }) => key)).size !== definition.resourcePins.length) throw new Error("Trial definition Resource pins are duplicated");
    for (const pin of definition.resourcePins) {
      assertExactKeys(pin, ["digest", "key", "version"], "Trial Resource pin");
      assertSha256(pin.digest, "Trial Resource digest");
      assertBoundedString(pin.key, "Trial Resource key", 500);
      assertBoundedString(pin.version, "Trial Resource version", 500);
    }
  }
  assertBoundedString(plan.providerIdentity, "Provider identity", 1_000);
  assertSha256(plan.digest, "Identification trial plan digest");
  assertSha256(plan.workspaceIdentityDigest, "Workspace identity digest");
  assertSha256(plan.workspaceSchemaDigest, "Workspace schema digest");
}

function assertReport(report: IdentificationTrialReport, plan: IdentificationTrialPlan): void {
  assertExactKeys(report, ["blocker", "digest", "nextTaskIndex", "observations", "planDigest", "schema", "state", "totals"], "Identification trial report");
  const { digest: _digest, ...core } = report;
  if (report.schema !== "identification-trial-report-v1" || digestJson(toJsonValue(core)) !== report.digest) throw new Error("Identification trial report is invalid");
  if (report.planDigest !== plan.digest || !Number.isSafeInteger(report.nextTaskIndex) || report.nextTaskIndex < 0 || report.nextTaskIndex > plan.taskBasis.length) throw new Error("Identification trial report does not match its plan progress");
  if (!Array.isArray(report.observations) || report.observations.length > plan.taskBasis.length) throw new Error("Identification trial report has invalid observations");
  let completed = 0;
  let totals = EMPTY_TOTALS;
  for (const [index, observation] of report.observations.entries()) {
    const expected = plan.taskBasis[completed];
    if (expected === undefined) throw new Error("Identification trial report contains excess observations");
    assertObservation(observation, plan, expected);
    totals = addMetrics(totals, observation.roleMetrics);
    if (observation.outcome === "completed") completed += 1;
    else if (index !== report.observations.length - 1) throw new Error("Identification trial report continues after a blocker");
  }
  assertExactKeys(report.totals, ["errors", "humanInterventions", "promptBytes", "providerCalls", "retries"], "Identification trial totals");
  if (completed !== report.nextTaskIndex || (["errors", "humanInterventions", "promptBytes", "providerCalls", "retries"] as const).some((key) => report.totals[key] !== totals[key])) throw new Error("Identification trial report totals or progress are invalid");
  if (report.state === "running" && (report.blocker !== null || completed >= plan.taskBasis.length || report.observations.some(({ outcome }) => outcome === "blocked"))) throw new Error("Running trial report has terminal state");
  if (report.state === "complete" && (report.blocker !== null || completed !== plan.taskBasis.length || report.observations.length !== plan.taskBasis.length)) throw new Error("Complete trial report is incomplete");
  if (report.state === "blocked" && report.blocker === null) throw new Error("Blocked trial report has no blocker");
  if (report.state !== "running" && report.state !== "complete" && report.state !== "blocked") throw new Error("Identification trial report state is invalid");
  if (report.blocker !== null) assertBlocker(report.blocker);
}

function assertObservation(observation: TrialTaskObservation, plan: IdentificationTrialPlan, expected: TrialTaskBasis): void {
  assertExactKeys(observation, ["issue", "outcome", "planDigest", "roleMetrics", "taskDigest", "taskId", "taskVersion"], "Trial observation");
  if (observation.outcome !== "blocked" && observation.outcome !== "completed") throw new TypeError("Trial observation outcome is invalid");
  for (const [value, label] of [[observation.planDigest, "Plan digest"], [observation.taskDigest, "Task digest"], [observation.taskId, "Task ID"], [observation.taskVersion, "Task version"]] as const) {
    assertBoundedString(value, label, 1_000);
  }
  if (observation.planDigest !== plan.digest || observation.taskId !== expected.id || observation.taskVersion !== expected.version || observation.taskDigest !== expected.digest) throw new Error("Trial observation does not match the next frozen Task");
  if (observation.outcome === "blocked" ? observation.issue === null : observation.issue !== null) throw new TypeError("Trial observation issue does not match its outcome");
  if (!Array.isArray(observation.roleMetrics) || observation.roleMetrics.length === 0) throw new TypeError("Trial observation requires role metrics");
  const knownDefinitions = new Set(plan.definitionBasis.map(({ id }) => id));
  const observedDefinitions = new Set<string>();
  for (const row of observation.roleMetrics) {
    assertExactKeys(row, ["definitionId", "errors", "humanInterventions", "promptBytes", "providerCalls", "retries"], "Trial role metrics");
    assertBoundedString(row.definitionId, "Metric definition ID", 200);
    if (!knownDefinitions.has(row.definitionId)) throw new Error(`Trial metrics reference an unknown definition: ${row.definitionId}`);
    if (observedDefinitions.has(row.definitionId)) throw new TypeError(`Trial metrics repeat a definition: ${row.definitionId}`);
    observedDefinitions.add(row.definitionId);
    for (const key of ["errors", "humanInterventions", "promptBytes", "providerCalls", "retries"] as const) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new TypeError(`Trial metric ${key} must be a non-negative safe integer`);
    }
  }
  if (observation.issue !== null) {
    assertExactKeys(observation.issue, ["code", "description", "relatedSubAgentId", "resolution", "title"], "Trial observation issue");
    assertBoundedString(observation.issue.code, "Issue code", 100);
    assertBoundedString(observation.issue.title, "Issue title", 200);
    assertBoundedString(observation.issue.description, "Issue description", 4_000);
    assertBoundedString(observation.issue.resolution, "Issue resolution", 4_000);
    if (observation.issue.relatedSubAgentId !== null) {
      assertBoundedString(observation.issue.relatedSubAgentId, "Issue Sub-agent ID", 200);
      if (!knownDefinitions.has(observation.issue.relatedSubAgentId)) throw new TypeError("Trial issue references an unknown Sub-agent definition");
    }
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) throw new TypeError(`${label} has unexpected or missing fields`);
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} is invalid`);
}

function assertBlocker(blocker: IdentificationTrialBlocker): void {
  assertExactKeys(blocker, ["code", "description", "error", "resolution", "title"], "Identification trial blocker");
  assertBoundedString(blocker.code, "Blocker code", 100);
  assertBoundedString(blocker.description, "Blocker description", 4_000);
  assertBoundedString(blocker.resolution, "Blocker resolution", 4_000);
  assertBoundedString(blocker.title, "Blocker title", 200);
  assertExactKeys(blocker.error, ["description", "errorKey", "idempotencyKey", "relatedRunId", "relatedSubAgentId", "relatedTaskId", "resolution", "severity", "title"], "Identification trial Error proposal");
  if (blocker.error.description !== blocker.description || blocker.error.resolution !== blocker.resolution || blocker.error.title !== blocker.title || blocker.error.severity !== "high") throw new Error("Identification trial blocker Error proposal is inconsistent");
}

function safeSum(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new TypeError(`Trial metric total ${label} exceeds the safe integer range`);
  return result;
}

function assertBoundedString(value: string, label: string, maximumBytes: number): void {
  if (value.trim() === "" || Buffer.byteLength(value, "utf8") > maximumBytes) throw new TypeError(`${label} is empty or too large`);
}
