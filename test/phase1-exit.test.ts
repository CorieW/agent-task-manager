/** Verifies provider-neutral selection, scheduling, pagination, idempotency, architecture, and the read-only foundation dry run. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  assertSelectionAuthority,
  finalizeTaskSelectionResult,
  IdempotencyLedger,
  InMemoryProvider,
  pageAfter,
  parseTaskSelectionResult,
  runFoundationDryRun,
  scheduleInvocations,
  type ProviderEnvironment,
  type SubAgentDefinition,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";

const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: null, resources: null, subAgents: null, tasks: null },
  type: "memory",
};

const target: WorkspaceSchemaDescriptor = {
  digest: "phase-1-target",
  providerType: "memory",
  tables: [
    {
      kind: "tasks",
      managedRanges: [],
      properties: [
        {
          logicalName: "title",
          physicalName: "Task",
          required: true,
          targetTable: null,
          type: "title",
          writable: true,
        },
      ],
      title: "Tasks",
    },
  ],
  version: "1",
};

function definition(overrides: Partial<SubAgentDefinition> = {}): SubAgentDefinition {
  return {
    allowedIntents: [],
    capabilities: [],
    maxConcurrency: 1,
    maxAssignmentsPerRun: 1,
    contextBudgetBytes: 100_000,
    deadlineSeconds: 300,
    enabled: true,
    humanResolutionOutcomes: [],
    id: "planner",
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    priority: 10,
    maxAssignmentDepth: 1,
    model: "model",
    name: "Planner",
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
      maxCandidateSummaries: 10,
      mode: "self",
      resultSchema: "schema/task-selection-result-v1",
      taskQueryResource: "query/planner",
    },
    transitions: { succeeded: "$current" },
    outputSchema: "schema/planner-result-v1",
    ...overrides,
  };
}

test("typed selection results are closed, digested, and authority checked", () => {
  const selector = definition();
  const result = finalizeTaskSelectionResult({
    candidateSetDigest: "candidates",
    idempotencyKey: "selection-1",
    mode: "self",
    outcome: "assignment",
    rationaleDigest: "reason",
    schema: "task-selection-result-v1",
    selectionBasisDigest: "basis",
    selectorRevision: 1,
    selectorRunId: "run-1",
    selectorSubAgentId: "planner",
    targetSubAgentId: "planner",
    targetSubAgentRevision: 1,
    taskId: "task-1",
  });
  const parsed = parseTaskSelectionResult(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(parsed, result);
  assert.doesNotThrow(() => assertSelectionAuthority(parsed, selector, selector));
  assert.throws(
    () => assertSelectionAuthority({ ...parsed, mode: "explicit" }, selector, selector),
    /mode/,
  );
  assert.throws(
    () => parseTaskSelectionResult({ ...result, unexpected: true }),
    /unknown or missing fields/,
  );
  assert.throws(
    () => parseTaskSelectionResult({ ...result, digest: "wrong" }),
    /digest/,
  );
});

test("invocation scheduling is deterministic and capacity-aware", () => {
  const scheduled = scheduleInvocations({
    activeRuns: { busy: 1 },
    definitions: [
      definition({ id: "low", priority: 1 }),
      definition({ id: "high-b", priority: 5 }),
      definition({ id: "high-a", priority: 5 }),
      definition({ id: "busy", priority: 99 }),
      definition({ enabled: false, id: "disabled", priority: 100 }),
    ],
    dueScheduledDefinitionIds: [],
    limit: 2,
    source: "manual",
  });
  assert.deepEqual(scheduled.map((item) => item.id), ["high-a", "high-b"]);
});

test("foundation dry run plans and schedules without writes", async () => {
  const provider = new InMemoryProvider(environment, target);
  provider.seedDefinition(definition());
  const before = await provider.inspectWorkspaceSchema();
  const report = await runFoundationDryRun({
    activeRuns: {},
    dueScheduledDefinitionIds: [],
    environment,
    environmentId: "phase-1",
    provider,
    invocationSource: "manual",
    scheduleLimit: 1,
    target,
  });
  const after = await provider.inspectWorkspaceSchema();
  assert.equal(report.environmentValid, true);
  assert.equal(report.workspaceState, "needs_bootstrap");
  assert.deepEqual(report.scheduledSubAgentIds, ["planner"]);
  assert.ok((report.migrationPlan?.steps.length ?? 0) > 0);
  assert.deepEqual(after, before);
  assert.equal((await provider.reconcileIntent("dry-run")).state, "not_applied");
});

test("foundation dry run honors capacity and does not plan ready workspaces", async () => {
  const bootstrap = new InMemoryProvider(environment, target);
  const initialPlan = await bootstrap.planWorkspaceChanges({
    environmentId: "phase-1",
    mode: "bootstrap",
    observed: await bootstrap.inspectWorkspaceSchema(),
    target,
  });
  for (const step of initialPlan.steps) await bootstrap.applyWorkspaceStep(step);
  bootstrap.seedDefinition(definition());
  const report = await runFoundationDryRun({
    activeRuns: { planner: 1 },
    dueScheduledDefinitionIds: [],
    environment,
    environmentId: "phase-1",
    provider: bootstrap,
    invocationSource: "manual",
    scheduleLimit: 1,
    target,
  });
  assert.equal(report.workspaceState, "ready");
  assert.equal(report.migrationPlan, null);
  assert.deepEqual(report.scheduledSubAgentIds, []);
});

test("pagination and idempotency primitives are deterministic", () => {
  assert.deepEqual(pageAfter(["b", "a", "c"], { cursor: "a", limit: 2 }, (item) => item), [
    "b",
    "c",
  ]);
  const ledger = new IdempotencyLedger();
  assert.deepEqual(ledger.write("key", "operation", { value: 1 }, { receipt: 1 }), {
    receipt: 1,
  });
  assert.deepEqual(ledger.read("key", "operation", { value: 1 }), { receipt: 1 });
  assert.throws(() => ledger.read("key", "operation", { value: 2 }), /reused/);
  assert.throws(
    () => ledger.read("key", "operation", { value: undefined } as never),
    /JSON|compatible|reused/,
  );
});

test("core and domain modules do not import the Notion provider", async () => {
  for (const directory of ["src/core", "src/domain"]) {
    const absolute = path.join(process.cwd(), directory);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = await readFile(path.join(absolute, entry.name), "utf8");
      const imports = source.match(/^import .*$/gmu) ?? [];
      assert.equal(
        imports.some((statement) => /notion/iu.test(statement)),
        false,
        `${directory}/${entry.name} imports Notion`,
      );
    }
  }
});
