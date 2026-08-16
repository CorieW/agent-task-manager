/** Exercises the provider contract against direct memory and the serialized boundary emulator. */
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

/** Supplies the provider environment shared by the scenarios. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: null, resources: null, agents: null, tasks: null },
  type: "memory",
};

/** Supplies the canonical workspace schema target. */
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

/** Creates a Task snapshot fixture. */
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

/** Enumerates provider implementations sharing conformance tests. */
const providerCases = [
  {
    create: (
      snapshot?: WorkspaceSchemaSnapshot,
      now?: () => Date,
    ): SeedableAgentTaskProvider =>
      new InMemoryProvider(environment, target, snapshot, now),
    name: "direct memory provider",
  },
  {
    create: (
      snapshot?: WorkspaceSchemaSnapshot,
      now?: () => Date,
    ): SeedableAgentTaskProvider =>
      new SerializedProviderEmulator(
        new InMemoryProvider(environment, target, snapshot, now),
      ),
    name: "serialized four-table emulator",
  },
] as const;

for (const providerCase of providerCases) {
  describe(providerCase.name, () => {
    /** Constructs the provider implementation under conformance test. */
    const createProvider = (
      _environment: ProviderEnvironment,
      _target: WorkspaceSchemaDescriptor,
      snapshot?: WorkspaceSchemaSnapshot,
      now?: () => Date,
    ): SeedableAgentTaskProvider => providerCase.create(snapshot, now);

    test("task summaries honor predicates and cursors without exposing snapshots", async () => {
      /** Provides isolated provider state for the scenario. */
      const provider = createProvider(environment, target);
      provider.seedTask(task("a", "open"));
      provider.seedTask(task("b", "closed"));
      provider.seedTask(task("c", "open"));

      /** Collects decoded Task summaries returned by the provider. */
      const summaries = await provider.listTaskSummaries({
        cursor: "a",
        limit: 10,
        predicate: { status: "open" },
      });
      assert.deepEqual(
        summaries.map((summary) => summary.id),
        ["c"],
      );
      /** Defines summaries selected from either authorized status. */
      const multiStatusSummaries = await provider.listTaskSummaries({
        cursor: null,
        limit: 10,
        predicate: { status: ["open", "closed"] },
      });
      assert.deepEqual(
        multiStatusSummaries.map((summary) => summary.id),
        ["a", "b", "c"],
      );
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
        provider.listTaskSummaries({
          cursor: null,
          limit: 1,
          predicate: { body: "secret" },
        }),
        /Unsupported task predicate/,
      );
    });

    test("task writes are atomic, opaque-versioned, replayable, and isolated", async () => {
      /** Provides isolated provider state for the scenario. */
      const provider = createProvider(environment, target);
      /** Preserves the caller-owned Task object used to test isolation. */
      const seeded = task("atomic", "open");
      provider.seedTask(seeded);
      seeded.properties.nested = { value: "caller-mutated" };

      /** Describes the first contender in the atomic write race. */
      const firstMutation = {
        expectedVersion: "opaque-atomic",
        idempotencyKey: "task-write-1",
        nextBody: "first",
        nextProperties: { winner: 1 },
        nextStatus: null,
        taskId: "atomic",
      } as const;
      /** Describes the competing atomic write. */
      const secondMutation = {
        ...firstMutation,
        idempotencyKey: "task-write-2",
        nextBody: "second",
      };
      /** Collects operation outcomes used by assertions. */
      const results = await Promise.allSettled([
        provider.applyTaskMutation(firstMutation),
        provider.applyTaskMutation(secondMutation),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );

      /** Captures the durable write or effect result used as the oracle. */
      const receipt = await provider.applyTaskMutation(firstMutation);
      /** Reads persisted state used as the assertion oracle. */
      const stored = await provider.getTaskSnapshot("atomic");
      assert.equal(receipt.providerRecord.id, "atomic");
      assert.equal(receipt.observedVersion, stored.version);
      assert.match(stored.version, /^memory:atomic:[0-9a-f-]{36}$/);
      assert.notEqual(stored.version, seeded.version);
      assert.deepEqual(stored.properties, { Status: "open", winner: 1 });
      stored.properties.winner = 99;
      assert.deepEqual((await provider.getTaskSnapshot("atomic")).properties, {
        Status: "open",
        winner: 1,
      });
      assert.equal(
        (await provider.reconcileIntent("task-write-1")).state,
        "applied",
      );
    });

    test("logical operation intents retain payloads and replay results", async () => {
      /** Creates the provider implementation under conformance test. */
      const provider = createProvider(environment, target);
      /** Represents the immutable plan bound to the operation key. */
      const payload = { mutation: { taskId: "task-1" }, schema: "plan-v1" };
      /** Captures the newly persisted operation before completion. */
      const pending = await provider.beginOperationIntent(
        "operation-1",
        "transition",
        payload,
      );
      assert.equal(pending.state, "pending");
      assert.deepEqual(pending.payload, payload);
      assert.deepEqual(
        await provider.beginOperationIntent(
          "operation-1",
          "transition",
          payload,
        ),
        pending,
      );
      await assert.rejects(
        provider.beginOperationIntent("operation-1", "transition", {
          ...payload,
          schema: "changed",
        }),
        /different operation or payload/u,
      );
      /** Captures the applied result later replayed by the provider. */
      const completed = await provider.completeOperationIntent(
        "operation-1",
        "transition",
        payload,
        { targetStatus: "Review" },
      );
      assert.equal(completed.state, "applied");
      assert.deepEqual(
        (await provider.getOperationIntent("operation-1"))?.result,
        { targetStatus: "Review" },
      );
    });

    test("leases are exclusive, expiry-aware, and replayable", async () => {
      /** Tracks the mutable simulated clock or current record state. */
      let current = Date.parse("2026-01-01T00:00:00.000Z");
      /** Provides isolated provider state for the scenario. */
      const provider = createProvider(
        environment,
        target,
        undefined,
        () => new Date(current),
      );
      /** Supplies the operation input under test. */
      const request = {
        expiresAt: "2026-01-01T00:01:00.000Z",
        idempotencyKey: "lease-1",
        ownerId: "run-1",
        scope: "task_assignment" as const,
        agentId: "agent-1",
        taskId: "task-1",
      };
      /** Captures the lease granted by the provider. */
      const acquired = await provider.acquireLease(request);
      assert.equal(acquired.acquired, true);
      assert.deepEqual(await provider.acquireLease(request), acquired);
      assert.equal(
        (
          await provider.acquireLease({
            ...request,
            idempotencyKey: "lease-2",
            ownerId: "run-2",
            agentId: "agent-2",
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
            agentId: "agent-3",
          })
        ).acquired,
        true,
      );
    });

    test("lease renewals replay their original result", async () => {
      /** Provides isolated provider state for the scenario. */
      const provider = createProvider(
        environment,
        target,
        undefined,
        () => new Date("2026-01-01T00:00:00.000Z"),
      );
      /** Captures the lease granted by the provider. */
      const acquired = await provider.acquireLease({
        expiresAt: "2026-01-01T00:01:00.000Z",
        idempotencyKey: "lease-acquire",
        ownerId: "run",
        scope: "agent_run",
        agentId: "agent",
        taskId: null,
      });
      /** Describes the exact lease renewal request replayed by the provider. */
      const renewal = {
        expectedExpiresAt: "2026-01-01T00:01:00.000Z",
        idempotencyKey: "lease-renew",
        leaseId: acquired.leaseId!,
        nextExpiresAt: "2026-01-01T00:02:00.000Z",
        ownerId: "run",
      };
      /** Captures the first operation result for replay comparison. */
      const first = await provider.renewLease(renewal);
      assert.deepEqual(await provider.renewLease(renewal), first);
      assert.equal(
        (await provider.reconcileIntent("lease-renew")).state,
        "applied",
      );
    });

    test("manual lease release requires the exact inspected lease version", async () => {
      /** Tracks the mutable simulated clock or current record state. */
      let current = Date.parse("2026-01-01T00:00:00.000Z");
      /** Provides isolated provider state for the scenario. */
      const provider = createProvider(
        environment,
        target,
        undefined,
        () => new Date(current),
      );
      /** Captures the lease granted by the provider. */
      const acquired = await provider.acquireLease({
        expiresAt: "2026-01-01T00:10:00.000Z",
        idempotencyKey: "manual-acquire",
        ownerId: "owner",
        scope: "agent_run",
        agentId: "worker",
        taskId: null,
      });
      /** Snapshots provider state before the operation. */
      const before = await provider.getLeaseSnapshot(acquired.leaseId!);
      assert.notEqual(before, null);
      current += 1_000;
      await provider.renewLease({
        expectedExpiresAt: "2026-01-01T00:10:00.000Z",
        idempotencyKey: "manual-renew",
        leaseId: acquired.leaseId!,
        nextExpiresAt: "2026-01-01T00:20:00.000Z",
        ownerId: "owner",
      });
      await assert.rejects(
        provider.releaseLease({
          expectedVersion: before!.version,
          leaseId: acquired.leaseId!,
          ownerId: "owner",
        }),
        /release conflict/u,
      );
      /** Snapshots provider state after the operation. */
      const after = await provider.getLeaseSnapshot(acquired.leaseId!);
      assert.notEqual(after, null);
      await provider.releaseLease({
        expectedVersion: after!.version,
        leaseId: acquired.leaseId!,
        ownerId: "owner",
      });
      /** Captures ownership state after the release operation. */
      const released = await provider.getLeaseSnapshot(acquired.leaseId!);
      assert.equal(released?.released, true);
      /** Captures the lease granted after expiry and release. */
      const reacquired = await provider.acquireLease({
        expiresAt: "2026-01-01T00:30:00.000Z",
        idempotencyKey: "manual-reacquire",
        ownerId: "owner",
        scope: "agent_run",
        agentId: "worker",
        taskId: null,
      });
      assert.equal(reacquired.acquired, true);
      assert.equal(await provider.getLeaseSnapshot(acquired.leaseId!), null);
    });

    test("agent activity is conditionally replaced", async () => {
      /** Provides isolated provider state for the scenario. */
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
        schema: "agent-definition-v1",
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
      /** Represents the active Agent run exercised by the scenario. */
      const run = await provider.acquireLease({
        expiresAt: "2099-01-01T00:00:00.000Z",
        idempotencyKey: "activity-run",
        ownerId: "activity-owner",
        scope: "agent_run",
        agentId: "worker",
        taskId: null,
      });
      await provider.acquireLease({
        expiresAt: "2099-01-01T00:00:00.000Z",
        idempotencyKey: "activity-task",
        ownerId: "activity-owner",
        scope: "task_assignment",
        agentId: "worker",
        taskId: "task-1",
      });
      /** Captures the first operation result for replay comparison. */
      const first = {
        expectedRunLeaseIds: [],
        expectedTaskIds: [],
        idempotencyKey: "activity-1",
        nextRunLeaseIds: [run.leaseId!],
        nextTaskIds: ["task-1"],
        agentId: "worker",
      };
      assert.deepEqual(
        await provider.updateAgentActivity(first),
        await provider.updateAgentActivity(first),
      );
      await assert.rejects(
        provider.updateAgentActivity({
          ...first,
          idempotencyKey: "activity-2",
        }),
        /version conflict|active lease projection/,
      );
    });

    test("errors use distinct entity and operation identities", async () => {
      /** Provides isolated provider state for the scenario. */
      const provider = createProvider(environment, target);
      /** Provides the common mutation fields varied by the scenario. */
      const base = {
        description: "description",
        errorKey: "error-1",
        idempotencyKey: "error-write-1",
        relatedRunId: null,
        relatedAgentId: null,
        relatedTaskId: null,
        resolution: "first",
        severity: "medium" as const,
        status: "Not Fixed" as const,
        title: "Error",
      };
      /** Captures the first operation result for replay comparison. */
      const first = await provider.createOrUpdateError(base);
      assert.deepEqual(await provider.createOrUpdateError(base), first);
      /** Captures the replayed result for idempotency comparison. */
      const second = await provider.createOrUpdateError({
        ...base,
        idempotencyKey: "error-write-2",
        resolution: "second",
        status: "Fixing",
      });
      assert.equal(second.providerRecord.id, "error-1");
      assert.notEqual(second.observedVersion, first.observedVersion);
    });

    test("resource pins and read models exclude mutation metadata", async () => {
      /** Provides isolated provider state for the scenario. */
      const provider = createProvider(environment, target);
      /** Describes the provider mutation exercised by the scenario. */
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
      /** Captures the first operation result for replay comparison. */
      const first = await provider.putResource(mutation);
      assert.deepEqual(await provider.putResource(mutation), first);
      /** Captures the Resource read model used as the oracle. */
      const [resource] = await provider.getResources([
        { digest: "digest-2", key: "policy", version: "2" },
      ]);
      assert.equal(Object.hasOwn(resource ?? {}, "idempotencyKey"), false);
      await assert.rejects(
        provider.getResources([
          { digest: "digest-2", key: "policy", version: "1" },
        ]),
        /version mismatch/,
      );
    });

    test("workspace plans converge with verified dependency and digest chains", async () => {
      /** Provides isolated provider state for the scenario. */
      const provider = createProvider(environment, target);
      /** Captures observed state used as the assertion oracle. */
      const observed = await provider.inspectWorkspaceSchema();
      /** Captures the workspace changes proposed by the provider. */
      const plan = await provider.planWorkspaceChanges({
        environmentId: "test",
        mode: "bootstrap",
        observed,
        target,
      });
      assert.ok(plan.steps.length > 1);
      await assert.rejects(
        provider.applyWorkspaceStep(plan.steps[1]!),
        /dependencies/,
      );
      for (const step of plan.steps) await provider.applyWorkspaceStep(step);
      assert.equal((await provider.validateTables()).state, "ready");
      /** Captures the plan recomputed after schema changes. */
      const nextPlan = await provider.planWorkspaceChanges({
        environmentId: "test",
        mode: "migration",
        observed: await provider.inspectWorkspaceSchema(),
        target,
      });
      assert.deepEqual(nextPlan.steps, []);
      assert.equal(
        (await provider.reconcileWorkspaceStep(plan.steps[0]!.id)).state,
        "applied",
      );
    });

    test("workspace planning fails closed for an unverifiable relation target", async () => {
      /** Provides isolated provider state for the scenario. */
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
              {
                name: "Task",
                providerMetadata: {},
                targetTableId: null,
                type: "title",
                writable: true,
              },
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
      /** Captures observed state used as the assertion oracle. */
      const observed = await provider.inspectWorkspaceSchema();
      await assert.rejects(
        provider.planWorkspaceChanges({
          environmentId: "test",
          mode: "bootstrap",
          observed,
          target,
        }),
        /incompatible/,
      );
    });

    test("environment validation reports the supplied provider mismatch", async () => {
      /** Provides isolated provider state for the scenario. */
      const provider = createProvider(environment, target);
      /** Captures validation or dry-run findings used as the oracle. */
      const report = await provider.validateEnvironment({
        ...environment,
        type: "other",
      });
      assert.equal(report.valid, false);
      assert.equal(report.issues[0]?.path, "provider.type");
    });
  });
}

