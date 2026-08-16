/** Verifies coordinator handoff and self-selection promotion through provider leases. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  activateDefinitions,
  finalizeTaskSelectionResult,
  finalizeExplicitAssignment,
  InMemoryProvider,
  prepareSelection,
  promoteSelection,
  promoteExplicitAssignment,
  resolveDefinition,
  type ProviderEnvironment,
  type ResourceMutation,
  type AgentDefinition,
  type TaskSnapshot,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";
import { sha256 } from "../src/core/digest.js";

/** Defines the shared environment fixture for this test module. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: "e", resources: "r", agents: "a", tasks: "t" },
  type: "memory",
};
/** Defines the shared target fixture for this test module. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};
/** Defines the shared expiry fixture for this test module. */
const EXPIRY = "2099-01-01T00:00:00.000Z";
/** Defines the shared activation runtime fixture for this test module. */
const activationRuntime = {
  installedCapabilities: ["dispatch.coordinate", "repository.read"],
  installedIntents: ["task.assignment.request"],
  installedRunnerProfiles: ["readonly"],
  supportedModels: { model: ["medium"] },
} as const;

test("promotes a coordinator assignment into worker run and task leases", async () => {
  /** Defines the provider fixture for “promotes a coordinator assignment into worker run and task leases”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the coordinator fixture for “promotes a coordinator assignment into worker run and task leases”. */
  const coordinator = definition(
    "coordinator",
    "Coordinator",
    "coordinator",
    ["coordinator"],
    ["dispatch.coordinate"],
  );
  /** Defines the worker fixture for “promotes a coordinator assignment into worker run and task leases”. */
  const worker = definition(
    "worker",
    "Migration Analyst",
    "self",
    ["coordinator", "self"],
    ["repository.read"],
  );
  provider.seedDefinition(coordinator);
  provider.seedDefinition(worker);
  provider.seedTaskStatusOptions(["Done", "Ready"]);
  await seedResources(provider, [coordinator, worker]);
  provider.seedTask(task("dependency", "Done", []));
  provider.seedTask(task("task-1", "Ready", ["dependency"]));
  /** Defines the selector run fixture for “promotes a coordinator assignment into worker run and task leases”. */
  const selectorRun = await provider.acquireLease({
    expiresAt: EXPIRY,
    idempotencyKey: "selector-run",
    ownerId: "run-1",
    scope: "agent_run",
    agentId: coordinator.id,
    taskId: null,
  });
  assert.equal(selectorRun.acquired, true);
  await provider.updateAgentActivity({
    expectedRunLeaseIds: [],
    expectedTaskIds: [],
    idempotencyKey: "selector-online",
    nextRunLeaseIds: [selectorRun.leaseId!],
    nextTaskIds: [],
    agentId: coordinator.id,
  });
  /** Defines the resolved fixture for “promotes a coordinator assignment into worker run and task leases”. */
  const resolved = await resolveDefinition(provider, coordinator.id);
  /** Defines the activated fixture for “promotes a coordinator assignment into worker run and task leases”. */
  const activated = await activateDefinitions({
    ...activationRuntime,
    provider,
  });
  /** Defines the context fixture for “promotes a coordinator assignment into worker run and task leases”. */
  const context = await prepareSelection(provider, resolved, activated);
  /** Defines the result fixture for “promotes a coordinator assignment into worker run and task leases”. */
  const result = finalizeTaskSelectionResult({
    candidateSetDigest: context.candidateSet.digest,
    idempotencyKey: "choose-task-1",
    mode: "coordinator",
    outcome: "assignment",
    rationaleDigest: "rationale",
    schema: "task-selection-result-v1",
    selectionBasisDigest: context.basisDigest,
    selectorRevision: coordinator.revision,
    selectorRunId: "run-1",
    selectorAgentId: coordinator.id,
    targetAgentId: worker.id,
    targetAgentRevision: worker.revision,
    taskId: "task-1",
  });
  /** Defines the promotion fixture for “promotes a coordinator assignment into worker run and task leases”. */
  const promotion = await promoteSelection({
    activationRuntime,
    assignmentDepth: 1,
    expiresAt: EXPIRY,
    ownerId: "run-1",
    provider,
    resolvedSelector: resolved,
    result,
    selectionContext: context,
    selectorRunLeaseId: selectorRun.leaseId!,
  });
  assert.equal(promotion?.targetAgentId, worker.id);
  assert.deepEqual((await provider.getAgentActivity(worker.id)).taskIds, [
    "task-1",
  ]);
  assert.equal((await provider.getAgentActivity(worker.id)).status, "Online");
  assert.equal(
    (await provider.getLeaseProjection(worker.id)).runLeaseIds.length,
    1,
  );
  assert.equal(
    (await provider.getAgentActivity(coordinator.id)).status,
    "Offline",
  );
});

