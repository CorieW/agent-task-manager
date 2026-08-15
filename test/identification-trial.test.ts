// Exercises the read-only ten-Task trial planner with provider-defined custom roles.
import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryProvider,
  prepareIdentificationTrial,
  recordIdentificationTrialObservation,
  sha256,
  startIdentificationTrial,
  type IdentificationTrialPlan,
  type ProviderEnvironment,
  type ResourceMutation,
  type SubAgentDefinition,
  type TrialTaskObservation,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";

const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: "errors", resources: "resources", subAgents: "agents", tasks: "tasks" },
  type: "memory",
};
const target: WorkspaceSchemaDescriptor = { digest: "trial-target", providerType: "memory", tables: [], version: "v1" };

test("completes an exact ten-Task trial and compares provider-defined role metrics", async () => {
  const provider = await preparedProvider();
  const preparation = await prepareIdentificationTrial(provider, request());
  assert.equal(preparation.state, "ready");
  if (preparation.state !== "ready") return;
  assert.deepEqual(preparation.plan.definitionBasis.map(({ id }) => id), ["dependency-cartographer", "incident-summarizer"]);
  let report = startIdentificationTrial(preparation.plan);
  for (const task of preparation.plan.taskBasis) {
    const step = await recordIdentificationTrialObservation(provider, preparation.plan, report, observation(preparation.plan, task.id));
    assert.equal(step.errorProposal, null);
    report = step.report;
  }
  assert.equal(report.state, "complete");
  assert.equal(report.nextTaskIndex, 10);
  assert.deepEqual(report.totals, { errors: 0, humanInterventions: 10, promptBytes: 3_000, providerCalls: 20, retries: 10 });
  assert.deepEqual((await provider.getTaskSnapshot("task-001")).properties, { sequence: 1 });
});

test("stops on the first observed blocker and proposes one provider Error", async () => {
  const provider = await preparedProvider();
  const preparation = await prepareIdentificationTrial(provider, request());
  assert.equal(preparation.state, "ready");
  if (preparation.state !== "ready") return;
  let report = startIdentificationTrial(preparation.plan);
  report = (await recordIdentificationTrialObservation(provider, preparation.plan, report, observation(preparation.plan, "task-001"))).report;
  const blockedObservation = {
    ...observation(preparation.plan, "task-002"),
    issue: {
      code: "missing_runtime_adapter",
      description: "The provider-defined role cannot be launched by the configured environment.",
      relatedSubAgentId: "incident-summarizer",
      resolution: "Install and configure the named adapter before creating a fresh trial basis.",
      title: "Runtime adapter unavailable",
    },
    outcome: "blocked" as const,
  };
  const step = await recordIdentificationTrialObservation(provider, preparation.plan, report, blockedObservation);
  assert.equal(step.report.state, "blocked");
  assert.equal(step.report.nextTaskIndex, 1);
  assert.equal(step.errorProposal?.relatedTaskId, "task-002");
  await assert.rejects(recordIdentificationTrialObservation(provider, preparation.plan, step.report, observation(preparation.plan, "task-002")), /already stopped/u);
});

test("stops when any frozen Task, definition, Resource, or workspace basis changes", async () => {
  const provider = await preparedProvider();
  const preparation = await prepareIdentificationTrial(provider, request());
  assert.equal(preparation.state, "ready");
  if (preparation.state !== "ready") return;
  const task = await provider.getTaskSnapshot("task-001");
  await provider.applyTaskMutation({
    expectedVersion: task.version,
    idempotencyKey: "human-edit",
    nextBody: `${task.body}\nchanged`,
    nextProperties: task.properties,
    nextStatus: null,
    taskId: task.id,
  });
  const step = await recordIdentificationTrialObservation(
    provider,
    preparation.plan,
    startIdentificationTrial(preparation.plan),
    observation(preparation.plan, "task-001"),
  );
  assert.equal(step.report.state, "blocked");
  assert.equal(step.report.blocker?.code, "trial_basis_changed");
  assert.equal(step.report.observations.length, 0);
});

test("binds the provider identity and physical workspace identity", async () => {
  const firstProvider = await preparedProvider("workspace-a");
  const secondProvider = await preparedProvider("workspace-b");
  const preparation = await prepareIdentificationTrial(firstProvider, request());
  assert.equal(preparation.state, "ready");
  if (preparation.state !== "ready") return;
  const step = await recordIdentificationTrialObservation(
    secondProvider,
    preparation.plan,
    startIdentificationTrial(preparation.plan),
    observation(preparation.plan, "task-001"),
  );
  assert.equal(step.report.state, "blocked");
  assert.equal(step.report.blocker?.code, "trial_basis_changed");
});

test("rejects malformed outcomes, incomplete counters, and duplicate role rows", async () => {
  const provider = await preparedProvider();
  const preparation = await prepareIdentificationTrial(provider, request());
  assert.equal(preparation.state, "ready");
  if (preparation.state !== "ready") return;
  const report = startIdentificationTrial(preparation.plan);
  const valid = observation(preparation.plan, "task-001");
  await assert.rejects(
    recordIdentificationTrialObservation(provider, preparation.plan, report, { ...valid, outcome: "skipped" } as unknown as TrialTaskObservation),
    /outcome is invalid/u,
  );
  const { errors: _errors, ...incomplete } = valid.roleMetrics[0]!;
  const second = valid.roleMetrics[1]!;
  await assert.rejects(
    recordIdentificationTrialObservation(provider, preparation.plan, report, { ...valid, roleMetrics: [incomplete, second] } as unknown as TrialTaskObservation),
    /unexpected or missing fields/u,
  );
  await assert.rejects(
    recordIdentificationTrialObservation(provider, preparation.plan, report, { ...valid, roleMetrics: [valid.roleMetrics[0]!, valid.roleMetrics[0]!] }),
    /repeat a definition/u,
  );
  await assert.rejects(
    recordIdentificationTrialObservation(provider, preparation.plan, report, { ...valid, roleMetrics: [valid.roleMetrics[0]!] }),
    /include every selected/u,
  );
});

