// Exercises the provider-neutral safety contract against the in-memory reference adapter.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  InMemoryProvider,
  type ProviderEnvironment,
  type TaskSnapshot,
  type WorkspaceSchemaDescriptor,
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

test("task summaries honor predicates and cursors without exposing snapshots", async () => {
  const provider = new InMemoryProvider(environment, target);
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
  const provider = new InMemoryProvider(environment, target);
  const seeded = task("atomic", "open");
  provider.seedTask(seeded);
  seeded.properties.nested = { value: "caller-mutated" };

  const firstMutation = {
    expectedVersion: "opaque-atomic",
    idempotencyKey: "task-write-1",
    nextBody: "first",
    nextProperties: { winner: 1 },
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
  assert.match(stored.version, /^memory:atomic:1$/);
  assert.deepEqual(stored.properties, { winner: 1 });
  stored.properties.winner = 99;
  assert.deepEqual((await provider.getTaskSnapshot("atomic")).properties, { winner: 1 });
  assert.equal((await provider.reconcileIntent("task-write-1")).state, "applied");
});

test("leases are exclusive, expiry-aware, and replayable", async () => {
  let current = Date.parse("2026-01-01T00:00:00.000Z");
  const provider = new InMemoryProvider(environment, target, undefined, () => new Date(current));
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

test("resource pins and read models exclude mutation metadata", async () => {
  const provider = new InMemoryProvider(environment, target);
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
  const provider = new InMemoryProvider(environment, target);
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

test("environment validation reports the supplied provider mismatch", async () => {
  const provider = new InMemoryProvider(environment, target);
  const report = await provider.validateEnvironment({ ...environment, type: "other" });
  assert.equal(report.valid, false);
  assert.equal(report.issues[0]?.path, "provider.type");
});

test("CLI help lists only implemented commands", () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /validate/);
  assert.doesNotMatch(result.stdout, /init --plan|migrate --plan/);
});
