// Verifies coordinator handoff and self-selection promotion through provider leases.
import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeTaskSelectionResult,
  InMemoryProvider,
  prepareSelection,
  promoteSelection,
  resolveDefinition,
  type ProviderEnvironment,
  type ResourceMutation,
  type SubAgentDefinition,
  type TaskSnapshot,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";
import { sha256 } from "../src/core/digest.js";

const environment: ProviderEnvironment = { bootstrapParent: null, connection: {}, tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" }, type: "memory" };
const target: WorkspaceSchemaDescriptor = { digest: "target", providerType: "memory", tables: [], version: "v1" };
const EXPIRY = "2099-01-01T00:00:00.000Z";

test("promotes a coordinator assignment into worker run and task leases", async () => {
  const provider = new InMemoryProvider(environment, target);
  const coordinator = definition("coordinator", "Coordinator", "coordinator", ["coordinator"], ["dispatch.coordinate"]);
  const worker = definition("worker", "Migration Analyst", "self", ["coordinator", "self"], ["repository.read"]);
  provider.seedDefinition(coordinator);
  provider.seedDefinition(worker);
  await seedResources(provider, [coordinator, worker]);
  provider.seedTask(task("dependency", "Done", []));
  provider.seedTask(task("task-1", "Ready", ["dependency"]));
  const selectorRun = await provider.acquireLease({ expiresAt: EXPIRY, idempotencyKey: "selector-run", ownerId: "run-1", scope: "agent_run", subAgentId: coordinator.id, taskId: null });
  assert.equal(selectorRun.acquired, true);
  await provider.updateSubAgentActivity({
    expectedRunLeaseIds: [], expectedTaskIds: [], idempotencyKey: "selector-online",
    nextRunLeaseIds: [selectorRun.leaseId!], nextTaskIds: [], subAgentId: coordinator.id,
  });
  const resolved = await resolveDefinition(provider, coordinator.id);
  const context = await prepareSelection(provider, resolved);
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
    selectorSubAgentId: coordinator.id,
    targetSubAgentId: worker.id,
    targetSubAgentRevision: worker.revision,
    taskId: "task-1",
  });
  const promotion = await promoteSelection({
    assignmentDepth: 1, expiresAt: EXPIRY, ownerId: "run-1", provider, resolvedSelector: resolved,
    result, selectionContext: context, selectorRunLeaseId: selectorRun.leaseId!,
  });
  assert.equal(promotion?.targetSubAgentId, worker.id);
  assert.deepEqual((await provider.getSubAgentActivity(worker.id)).taskIds, ["task-1"]);
  assert.equal((await provider.getSubAgentActivity(worker.id)).status, "Online");
  assert.equal((await provider.getLeaseProjection(worker.id)).runLeaseIds.length, 1);
});

test("rejects stale/out-of-scope selections before leases", async () => {
  const provider = new InMemoryProvider(environment, target);
  const worker = definition("worker", "Documentation Curator", "self", ["self"], ["repository.read"]);
  provider.seedDefinition(worker);
  await seedResources(provider, [worker]);
  provider.seedTask(task("task-1", "Ready", []));
  const run = await provider.acquireLease({ expiresAt: EXPIRY, idempotencyKey: "run", ownerId: "run-2", scope: "agent_run", subAgentId: worker.id, taskId: null });
  await provider.updateSubAgentActivity({ expectedRunLeaseIds: [], expectedTaskIds: [], idempotencyKey: "online", nextRunLeaseIds: [run.leaseId!], nextTaskIds: [], subAgentId: worker.id });
  const resolved = await resolveDefinition(provider, worker.id);
  const context = await prepareSelection(provider, resolved);
  const result = finalizeTaskSelectionResult({
    candidateSetDigest: context.candidateSet.digest, idempotencyKey: "outside", mode: "self", outcome: "assignment",
    rationaleDigest: "why", schema: "task-selection-result-v1", selectionBasisDigest: context.basisDigest,
    selectorRevision: 1, selectorRunId: "run-2", selectorSubAgentId: worker.id,
    targetSubAgentId: worker.id, targetSubAgentRevision: 1, taskId: "not-in-candidates",
  });
  await assert.rejects(promoteSelection({ assignmentDepth: 1, expiresAt: EXPIRY, ownerId: "run-2", provider, resolvedSelector: resolved, result, selectionContext: context, selectorRunLeaseId: run.leaseId! }), /outside the bounded candidate set/);
  assert.deepEqual((await provider.getLeaseProjection(worker.id)).taskIds, []);
});

function definition(id: string, name: string, mode: "coordinator" | "self", accepts: SubAgentDefinition["selection"]["acceptsAssignmentsFrom"], capabilities: string[]): SubAgentDefinition {
  return {
    allowedIntents: ["task.assignment.request"], capabilities, concurrency: 1, contextBudgetBytes: 100000,
    deadlineSeconds: 600, enabled: true, id, inputResourceSelectors: [], invocation: { mode: "manual", scheduleResource: null },
    invocationPriority: 1, maxAssignmentDepth: 2, model: "model", name, prohibitedCapabilities: [],
    promptResources: [`prompt/${id}`], reasoning: "medium", requiredProviderCapabilities: ["leases=atomic"],
    retry: { maxAttempts: 1, noVerdict: "block" }, revision: 1, runnerProfile: "readonly",
    selection: { acceptsAssignmentsFrom: accepts, maxCandidateSummaries: 10, mode, resultSchemaResource: "schema/selection", taskQueryResource: `query/${id}` },
    transitions: { succeeded: "Done" }, workResultSchemaResource: "schema/work",
  };
}

function task(id: string, status: string, dependencies: string[]): TaskSnapshot {
  return { archived: false, body: "", dependencies, id, priority: 1, properties: { Status: status }, status, title: id, version: `v:${id}` };
}

async function seedResources(provider: InMemoryProvider, definitions: SubAgentDefinition[]): Promise<void> {
  const records = new Map<string, ResourceMutation>();
  for (const definition of definitions) {
    records.set(`prompt/${definition.id}`, resource(`prompt/${definition.id}`, "prompt", `Prompt for ${definition.name}`));
    records.set(`query/${definition.id}`, resource(`query/${definition.id}`, "task-query", JSON.stringify({ dependencySatisfiedStatuses: ["Done"], limit: 10, predicate: { status: "Ready" }, schema: "task-query-v1" })));
  }
  records.set("schema/selection", resource("schema/selection", "json-schema", schema()));
  records.set("schema/work", resource("schema/work", "json-schema", schema()));
  for (const record of records.values()) await provider.putResource(record);
}
function resource(key: string, kind: string, body: string): ResourceMutation {
  return { body, dependencies: [], digest: sha256(body), idempotencyKey: `seed:${key}`, key, kind, state: "active", version: "v1" };
}
function schema(): string { return JSON.stringify({ additionalProperties: false, properties: {}, required: [], type: "object" }); }