test("uses distinct replay identities for different definition blockers", async () => {
  const provider = await preparedProvider();
  const missingA = await prepareIdentificationTrial(provider, { ...request(), definitionIds: ["missing-a"] });
  const missingB = await prepareIdentificationTrial(provider, { ...request(), definitionIds: ["missing-b"] });
  assert.equal(missingA.state, "blocked");
  assert.equal(missingB.state, "blocked");
  if (missingA.state !== "blocked" || missingB.state !== "blocked") return;
  assert.notEqual(missingA.blocker.error.errorKey, missingB.blocker.error.errorKey);
  assert.notEqual(missingA.blocker.error.idempotencyKey, missingB.blocker.error.idempotencyKey);
});

test("fails closed before trial execution when provider tables are not ready", async () => {
  const requiredTarget: WorkspaceSchemaDescriptor = {
    digest: "required",
    providerType: "memory",
    tables: [{ kind: "tasks", managedRanges: [], properties: [], title: "Tasks" }],
    version: "v1",
  };
  const provider = new InMemoryProvider(environment, requiredTarget);
  const preparation = await prepareIdentificationTrial(provider, request());
  assert.equal(preparation.state, "blocked");
  if (preparation.state === "blocked") assert.equal(preparation.blocker.code, "workspace_not_ready");
});

test("returns a blocker instead of an unusable ready plan for invalid provider data", async () => {
  const provider = await preparedProvider();
  const task = await provider.getTaskSnapshot("task-001");
  provider.seedTask({ ...task, title: "x".repeat(1_001) });
  const preparation = await prepareIdentificationTrial(provider, request());
  assert.equal(preparation.state, "blocked");
  if (preparation.state === "blocked") assert.equal(preparation.blocker.code, "provider_read_failed");
});

async function preparedProvider(providerIdentity = "memory"): Promise<InMemoryProvider> {
  const provider = new InMemoryProvider(environment, target, {
    capturedAt: "2026-08-15T00:00:00.000Z",
    digest: sha256("[]"),
    providerIdentity,
    tables: [],
  });
  for (const record of resources()) await provider.putResource(record);
  provider.seedDefinition(definition("incident-summarizer", "Incident Summarizer", "prompt/incidents"));
  provider.seedDefinition(definition("dependency-cartographer", "Dependency Cartographer", "prompt/dependencies"));
  for (let index = 1; index <= 10; index += 1) {
    const suffix = String(index).padStart(3, "0");
    provider.seedTask({
      archived: false,
      body: `Task ${suffix} body`,
      dependencies: [],
      id: `task-${suffix}`,
      priority: index,
      properties: { sequence: index },
      status: "Trial",
      title: suffix,
      version: `v-${suffix}`,
    });
  }
  return provider;
}

function request() {
  return {
    definitionIds: null,
    schema: "identification-trial-request-v1" as const,
    taskIds: Array.from({ length: 10 }, (_, index) => `task-${String(index + 1).padStart(3, "0")}`),
    trialId: "management-identification-001-010",
  };
}

function definition(id: string, name: string, prompt: string): SubAgentDefinition {
  return {
    allowedIntents: [],
    capabilities: [],
    contextBudgetBytes: 100_000,
    deadlineSeconds: 300,
    enabled: true,
    humanResolutionOutcomes: [],
    id,
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    maxAssignmentDepth: 1,
    maxAssignmentsPerRun: 1,
    maxConcurrency: 1,
    model: "test-model",
    name,
    outputSchema: "schema/work",
    priority: 10,
    prohibitedCapabilities: [],
    promptResources: [prompt],
    reasoning: "medium",
    requiredProviderCapabilities: [],
    retry: { maxAttempts: 1, noVerdict: "block" },
    revision: 1,
    runnerProfile: "test-readonly",
    schema: "sub-agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: ["explicit"],
      maxCandidateSummaries: 10,
      mode: "explicit",
      resultSchema: "schema/selection",
      taskQueryResource: null,
    },
    transitions: { succeeded: "$current" },
  };
}

function resources(): readonly ResourceMutation[] {
  const schema = JSON.stringify({ additionalProperties: false, properties: {}, required: [], type: "object" });
  return [
    resource("prompt/incidents", "prompt", "Summarize incidents without mutating provider state."),
    resource("prompt/dependencies", "prompt", "Map dependencies without mutating provider state."),
    resource("schema/selection", "json-schema", schema),
    resource("schema/work", "json-schema", schema),
  ];
}

function resource(key: string, kind: string, body: string): ResourceMutation {
  return { body, dependencies: [], digest: sha256(body), idempotencyKey: `seed:${key}`, key, kind, state: "active", version: "v1" };
}

function observation(plan: IdentificationTrialPlan, taskId: string): TrialTaskObservation {
  const task = plan.taskBasis.find(({ id }) => id === taskId)!;
  return {
    issue: null,
    outcome: "completed",
    planDigest: plan.digest,
    roleMetrics: [
      { definitionId: "dependency-cartographer", errors: 0, humanInterventions: 1, promptBytes: 100, providerCalls: 1, retries: 0 },
      { definitionId: "incident-summarizer", errors: 0, humanInterventions: 0, promptBytes: 200, providerCalls: 1, retries: 1 },
    ],
    taskDigest: task.digest,
    taskId,
    taskVersion: task.version,
  };
}