test("finalizes the selector run when a coordinator reports no work", async () => {
  /** Defines the provider fixture for “finalizes the selector run when a coordinator reports no work”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the coordinator fixture for “finalizes the selector run when a coordinator reports no work”. */
  const coordinator = definition(
    "coordinator",
    "Coordinator",
    "coordinator",
    ["coordinator"],
    ["dispatch.coordinate"],
  );
  provider.seedDefinition(coordinator);
  provider.seedTaskStatusOptions(["Done", "Ready"]);
  await seedResources(provider, [coordinator]);
  /** Defines the run fixture for “finalizes the selector run when a coordinator reports no work”. */
  const run = await provider.acquireLease({
    expiresAt: EXPIRY,
    idempotencyKey: "no-work-run",
    ownerId: "run-no-work",
    scope: "agent_run",
    agentId: coordinator.id,
    taskId: null,
  });
  await provider.updateAgentActivity({
    expectedRunLeaseIds: [],
    expectedTaskIds: [],
    idempotencyKey: "no-work-online",
    nextRunLeaseIds: [run.leaseId!],
    nextTaskIds: [],
    agentId: coordinator.id,
  });
  /** Defines the resolved fixture for “finalizes the selector run when a coordinator reports no work”. */
  const resolved = await resolveDefinition(provider, coordinator.id);
  /** Defines the activated fixture for “finalizes the selector run when a coordinator reports no work”. */
  const activated = await activateDefinitions({
    ...activationRuntime,
    provider,
  });
  /** Defines the context fixture for “finalizes the selector run when a coordinator reports no work”. */
  const context = await prepareSelection(provider, resolved, activated);
  /** Defines the result fixture for “finalizes the selector run when a coordinator reports no work”. */
  const result = finalizeTaskSelectionResult({
    candidateSetDigest: context.candidateSet.digest,
    idempotencyKey: "no-work",
    mode: "coordinator",
    outcome: "no_work",
    rationaleDigest: null,
    schema: "task-selection-result-v1",
    selectionBasisDigest: context.basisDigest,
    selectorRevision: 1,
    selectorRunId: "run-no-work",
    selectorAgentId: coordinator.id,
    targetAgentId: null,
    targetAgentRevision: null,
    taskId: null,
  });
  assert.equal(
    await promoteSelection({
      activationRuntime,
      assignmentDepth: 0,
      expiresAt: EXPIRY,
      ownerId: "run-no-work",
      provider,
      resolvedSelector: resolved,
      result,
      selectionContext: context,
      selectorRunLeaseId: run.leaseId!,
    }),
    null,
  );
  assert.equal(
    (await provider.getAgentActivity(coordinator.id)).status,
    "Offline",
  );
  assert.deepEqual(
    (await provider.getLeaseProjection(coordinator.id)).runLeaseIds,
    [],
  );
});

test("rejects stale/out-of-scope selections before leases", async () => {
  /** Defines the provider fixture for “rejects stale/out-of-scope selections before leases”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the worker fixture for “rejects stale/out-of-scope selections before leases”. */
  const worker = definition(
    "worker",
    "Documentation Curator",
    "self",
    ["self"],
    ["repository.read"],
  );
  provider.seedDefinition(worker);
  provider.seedTaskStatusOptions(["Done", "Ready"]);
  await seedResources(provider, [worker]);
  provider.seedTask(task("task-1", "Ready", []));
  /** Defines the run fixture for “rejects stale/out-of-scope selections before leases”. */
  const run = await provider.acquireLease({
    expiresAt: EXPIRY,
    idempotencyKey: "run",
    ownerId: "run-2",
    scope: "agent_run",
    agentId: worker.id,
    taskId: null,
  });
  await provider.updateAgentActivity({
    expectedRunLeaseIds: [],
    expectedTaskIds: [],
    idempotencyKey: "online",
    nextRunLeaseIds: [run.leaseId!],
    nextTaskIds: [],
    agentId: worker.id,
  });
  /** Defines the resolved fixture for “rejects stale/out-of-scope selections before leases”. */
  const resolved = await resolveDefinition(provider, worker.id);
  /** Defines the activated fixture for “rejects stale/out-of-scope selections before leases”. */
  const activated = await activateDefinitions({
    ...activationRuntime,
    provider,
  });
  /** Defines the context fixture for “rejects stale/out-of-scope selections before leases”. */
  const context = await prepareSelection(provider, resolved, activated);
  /** Defines the result fixture for “rejects stale/out-of-scope selections before leases”. */
  const result = finalizeTaskSelectionResult({
    candidateSetDigest: context.candidateSet.digest,
    idempotencyKey: "outside",
    mode: "self",
    outcome: "assignment",
    rationaleDigest: "why",
    schema: "task-selection-result-v1",
    selectionBasisDigest: context.basisDigest,
    selectorRevision: 1,
    selectorRunId: "run-2",
    selectorAgentId: worker.id,
    targetAgentId: worker.id,
    targetAgentRevision: 1,
    taskId: "not-in-candidates",
  });
  await assert.rejects(
    promoteSelection({
      activationRuntime,
      assignmentDepth: 1,
      expiresAt: EXPIRY,
      ownerId: "run-2",
      provider,
      resolvedSelector: resolved,
      result,
      selectionContext: context,
      selectorRunLeaseId: run.leaseId!,
    }),
    /outside the bounded candidate set/,
  );
  assert.deepEqual((await provider.getLeaseProjection(worker.id)).taskIds, []);
});

