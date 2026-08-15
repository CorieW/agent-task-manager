// Exercises the provider-neutral safety contract against the in-memory reference adapter.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  InMemoryProvider,
  SerializedProviderEmulator,
  type ProviderEnvironment,
  type SeedableAgentTaskProvider,
  type TaskSnapshot,
  type WorkspaceSchemaDescriptor,
  type WorkspaceSchemaSnapshot,
} from "../src/index.js";

const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: null, resources: null, subAgents: null, tasks: null },
  type: "memory",
};

const target: WorkspaceSchemaDescriptor = {
  digest: "target-v1",
  providerType: "memory",
  tables: [
    {
      kind: "resources",
      managedRanges: ["Resource workspace"],
      properties: [
        {
          logicalName: "key",
          physicalName: "Key",
          required: true,
          targetTable: null,
          type: "title",
          writable: true,
        },
      ],
      title: "Resources",
    },
    {
      kind: "tasks",
      managedRanges: ["Task workspace"],
      properties: [
        {
          logicalName: "title",
          physicalName: "Task",
          required: true,
          targetTable: null,
          type: "title",
          writable: true,
        },
        {
          logicalName: "resources",
          physicalName: "Resources",
          required: true,
          targetTable: "resources",
          type: "relation",
          writable: true,
        },
      ],
      title: "Tasks",
    },
  ],
  version: "1",
};

function task(id: string, status: string): TaskSnapshot {
  return {
    archived: false,
    body: `body-${id}`,
    dependencies: [],
    id,
    priority: null,
    properties: { nested: { value: id } },
    status,
    title: `Task ${id}`,
    version: `opaque-${id}`,
  };
}

const providerCases = [
  {
    create: (
      snapshot?: WorkspaceSchemaSnapshot,
      now?: () => Date,
    ): SeedableAgentTaskProvider => new InMemoryProvider(environment, target, snapshot, now),
    name: "direct memory provider",
  },
  {
    create: (
      snapshot?: WorkspaceSchemaSnapshot,
      now?: () => Date,
    ): SeedableAgentTaskProvider =>
      new SerializedProviderEmulator(new InMemoryProvider(environment, target, snapshot, now)),
    name: "serialized four-table emulator",
  },
] as const;

