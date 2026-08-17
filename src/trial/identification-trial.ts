/** Builds and advances an in-memory, fail-closed identification trial over exactly ten Tasks without provider writes. */
import { digestJson, isSha256Digest } from "../core/digest.js";
import { resolveLoadedDefinition } from "../core/definition-resolver.js";
import { toJsonValue } from "../domain/json.js";
import type { ErrorMutation, TaskSnapshot } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";

/** Inputs accepted by identification trial. */
export interface IdentificationTrialRequest {
  /** Ordered definition IDs for identification trial request. */
  readonly definitionIds: readonly string[] | null;
  /** Wire-schema discriminator; always `identification-trial-request-v1`. */
  readonly schema: "identification-trial-request-v1";
  /** Ordered task IDs for identification trial request. */
  readonly taskIds: readonly string[];
  /** Stable identifier for trial id. */
  readonly trialId: string;
}

/** Canonical trial task basis representation. */
export interface TrialTaskBasis {
  /** Binds trial task basis to canonical record content. */
  readonly digest: string;
  /** Stable identifier for trial task basis. */
  readonly id: string;
  /** Human-readable title. */
  readonly title: string;
  /** Carries the opaque trial task basis version used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Canonical trial definition basis representation. */
export interface TrialDefinitionBasis {
  /** Binds trial definition basis to canonical record content. */
  readonly digest: string;
  /** Stable identifier for trial definition basis. */
  readonly id: string;
  /** Resource pins dependency consumed by trial definition basis. */
  readonly resourcePins: readonly {
    /** Binds trial definition basis to canonical record content. */
    readonly digest: string;
    /** Ordered key used by trial definition basis. */
    readonly key: string;
    /** Carries the opaque trial definition basis version used for compatibility or concurrency checks. */
    readonly version: string;
  }[];
  /** Monotonic definition revision. */
  readonly revision: number;
}

/** Canonical identification trial plan. */
export interface IdentificationTrialPlan {
  /** Ordered definition basis used by identification trial plan. */
  readonly definitionBasis: readonly TrialDefinitionBasis[];
  /** Binds identification trial plan to canonical record content. */
  readonly digest: string;
  /** Provider identity dependency consumed by identification trial plan. */
  readonly providerIdentity: string;
  /** Operation that could not be completed. */
  readonly request: IdentificationTrialRequest;
  /** Wire-schema discriminator; always `identification-trial-plan-v1`. */
  readonly schema: "identification-trial-plan-v1";
  /** Ordered task basis used by identification trial plan. */
  readonly taskBasis: readonly TrialTaskBasis[];
  /** Binds identification trial plan to canonical workspace identity content. */
  readonly workspaceIdentityDigest: string;
  /** Binds identification trial plan to canonical workspace schema content. */
  readonly workspaceSchemaDigest: string;
}

/** Provider-neutral identification trial blocker contract. */
export interface IdentificationTrialBlocker {
  /** Machine-readable outcome or failure code. */
  readonly code: string;
  /** Human-readable explanation. */
  readonly description: string;
  /** Blocking error details. */
  readonly error: ErrorMutation;
  /** Action required to resolve the condition. */
  readonly resolution: string;
  /** Human-readable title. */
  readonly title: string;
}

/** Supported identification trial preparation variants. */
export type IdentificationTrialPreparation =
  | {
      /** Blocking issue that halted trial preparation. */ readonly blocker: IdentificationTrialBlocker;
      /** Lifecycle state used for workflow decisions. */ readonly state: "blocked";
    }
  | {
      /** Immutable migration plan resumed by the bootstrap session. */ readonly plan: IdentificationTrialPlan;
      /** Lifecycle state used for workflow decisions. */ readonly state: "ready";
    };

/** Canonical trial role metrics representation. */
export interface TrialRoleMetrics {
  /** Stable identifier for definition id. */
  readonly definitionId: string;
  /** Errors table data-source identifier. */
  readonly errors: number;
  /** Human interventions dependency consumed by trial role metrics. */
  readonly humanInterventions: number;
  /** Prompt size in bytes. */
  readonly promptBytes: number;
  /** Provider calls dependency consumed by trial role metrics. */
  readonly providerCalls: number;
  /** Retries dependency consumed by trial role metrics. */
  readonly retries: number;
}

/** Canonical trial observation issue representation. */
export interface TrialObservationIssue {
  /** Machine-readable outcome or failure code. */
  readonly code: string;
  /** Human-readable explanation. */
  readonly description: string;
  /** Stable identifier for related agent id. */
  readonly relatedAgentId: string | null;
  /** Action required to resolve the condition. */
  readonly resolution: string;
  /** Human-readable title. */
  readonly title: string;
}

/** Provider-neutral trial task observation core contract. */
interface TrialTaskObservationCore {
  /** Binds trial task observation core to canonical plan content. */
  readonly planDigest: string;
  /** Ordered role metrics used by trial task observation core. */
  readonly roleMetrics: readonly TrialRoleMetrics[];
  /** Binds trial task observation core to canonical task content. */
  readonly taskDigest: string;
  /** Stable identifier for task id. */
  readonly taskId: string;
  /** Opaque version token for task. */
  readonly taskVersion: string;
}

/** Supported trial task observation variants. */
export type TrialTaskObservation = TrialTaskObservationCore &
  (
    | {
        /** Blocking issue details; null for a completed observation. */ readonly issue: TrialObservationIssue;
        /** Observed task outcome. */ readonly outcome: "blocked";
      }
    | {
        /** Blocking issue details; null for a completed observation. */ readonly issue: null;
        /** Observed task outcome. */ readonly outcome: "completed";
      }
  );

/** Provider-neutral trial metric totals contract. */
export interface TrialMetricTotals {
  /** Errors table data-source identifier. */
  readonly errors: number;
  /** Human interventions dependency consumed by trial metric totals. */
  readonly humanInterventions: number;
  /** Prompt size in bytes. */
  readonly promptBytes: number;
  /** Provider calls dependency consumed by trial metric totals. */
  readonly providerCalls: number;
  /** Retries dependency consumed by trial metric totals. */
  readonly retries: number;
}

/** Provider-neutral identification trial report contract. */
export interface IdentificationTrialReport {
  /** Blocking issue that halted trial preparation. */
  readonly blocker: IdentificationTrialBlocker | null;
  /** Binds identification trial report to canonical record content. */
  readonly digest: string;
  /** Ordered next task index used by identification trial report. */
  readonly nextTaskIndex: number;
  /** Ordered observations used by identification trial report. */
  readonly observations: readonly TrialTaskObservation[];
  /** Binds identification trial report to canonical plan content. */
  readonly planDigest: string;
  /** Wire-schema discriminator; always `identification-trial-report-v1`. */
  readonly schema: "identification-trial-report-v1";
  /** Lifecycle state used for workflow decisions. */
  readonly state: "blocked" | "complete" | "running";
  /** Aggregate bounded trial metrics. */
  readonly totals: TrialMetricTotals;
}

/** Canonical identification trial step representation. */
export interface IdentificationTrialStep {
  /** Error record proposed for the blocking observation. */
  readonly errorProposal: ErrorMutation | null;
  /** Current trial report. */
  readonly report: IdentificationTrialReport;
}

/** Zero-valued counters used to initialize trial reports. */
const EMPTY_TOTALS: TrialMetricTotals = {
  errors: 0,
  humanInterventions: 0,
  promptBytes: 0,
  providerCalls: 0,
  retries: 0,
};

/** Provider-neutral blocker details contract. */
interface BlockerDetails {
  /** Machine-readable outcome or failure code. */
  readonly code: string;
  /** Optionally contains description for blocker details. */
  readonly description?: string;
  /** Operation that could not be completed. */
  readonly request: IdentificationTrialRequest;
  /** Action required to resolve the condition. */
  readonly resolution: string;
  /** Optionally identifies Agent. */
  readonly agentId?: string | null;
  /** Optionally identifies task. */
  readonly taskId?: string | null;
  /** Human-readable title. */
  readonly title: string;
}

/** Prepares identification trial. */
export async function prepareIdentificationTrial(
  provider: AgentTaskProvider,
  request: IdentificationTrialRequest,
): Promise<IdentificationTrialPreparation> {
  assertRequest(request);
  try {
    /** Result of `provider.validateTables`, retained for `prepareIdentificationTrial`. */
    const tableReport = await provider.validateTables();
    if (tableReport.state !== "ready") {
      return blocked({
        code: "workspace_not_ready",
        request,
        resolution:
          "Resolve every reported table or property mismatch, then create a fresh trial basis.",
        title: "Provider workspace is not ready",
      });
    }
    /** Result of `provider.inspectWorkspaceSchema`, retained for `prepareIdentificationTrial`. */
    const workspace = await provider.inspectWorkspaceSchema();
    /** Result of `provider.getTaskSnapshot`, retained for `prepareIdentificationTrial`. */
    const taskBasis: TrialTaskBasis[] = [];
    for (const taskId of request.taskIds) {
      /** Result of `provider.getTaskSnapshot`, retained for `prepareIdentificationTrial`. */
      const task = await provider.getTaskSnapshot(taskId);
      if (task.archived) {
        return blocked({
          code: "task_archived",
          request,
          resolution:
            "Restore or replace the archived Task, then create a fresh trial basis.",
          taskId: task.id,
          title: "A trial Task is archived",
        });
      }
      taskBasis.push(taskBasisFor(task));
    }
    /** Result of `provider.listAgentDefinitions`, retained for `prepareIdentificationTrial`. */
    const definitions = await provider.listAgentDefinitions();
    /** Unique requested definition IDs preserved in caller order. */
    const selectedIds =
      request.definitionIds === null
        ? definitions
            .filter((definition) => definition.enabled)
            .map((definition) => definition.id)
            .sort()
        : [...request.definitionIds];
    if (selectedIds.length === 0) {
      return blocked({
        code: "no_enabled_definitions",
        request,
        resolution:
          "Enable at least one provider-defined Agent and create a fresh trial basis.",
        title: "No Agent definition is available",
      });
    }
    /** Indexes entries in `byId` for `prepareIdentificationTrial`. */
    const byId = new Map(
      definitions.map((definition) => [definition.id, definition]),
    );
    /** Result of `byId.get`, retained for `prepareIdentificationTrial`. */
    const definitionBasis: TrialDefinitionBasis[] = [];
    for (const definitionId of selectedIds) {
      /** Result of `byId.get`, retained for `prepareIdentificationTrial`. */
      const definition = byId.get(definitionId);
      if (definition === undefined || !definition.enabled) {
        return blocked({
          code: "definition_unavailable",
          request,
          resolution:
            "Restore or enable the requested provider definition, then create a fresh trial basis.",
          agentId: definitionId,
          title: "A requested Agent definition is unavailable",
        });
      }
      /** Result of `resolveLoadedDefinition`, retained for `prepareIdentificationTrial`. */
      const resolved = await resolveLoadedDefinition(provider, definition);
      definitionBasis.push({
        digest: resolved.digest,
        id: definition.id,
        resourcePins: resolved.resources.map(({ digest, key, version }) => ({
          digest,
          key,
          version,
        })),
        revision: definition.revision,
      });
    }
    /** Core snapshot used consistently during `prepareIdentificationTrial`. */
    const core = {
      definitionBasis,
      providerIdentity: workspace.providerIdentity,
      request,
      schema: "identification-trial-plan-v1" as const,
      taskBasis,
      workspaceIdentityDigest: digestJson(
        toJsonValue({
          providerIdentity: workspace.providerIdentity,
          tables: workspace.tables
            .map(({ id, kind }) => ({ id, kind }))
            .sort((left, right) =>
              (left.kind ?? "").localeCompare(right.kind ?? ""),
            ),
        }),
      ),
      workspaceSchemaDigest: workspace.digest,
    };
    /** Plan snapshot used consistently during `prepareIdentificationTrial`. */
    const plan = { ...core, digest: digestJson(toJsonValue(core)) };
    assertPlan(plan);
    return { plan, state: "ready" };
  } catch {
    return blocked({
      code: "provider_read_failed",
      request,
      resolution:
        "Inspect provider connectivity and the selected Tasks, definitions, and Resources before retrying.",
      title: "Provider trial preflight failed",
    });
  }
}

/** Starts identification trial. */
export function startIdentificationTrial(
  plan: IdentificationTrialPlan,
): IdentificationTrialReport {
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

/** Identification trial observation. */
export async function recordIdentificationTrialObservation(
  provider: AgentTaskProvider,
  plan: IdentificationTrialPlan,
  report: IdentificationTrialReport,
  observation: TrialTaskObservation,
): Promise<IdentificationTrialStep> {
  assertPlan(plan);
  assertReport(report, plan);
  if (report.state !== "running")
    throw new Error("Identification trial has already stopped");
  /** Result of `prepareIdentificationTrial`, retained for `recordIdentificationTrialObservation`. */
  const fresh = await prepareIdentificationTrial(provider, plan.request);
  if (fresh.state === "blocked") return stopWithBlocker(report, fresh.blocker);
  if (fresh.plan.digest !== plan.digest) {
    return stopWithBlocker(
      report,
      createBlocker({
        code: "trial_basis_changed",
        request: plan.request,
        resolution:
          "Review the provider change and create a new trial basis before continuing.",
        title: "The frozen trial basis changed",
      }),
    );
  }
  /** Planned Task basis that the next observation must match. */
  const expectedTask = plan.taskBasis[report.nextTaskIndex];
  if (expectedTask === undefined)
    throw new Error("Identification trial has no remaining Task");
  assertObservation(observation, plan, expectedTask);
  /** Result of `addMetrics`, retained for `recordIdentificationTrialObservation`. */
  const totals = addMetrics(report.totals, observation.roleMetrics);
  if (observation.outcome === "blocked") {
    /** Blocking issue promoted into the trial report. */
    const issue = observation.issue;
    /** Result of `createBlocker`, retained for `recordIdentificationTrialObservation`. */
    const blocker = createBlocker({
      code: issue.code,
      description: issue.description,
      request: plan.request,
      resolution: issue.resolution,
      agentId: issue.relatedAgentId,
      taskId: observation.taskId,
      title: issue.title,
    });
    return {
      errorProposal: blocker.error,
      report: finalizeReport({
        ...withoutDigest(report),
        blocker,
        observations: [...report.observations, observation],
        state: "blocked",
        totals,
      }),
    };
  }
  /** Next task index snapshot used consistently during `recordIdentificationTrialObservation`. */
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

/** Creates a blocked trial preparation. */
function blocked(details: BlockerDetails): IdentificationTrialPreparation {
  return { blocker: createBlocker(details), state: "blocked" };
}

/** Creates blocker. */
function createBlocker(details: BlockerDetails): IdentificationTrialBlocker {
  const { code, request, resolution, title } = details;
  /** Description snapshot used consistently during `createBlocker`. */
  const description = details.description ?? title;
  /** Task id snapshot used consistently during `createBlocker`. */
  const taskId = details.taskId ?? null;
  /** Agent id snapshot used consistently during `createBlocker`. */
  const agentId = details.agentId ?? null;
  assertBoundedString(code, "Blocker code", 100);
  assertBoundedString(title, "Blocker title", 200);
  assertBoundedString(description, "Blocker description", 4_000);
  assertBoundedString(resolution, "Blocker resolution", 4_000);
  /** Result of `digestJson`, retained for `createBlocker`. */
  const entityIdentity = digestJson(
    toJsonValue({ code, agentId, taskId, trialId: request.trialId }),
  );
  /** Error core snapshot used consistently during `createBlocker`. */
  const errorCore = {
    description,
    errorKey: `trial/${request.trialId}/${entityIdentity}`,
    relatedRunId: request.trialId,
    relatedAgentId: agentId,
    relatedTaskId: taskId,
    resolution,
    severity: "high",
    status: "Not Fixed",
    title,
  } as const;
  /** Result of `digestJson`, retained for `createBlocker`. */
  const operationIdentity = digestJson(toJsonValue(errorCore));
  /** Error snapshot used consistently during `createBlocker`. */
  const error: ErrorMutation = {
    ...errorCore,
    idempotencyKey: `trial-error/${operationIdentity}`,
  };
  return { code, description, error, resolution, title };
}

/** Stops with blocker. */
function stopWithBlocker(
  report: IdentificationTrialReport,
  blocker: IdentificationTrialBlocker,
): IdentificationTrialStep {
  return {
    errorProposal: blocker.error,
    report: finalizeReport({
      ...withoutDigest(report),
      blocker,
      state: "blocked",
    }),
  };
}

/** Builds the frozen basis for one trial Task. */
function taskBasisFor(task: TaskSnapshot): TrialTaskBasis {
  return {
    digest: digestJson(toJsonValue(task)),
    id: task.id,
    title: task.title,
    version: task.version,
  };
}

/** Adds role metrics into bounded trial totals. */
function addMetrics(
  total: TrialMetricTotals,
  rows: readonly TrialRoleMetrics[],
): TrialMetricTotals {
  return rows.reduce(
    (next, row) => ({
      errors: safeSum(next.errors, row.errors, "errors"),
      humanInterventions: safeSum(
        next.humanInterventions,
        row.humanInterventions,
        "humanInterventions",
      ),
      promptBytes: safeSum(next.promptBytes, row.promptBytes, "promptBytes"),
      providerCalls: safeSum(
        next.providerCalls,
        row.providerCalls,
        "providerCalls",
      ),
      retries: safeSum(next.retries, row.retries, "retries"),
    }),
    total,
  );
}

/** Finalizes and digests an identification-trial report. */
function finalizeReport(
  core: Omit<IdentificationTrialReport, "digest">,
): IdentificationTrialReport {
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

/** Returns report fields excluding their digest. */
function withoutDigest(
  report: IdentificationTrialReport,
): Omit<IdentificationTrialReport, "digest"> {
  const { digest: _digest, ...core } = report;
  return core;
}

/** Rejects values that violate the request contract. */
function assertRequest(request: IdentificationTrialRequest): void {
  assertExactKeys(
    request,
    ["definitionIds", "schema", "taskIds", "trialId"],
    "Identification trial request",
  );
  if (request.schema !== "identification-trial-request-v1")
    throw new TypeError("Identification trial request schema is invalid");
  assertBoundedString(request.trialId, "Trial ID", 200);
  if (
    request.taskIds.length !== 10 ||
    new Set(request.taskIds).size !== request.taskIds.length
  )
    throw new TypeError(
      "Identification trial requires exactly ten unique Task IDs",
    );
  for (const taskId of request.taskIds)
    assertBoundedString(taskId, "Task ID", 500);
  if (request.definitionIds !== null) {
    if (
      request.definitionIds.length === 0 ||
      new Set(request.definitionIds).size !== request.definitionIds.length
    )
      throw new TypeError(
        "Definition IDs must be null or a non-empty unique list",
      );
    for (const definitionId of request.definitionIds)
      assertBoundedString(definitionId, "Definition ID", 200);
  }
}

/** Rejects values that violate the plan contract. */
function assertPlan(plan: IdentificationTrialPlan): void {
  assertExactKeys(
    plan,
    [
      "definitionBasis",
      "digest",
      "providerIdentity",
      "request",
      "schema",
      "taskBasis",
      "workspaceIdentityDigest",
      "workspaceSchemaDigest",
    ],
    "Identification trial plan",
  );
  if (plan.schema !== "identification-trial-plan-v1")
    throw new TypeError("Identification trial plan schema is invalid");
  const { digest: _digest, ...core } = plan;
  if (digestJson(toJsonValue(core)) !== plan.digest)
    throw new Error("Identification trial plan digest is invalid");
  assertRequest(plan.request);
  if (plan.taskBasis.length !== 10)
    throw new Error("Identification trial plan Task basis is incomplete");
  if (
    plan.taskBasis.map(({ id }) => id).join("\0") !==
    plan.request.taskIds.join("\0")
  )
    throw new Error("Identification trial Task basis order is invalid");
  for (const task of plan.taskBasis) {
    assertExactKeys(
      task,
      ["digest", "id", "title", "version"],
      "Trial Task basis",
    );
    assertSha256(task.digest, "Trial Task digest");
    assertBoundedString(task.id, "Trial Task ID", 500);
    assertBoundedString(task.title, "Trial Task title", 1_000);
    assertBoundedString(task.version, "Trial Task version", 1_000);
  }
  if (
    plan.definitionBasis.length === 0 ||
    new Set(plan.definitionBasis.map(({ id }) => id)).size !==
      plan.definitionBasis.length
  )
    throw new Error(
      "Identification trial definition basis is incomplete or duplicated",
    );
  if (
    plan.request.definitionIds !== null &&
    plan.definitionBasis.map(({ id }) => id).join("\0") !==
      plan.request.definitionIds.join("\0")
  )
    throw new Error("Identification trial definition basis order is invalid");
  for (const definition of plan.definitionBasis) {
    assertExactKeys(
      definition,
      ["digest", "id", "resourcePins", "revision"],
      "Trial definition basis",
    );
    assertSha256(definition.digest, "Trial definition digest");
    assertBoundedString(definition.id, "Trial definition ID", 200);
    if (!Number.isSafeInteger(definition.revision) || definition.revision < 1)
      throw new TypeError("Trial definition revision is invalid");
    if (
      new Set(definition.resourcePins.map(({ key }) => key)).size !==
      definition.resourcePins.length
    )
      throw new Error("Trial definition Resource pins are duplicated");
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

/** Rejects values that violate the report contract. */
function assertReport(
  report: IdentificationTrialReport,
  plan: IdentificationTrialPlan,
): void {
  assertExactKeys(
    report,
    [
      "blocker",
      "digest",
      "nextTaskIndex",
      "observations",
      "planDigest",
      "schema",
      "state",
      "totals",
    ],
    "Identification trial report",
  );
  const { digest: _digest, ...core } = report;
  if (
    report.schema !== "identification-trial-report-v1" ||
    digestJson(toJsonValue(core)) !== report.digest
  )
    throw new Error("Identification trial report is invalid");
  if (
    report.planDigest !== plan.digest ||
    !Number.isSafeInteger(report.nextTaskIndex) ||
    report.nextTaskIndex < 0 ||
    report.nextTaskIndex > plan.taskBasis.length
  )
    throw new Error(
      "Identification trial report does not match its plan progress",
    );
  if (
    !Array.isArray(report.observations) ||
    report.observations.length > plan.taskBasis.length
  )
    throw new Error("Identification trial report has invalid observations");
  /** Completed snapshot used consistently during `assertReport`. */
  let completed = 0;
  /** Totals snapshot used consistently during `assertReport`. */
  let totals = EMPTY_TOTALS;
  for (const [index, observation] of report.observations.entries()) {
    /** Recomputed totals used to verify the report aggregate. */
    const expected = plan.taskBasis[completed];
    if (expected === undefined)
      throw new Error(
        "Identification trial report contains excess observations",
      );
    assertObservation(observation, plan, expected);
    totals = addMetrics(totals, observation.roleMetrics);
    if (observation.outcome === "completed") completed += 1;
    else if (index !== report.observations.length - 1)
      throw new Error("Identification trial report continues after a blocker");
  }
  assertExactKeys(
    report.totals,
    ["errors", "humanInterventions", "promptBytes", "providerCalls", "retries"],
    "Identification trial totals",
  );
  if (
    completed !== report.nextTaskIndex ||
    (
      [
        "errors",
        "humanInterventions",
        "promptBytes",
        "providerCalls",
        "retries",
      ] as const
    ).some((key) => report.totals[key] !== totals[key])
  )
    throw new Error(
      "Identification trial report totals or progress are invalid",
    );
  if (
    report.state === "running" &&
    (report.blocker !== null ||
      completed >= plan.taskBasis.length ||
      report.observations.some(({ outcome }) => outcome === "blocked"))
  )
    throw new Error("Running trial report has terminal state");
  if (
    report.state === "complete" &&
    (report.blocker !== null ||
      completed !== plan.taskBasis.length ||
      report.observations.length !== plan.taskBasis.length)
  )
    throw new Error("Complete trial report is incomplete");
  if (report.state === "blocked" && report.blocker === null)
    throw new Error("Blocked trial report has no blocker");
  if (
    report.state !== "running" &&
    report.state !== "complete" &&
    report.state !== "blocked"
  )
    throw new Error("Identification trial report state is invalid");
  if (report.blocker !== null) assertBlocker(report.blocker);
}

/** Rejects values that violate the observation contract. */
function assertObservation(
  observation: TrialTaskObservation,
  plan: IdentificationTrialPlan,
  expected: TrialTaskBasis,
): void {
  assertExactKeys(
    observation,
    [
      "issue",
      "outcome",
      "planDigest",
      "roleMetrics",
      "taskDigest",
      "taskId",
      "taskVersion",
    ],
    "Trial observation",
  );
  if (observation.outcome !== "blocked" && observation.outcome !== "completed")
    throw new TypeError("Trial observation outcome is invalid");
  for (const [value, label] of [
    [observation.planDigest, "Plan digest"],
    [observation.taskDigest, "Task digest"],
    [observation.taskId, "Task ID"],
    [observation.taskVersion, "Task version"],
  ] as const) {
    assertBoundedString(value, label, 1_000);
  }
  if (
    observation.planDigest !== plan.digest ||
    observation.taskId !== expected.id ||
    observation.taskVersion !== expected.version ||
    observation.taskDigest !== expected.digest
  )
    throw new Error("Trial observation does not match the next frozen Task");
  if (
    observation.outcome === "blocked"
      ? observation.issue === null
      : observation.issue !== null
  )
    throw new TypeError("Trial observation issue does not match its outcome");
  if (
    !Array.isArray(observation.roleMetrics) ||
    observation.roleMetrics.length === 0
  )
    throw new TypeError("Trial observation requires role metrics");
  /** Definition IDs pinned by the trial plan. */
  const knownDefinitions = new Set(plan.definitionBasis.map(({ id }) => id));
  /** Definition IDs reported by this observation, used to reject duplicates. */
  const observedDefinitions = new Set<string>();
  for (const row of observation.roleMetrics) {
    assertExactKeys(
      row,
      [
        "definitionId",
        "errors",
        "humanInterventions",
        "promptBytes",
        "providerCalls",
        "retries",
      ],
      "Trial role metrics",
    );
    assertBoundedString(row.definitionId, "Metric definition ID", 200);
    if (!knownDefinitions.has(row.definitionId))
      throw new Error(
        `Trial metrics reference an unknown definition: ${row.definitionId}`,
      );
    if (observedDefinitions.has(row.definitionId))
      throw new TypeError(
        `Trial metrics repeat a definition: ${row.definitionId}`,
      );
    observedDefinitions.add(row.definitionId);
    for (const key of [
      "errors",
      "humanInterventions",
      "promptBytes",
      "providerCalls",
      "retries",
    ] as const) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0)
        throw new TypeError(
          `Trial metric ${key} must be a non-negative safe integer`,
        );
    }
  }
  if (observedDefinitions.size !== knownDefinitions.size)
    throw new TypeError(
      "Trial metrics must include every selected Agent definition",
    );
  if (observation.issue !== null) {
    assertExactKeys(
      observation.issue,
      ["code", "description", "relatedAgentId", "resolution", "title"],
      "Trial observation issue",
    );
    assertBoundedString(observation.issue.code, "Issue code", 100);
    assertBoundedString(observation.issue.title, "Issue title", 200);
    assertBoundedString(
      observation.issue.description,
      "Issue description",
      4_000,
    );
    assertBoundedString(
      observation.issue.resolution,
      "Issue resolution",
      4_000,
    );
    if (observation.issue.relatedAgentId !== null) {
      assertBoundedString(
        observation.issue.relatedAgentId,
        "Issue Agent ID",
        200,
      );
      if (!knownDefinitions.has(observation.issue.relatedAgentId))
        throw new TypeError(
          "Trial issue references an unknown Agent definition",
        );
    }
  }
}

/** Rejects values that violate the exact keys contract. */
function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    throw new TypeError(`${label} has unexpected or missing fields`);
}

/** Rejects values that violate the SHA-256 contract. */
function assertSha256(value: string, label: string): void {
  if (!isSha256Digest(value)) throw new TypeError(`${label} is invalid`);
}

/** Rejects values that violate the blocker contract. */
function assertBlocker(blocker: IdentificationTrialBlocker): void {
  assertExactKeys(
    blocker,
    ["code", "description", "error", "resolution", "title"],
    "Identification trial blocker",
  );
  assertBoundedString(blocker.code, "Blocker code", 100);
  assertBoundedString(blocker.description, "Blocker description", 4_000);
  assertBoundedString(blocker.resolution, "Blocker resolution", 4_000);
  assertBoundedString(blocker.title, "Blocker title", 200);
  assertExactKeys(
    blocker.error,
    [
      "description",
      "errorKey",
      "idempotencyKey",
      "relatedRunId",
      "relatedAgentId",
      "relatedTaskId",
      "resolution",
      "severity",
      "status",
      "title",
    ],
    "Identification trial Error proposal",
  );
  if (
    blocker.error.description !== blocker.description ||
    blocker.error.resolution !== blocker.resolution ||
    blocker.error.title !== blocker.title ||
    blocker.error.severity !== "high" ||
    blocker.error.status !== "Not Fixed"
  )
    throw new Error(
      "Identification trial blocker Error proposal is inconsistent",
    );
}

/** Adds bounded non-negative metric values. */
function safeSum(left: number, right: number, label: string): number {
  /** Candidate sum checked against the safe-integer bound. */
  const result = left + right;
  if (!Number.isSafeInteger(result))
    throw new TypeError(
      `Trial metric total ${label} exceeds the safe integer range`,
    );
  return result;
}

/** Rejects values that violate the bounded string contract. */
function assertBoundedString(
  value: string,
  label: string,
  maximumBytes: number,
): void {
  if (value.trim() === "" || Buffer.byteLength(value, "utf8") > maximumBytes)
    throw new TypeError(`${label} is empty or too large`);
}