test("promotes a trusted explicit assignment without an AI selector role", async () => {
  /** Defines the provider fixture for “promotes a trusted explicit assignment without an AI selector role”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the worker fixture for “promotes a trusted explicit assignment without an AI selector role”. */
  const worker = definition(
    "worker",
    "Localization Curator",
    "self",
    ["explicit", "self"],
    ["repository.read"],
  );
  provider.seedDefinition(worker);
  provider.seedTaskStatusOptions(["Done", "Ready"]);
  await seedResources(provider, [worker]);
  provider.seedTask(task("task-1", "Ready", []));
  /** Defines the resolved fixture for “promotes a trusted explicit assignment without an AI selector role”. */
  const resolved = await resolveDefinition(provider, worker.id);
  /** Defines the activated fixture for “promotes a trusted explicit assignment without an AI selector role”. */
  const activated = await activateDefinitions({
    ...activationRuntime,
    provider,
  });
  /** Defines the context fixture for “promotes a trusted explicit assignment without an AI selector role”. */
  const context = await prepareSelection(provider, resolved, activated);
  /** Defines the assignment fixture for “promotes a trusted explicit assignment without an AI selector role”. */
  const assignment = finalizeExplicitAssignment({
    authorityId: "human-request-1",
    idempotencyKey: "explicit-1",
    schema: "explicit-assignment-v1",
    selectionBasisDigest: context.basisDigest,
    targetAgentId: worker.id,
    targetAgentRevision: worker.revision,
    taskId: "task-1",
  });
  /** Defines the promoted fixture for “promotes a trusted explicit assignment without an AI selector role”. */
  const promoted = await promoteExplicitAssignment({
    activationRuntime,
    assignment,
    assignmentDepth: 0,
    expiresAt: EXPIRY,
    ownerId: "human-request-1",
    provider,
    resolvedTarget: resolved,
    selectionContext: context,
  });
  assert.equal(promoted.taskId, "task-1");
  assert.equal((await provider.getAgentActivity(worker.id)).status, "Online");
});

/** Creates an Agent definition fixture. */
function definition(
  id: string,
  name: string,
  mode: "coordinator" | "self",
  accepts: AgentDefinition["selection"]["acceptsAssignmentsFrom"],
  capabilities: string[],
): AgentDefinition {
  return {
    allowedIntents: ["task.assignment.request"],
    capabilities,
    maxConcurrency: 1,
    maxAssignmentsPerRun: 1,
    contextBudgetBytes: 100000,
    deadlineSeconds: 600,
    enabled: true,
    humanResolutionOutcomes: [],
    id,
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    priority: 1,
    maxAssignmentDepth: 2,
    model: "model",
    name,
    prohibitedCapabilities: [],
    promptResources: [`prompt/${id}`],
    reasoning: "medium",
    requiredProviderCapabilities: ["leases=atomic"],
    retry: { maxAttempts: 1, noVerdict: "block" },
    revision: 1,
    runnerProfile: "readonly",
    schema: "agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: accepts,
      maxCandidateSummaries: 10,
      mode,
      resultSchema: "schema/selection",
      taskQueryResource: `query/${id}`,
    },
    transitions: { succeeded: "Done" },
    outputSchema: "schema/work",
  };
}

/** Creates a Task snapshot fixture. */
function task(
  id: string,
  status: string,
  dependencies: string[],
): TaskSnapshot {
  return {
    archived: false,
    body: "",
    dependencies,
    id,
    priority: 1,
    properties: { Status: status },
    status,
    title: id,
    version: `v:${id}`,
  };
}

/** Seeds resources. */
async function seedResources(
  provider: InMemoryProvider,
  definitions: AgentDefinition[],
): Promise<void> {
  /** Defines the records fixture used by seed resources. */
  const records = new Map<string, ResourceMutation>();
  for (const definition of definitions) {
    records.set(
      `prompt/${definition.id}`,
      resource(
        `prompt/${definition.id}`,
        "prompt",
        `Prompt for ${definition.name}`,
      ),
    );
    records.set(
      `query/${definition.id}`,
      resource(
        `query/${definition.id}`,
        "task-query",
        JSON.stringify({
          dependencySatisfiedStatuses: ["Done"],
          limit: 10,
          predicate: { status: "Ready" },
          schema: "task-query-v1",
        }),
      ),
    );
  }
  records.set(
    "schema/selection",
    resource("schema/selection", "json-schema", schema()),
  );
  records.set("schema/work", resource("schema/work", "json-schema", schema()));
  for (const record of records.values()) await provider.putResource(record);
}
/** Builds resource. */
function resource(key: string, kind: string, body: string): ResourceMutation {
  return {
    body,
    dependencies: [],
    digest: sha256(body),
    idempotencyKey: `seed:${key}`,
    key,
    kind,
    state: "active",
    version: "v1",
  };
}
/** Creates a closed JSON Schema fixture. */
function schema(): string {
  return JSON.stringify({
    additionalProperties: false,
    properties: {},
    required: [],
    type: "object",
  });
}