for (const providerCase of providerCases) {
describe(providerCase.name, () => {
const createProvider = (
  _environment: ProviderEnvironment,
  _target: WorkspaceSchemaDescriptor,
  snapshot?: WorkspaceSchemaSnapshot,
  now?: () => Date,
): SeedableAgentTaskProvider => providerCase.create(snapshot, now);

test("task summaries honor predicates and cursors without exposing snapshots", async () => {
  const provider = createProvider(environment, target);
  provider.seedTask(task("a", "open"));
  provider.seedTask(task("b", "closed"));
  provider.seedTask(task("c", "open"));

  const summaries = await provider.listTaskSummaries({
    cursor: "a",
    limit: 10,
    predicate: { status: "open" },
  });
  assert.deepEqual(summaries.map((summary) => summary.id), ["c"]);
  assert.deepEqual(Object.keys(summaries[0] ?? {}).sort(), [
    "archived",
    "id",
    "priority",
    "status",
    "title",
    "version",
  ]);
  await assert.rejects(
    provider.listTaskSummaries({ cursor: null, limit: 0, predicate: {} }),
    /limit/,
  );
  await assert.rejects(
    provider.listTaskSummaries({ cursor: null, limit: 1, predicate: { body: "secret" } }),
    /Unsupported task predicate/,
  );
});

test("task writes are atomic, opaque-versioned, replayable, and isolated", async () => {
  const provider = createProvider(environment, target);
  const seeded = task("atomic", "open");
  provider.seedTask(seeded);
  seeded.properties.nested = { value: "caller-mutated" };

  const firstMutation = {
    expectedVersion: "opaque-atomic",
    idempotencyKey: "task-write-1",
    nextBody: "first",
    nextProperties: { winner: 1 },
    nextStatus: null,
    taskId: "atomic",
  } as const;
  const secondMutation = { ...firstMutation, idempotencyKey: "task-write-2", nextBody: "second" };
  const results = await Promise.allSettled([
    provider.applyTaskMutation(firstMutation),
    provider.applyTaskMutation(secondMutation),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);

  const receipt = await provider.applyTaskMutation(firstMutation);
  const stored = await provider.getTaskSnapshot("atomic");
  assert.equal(receipt.providerRecord.id, "atomic");
  assert.equal(receipt.observedVersion, stored.version);
  assert.match(stored.version, /^memory:atomic:[0-9a-f-]{36}$/);
  assert.notEqual(stored.version, seeded.version);
  assert.deepEqual(stored.properties, { Status: "open", winner: 1 });
  stored.properties.winner = 99;
  assert.deepEqual((await provider.getTaskSnapshot("atomic")).properties, { Status: "open", winner: 1 });
  assert.equal((await provider.reconcileIntent("task-write-1")).state, "applied");
});

test("leases are exclusive, expiry-aware, and replayable", async () => {
  let current = Date.parse("2026-01-01T00:00:00.000Z");
  const provider = createProvider(environment, target, undefined, () => new Date(current));
  const request = {
    expiresAt: "2026-01-01T00:01:00.000Z",
    idempotencyKey: "lease-1",
    ownerId: "run-1",
    scope: "task_assignment" as const,
    subAgentId: "agent-1",
    taskId: "task-1",
  };
  const acquired = await provider.acquireLease(request);
  assert.equal(acquired.acquired, true);
  assert.deepEqual(await provider.acquireLease(request), acquired);
  assert.equal(
    (
      await provider.acquireLease({
        ...request,
        idempotencyKey: "lease-2",
        ownerId: "run-2",
        subAgentId: "agent-2",
      })
    ).acquired,
    false,
  );
  current = Date.parse("2026-01-01T00:02:00.000Z");
  assert.equal(
    (
      await provider.acquireLease({
        ...request,
        expiresAt: "2026-01-01T00:03:00.000Z",
        idempotencyKey: "lease-3",
        ownerId: "run-3",
        subAgentId: "agent-3",
      })
    ).acquired,
    true,
  );
});

test("lease renewals replay their original result", async () => {
  const provider = createProvider(
    environment,
    target,
    undefined,
    () => new Date("2026-01-01T00:00:00.000Z"),
  );
  const acquired = await provider.acquireLease({
    expiresAt: "2026-01-01T00:01:00.000Z",
    idempotencyKey: "lease-acquire",
    ownerId: "run",
    scope: "agent_run",
    subAgentId: "agent",
    taskId: null,
  });
  const renewal = {
    expectedExpiresAt: "2026-01-01T00:01:00.000Z",
    idempotencyKey: "lease-renew",
    leaseId: acquired.leaseId!,
    nextExpiresAt: "2026-01-01T00:02:00.000Z",
    ownerId: "run",
  };
  const first = await provider.renewLease(renewal);
  assert.deepEqual(await provider.renewLease(renewal), first);
  assert.equal((await provider.reconcileIntent("lease-renew")).state, "applied");
});

test("manual lease release requires the exact inspected lease version", async () => {
  let current = Date.parse("2026-01-01T00:00:00.000Z");
  const provider = createProvider(environment, target, undefined, () => new Date(current));
  const acquired = await provider.acquireLease({ expiresAt: "2026-01-01T00:10:00.000Z", idempotencyKey: "manual-acquire", ownerId: "owner", scope: "agent_run", subAgentId: "worker", taskId: null });
  const before = await provider.getLeaseSnapshot(acquired.leaseId!); assert.notEqual(before, null);
  current += 1_000;
  await provider.renewLease({ expectedExpiresAt: "2026-01-01T00:10:00.000Z", idempotencyKey: "manual-renew", leaseId: acquired.leaseId!, nextExpiresAt: "2026-01-01T00:20:00.000Z", ownerId: "owner" });
  await assert.rejects(provider.releaseLease({ expectedVersion: before!.version, leaseId: acquired.leaseId!, ownerId: "owner" }), /release conflict/u);
  const after = await provider.getLeaseSnapshot(acquired.leaseId!); assert.notEqual(after, null);
  await provider.releaseLease({ expectedVersion: after!.version, leaseId: acquired.leaseId!, ownerId: "owner" });
  const released = await provider.getLeaseSnapshot(acquired.leaseId!);
  assert.equal(released?.released, true);
  const reacquired = await provider.acquireLease({ expiresAt: "2026-01-01T00:30:00.000Z", idempotencyKey: "manual-reacquire", ownerId: "owner", scope: "agent_run", subAgentId: "worker", taskId: null });
  assert.equal(reacquired.acquired, true);
  assert.equal(await provider.getLeaseSnapshot(acquired.leaseId!), null);
});

test("sub-agent activity is conditionally replaced", async () => {
  const provider = createProvider(environment, target);
  provider.seedDefinition({
    allowedIntents: [],
    capabilities: [],
    maxConcurrency: 1,
    maxAssignmentsPerRun: 1,
    contextBudgetBytes: 100_000,
    deadlineSeconds: 300,
    enabled: true,
    humanResolutionOutcomes: [],
    id: "worker",
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    priority: 1,
    maxAssignmentDepth: 1,
    model: "model",
    name: "Worker",
    promptResources: [],
    prohibitedCapabilities: [],
    reasoning: "medium",
    requiredProviderCapabilities: [],
    revision: 1,
    retry: { maxAttempts: 1, noVerdict: "block" },
    runnerProfile: "default",
    schema: "sub-agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: ["self"],
      maxCandidateSummaries: 1,
      mode: "self",
      resultSchema: "selection",
      taskQueryResource: "query",
    },
    transitions: { succeeded: "$current" },
    outputSchema: "result",
  });
  const run = await provider.acquireLease({
    expiresAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "activity-run", ownerId: "activity-owner",
    scope: "agent_run", subAgentId: "worker", taskId: null,
  });
  const task = await provider.acquireLease({
    expiresAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "activity-task", ownerId: "activity-owner",
    scope: "task_assignment", subAgentId: "worker", taskId: "task-1",
  });
  const first = {
    expectedRunLeaseIds: [],
    expectedTaskIds: [],
    idempotencyKey: "activity-1",
    nextRunLeaseIds: [run.leaseId!],
    nextTaskIds: ["task-1"],
    subAgentId: "worker",
  };
  assert.deepEqual(await provider.updateSubAgentActivity(first), await provider.updateSubAgentActivity(first));
  await assert.rejects(
    provider.updateSubAgentActivity({ ...first, idempotencyKey: "activity-2" }),
    /version conflict|active lease projection/,
  );
});

test("errors use distinct entity and operation identities", async () => {
  const provider = createProvider(environment, target);
  const base = {
    description: "description",
    errorKey: "error-1",
    idempotencyKey: "error-write-1",
    relatedRunId: null,
    relatedSubAgentId: null,
    relatedTaskId: null,
    resolution: "first",
    severity: "medium" as const,
    title: "Error",
  };
  const first = await provider.createOrUpdateError(base);
  assert.deepEqual(await provider.createOrUpdateError(base), first);
  const second = await provider.createOrUpdateError({
    ...base,
    idempotencyKey: "error-write-2",
    resolution: "second",
  });
  assert.equal(second.providerRecord.id, "error-1");
  assert.notEqual(second.observedVersion, first.observedVersion);
});

test("resource pins and read models exclude mutation metadata", async () => {
  const provider = createProvider(environment, target);
  const mutation = {
    body: "body",
    dependencies: [],
    digest: "digest-2",
    idempotencyKey: "resource-write",
    key: "policy",
    kind: "prompt",
    state: "active" as const,
    version: "2",
  };
  const first = await provider.putResource(mutation);
  assert.deepEqual(await provider.putResource(mutation), first);
  const [resource] = await provider.getResources([
    { digest: "digest-2", key: "policy", version: "2" },
  ]);
  assert.equal(Object.hasOwn(resource ?? {}, "idempotencyKey"), false);
  await assert.rejects(
    provider.getResources([{ digest: "digest-2", key: "policy", version: "1" }]),
    /version mismatch/,
  );
});

test("workspace plans converge with verified dependency and digest chains", async () => {
  const provider = createProvider(environment, target);
  const observed = await provider.inspectWorkspaceSchema();
  const plan = await provider.planWorkspaceChanges({
    environmentId: "test",
    mode: "bootstrap",
    observed,
    target,
  });
  assert.ok(plan.steps.length > 1);
  await assert.rejects(provider.applyWorkspaceStep(plan.steps[1]!), /dependencies/);
  for (const step of plan.steps) await provider.applyWorkspaceStep(step);
  assert.equal((await provider.validateTables()).state, "ready");
  const nextPlan = await provider.planWorkspaceChanges({
    environmentId: "test",
    mode: "migration",
    observed: await provider.inspectWorkspaceSchema(),
    target,
  });
  assert.deepEqual(nextPlan.steps, []);
  assert.equal((await provider.reconcileWorkspaceStep(plan.steps[0]!.id)).state, "applied");
});

test("workspace planning fails closed for an unverifiable relation target", async () => {
  const provider = createProvider(environment, target, {
    capturedAt: "2026-01-01T00:00:00.000Z",
    digest: "observed",
    providerIdentity: "memory",
    tables: [
      {
        id: "memory:tasks",
        kind: "tasks",
        managedRanges: ["Task workspace"],
        properties: [
          { name: "Task", providerMetadata: {}, targetTableId: null, type: "title", writable: true },
          {
            name: "Resources",
            providerMetadata: {},
            targetTableId: "wrong",
            type: "relation",
            writable: true,
          },
        ],
        title: "Tasks",
        version: "1",
      },
    ],
  });
  const observed = await provider.inspectWorkspaceSchema();
  await assert.rejects(
    provider.planWorkspaceChanges({ environmentId: "test", mode: "bootstrap", observed, target }),
    /incompatible/,
  );
});

test("environment validation reports the supplied provider mismatch", async () => {
  const provider = createProvider(environment, target);
  const report = await provider.validateEnvironment({ ...environment, type: "other" });
  assert.equal(report.valid, false);
  assert.equal(report.issues[0]?.path, "provider.type");
});
});
}

test("CLI help lists only implemented commands", () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /validate/);
  assert.match(result.stdout, /init --plan/);
  assert.match(result.stdout, /migrate --plan/);
  assert.doesNotMatch(result.stdout, /start|dispatch|tasks eligible/);
});

test("serialized provider emulator rejects lossy non-JSON values", async () => {
  const provider = new SerializedProviderEmulator(new InMemoryProvider(environment, target));
  await assert.rejects(
    provider.validateEnvironment({
      ...environment,
      connection: { invalid: undefined } as unknown as ProviderEnvironment["connection"],
    }),
    /JSON-compatible/u,
  );
});