test("CLI help lists only implemented commands", () => {
  /** Resolves the built CLI entry point invoked by the test. */
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  /** Captures the operation outcome used by assertions. */
  const result = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /validate/);
  assert.match(result.stdout, /init --plan/);
  assert.match(result.stdout, /migrate --plan/);
  assert.doesNotMatch(result.stdout, /start|dispatch|tasks eligible/);
});

test("serialized provider emulator rejects lossy non-JSON values", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new SerializedProviderEmulator(
    new InMemoryProvider(environment, target),
  );
  await assert.rejects(
    provider.validateEnvironment({
      ...environment,
      connection: {
        invalid: undefined,
      } as unknown as ProviderEnvironment["connection"],
    }),
    /JSON-compatible/u,
  );
  await assert.rejects(
    provider.getResources(new Array(1)),
    /sparse array hole/u,
  );
  /** Implements broken provider. */
  class BrokenProvider extends InMemoryProvider {
    /** Returns capabilities. */
    public override async getCapabilities(): ReturnType<
      InMemoryProvider["getCapabilities"]
    > {
      return undefined as never;
    }
  }
  await assert.rejects(
    new SerializedProviderEmulator(
      new BrokenProvider(environment, target),
    ).getCapabilities(),
    /JSON-compatible/u,
  );
});
