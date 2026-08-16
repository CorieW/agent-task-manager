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
  type AgentDefinition,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";

/** Defines the shared environment fixture for this test module. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: null, resources: null, agents: null, tasks: null },
  type: "memory",
};

/** Defines the shared target fixture for this test module. */
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

/** Creates an Agent definition fixture. */
function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
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
    schema: "agent-definition-v1",
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
  /** Defines the selector fixture for “typed selection results are closed, digested, and authority checked”. */
  const selector = definition();
  /** Defines the result fixture for “typed selection results are closed, digested, and authority checked”. */
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
    selectorAgentId: "planner",
    targetAgentId: "planner",
    targetAgentRevision: 1,
    taskId: "task-1",
  });
  /** Defines the parsed fixture for “typed selection results are closed, digested, and authority checked”. */
  const parsed = parseTaskSelectionResult(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(parsed, result);
  assert.doesNotThrow(() =>
    assertSelectionAuthority(parsed, selector, selector),
  );
  assert.throws(
    () =>
      assertSelectionAuthority(
        { ...parsed, mode: "explicit" },
        selector,
        selector,
      ),
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
  /** Defines the scheduled fixture for “invocation scheduling is deterministic and capacity-aware”. */
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
  assert.deepEqual(
    scheduled.map((item) => item.id),
    ["high-a", "high-b"],
  );
});

test("foundation dry run plans and schedules without writes", async () => {
  /** Defines the provider fixture for “foundation dry run plans and schedules without writes”. */
  const provider = new InMemoryProvider(environment, target);
  provider.seedDefinition(definition());
  /** Defines the before fixture for “foundation dry run plans and schedules without writes”. */
  const before = await provider.inspectWorkspaceSchema();
  /** Defines the report fixture for “foundation dry run plans and schedules without writes”. */
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
  /** Defines the after fixture for “foundation dry run plans and schedules without writes”. */
  const after = await provider.inspectWorkspaceSchema();
  assert.equal(report.environmentValid, true);
  assert.equal(report.workspaceState, "needs_bootstrap");
  assert.deepEqual(report.scheduledAgentIds, ["planner"]);
  assert.ok((report.migrationPlan?.steps.length ?? 0) > 0);
  assert.deepEqual(after, before);
  assert.equal(
    (await provider.reconcileIntent("dry-run")).state,
    "not_applied",
  );
});

test("foundation dry run honors capacity and does not plan ready workspaces", async () => {
  /** Defines the bootstrap fixture for “foundation dry run honors capacity and does not plan ready workspaces”. */
  const bootstrap = new InMemoryProvider(environment, target);
  /** Defines the initial plan fixture for “foundation dry run honors capacity and does not plan ready workspaces”. */
  const initialPlan = await bootstrap.planWorkspaceChanges({
    environmentId: "phase-1",
    mode: "bootstrap",
    observed: await bootstrap.inspectWorkspaceSchema(),
    target,
  });
  for (const step of initialPlan.steps)
    await bootstrap.applyWorkspaceStep(step);
  bootstrap.seedDefinition(definition());
  /** Defines the report fixture for “foundation dry run honors capacity and does not plan ready workspaces”. */
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
  assert.deepEqual(report.scheduledAgentIds, []);
});

test("pagination and idempotency primitives are deterministic", () => {
  assert.deepEqual(
    pageAfter(["b", "a", "c"], { cursor: "a", limit: 2 }, (item) => item),
    ["b", "c"],
  );
  /** Defines the ledger fixture for “pagination and idempotency primitives are deterministic”. */
  const ledger = new IdempotencyLedger();
  assert.deepEqual(
    ledger.write("key", "operation", { value: 1 }, { receipt: 1 }),
    {
      receipt: 1,
    },
  );
  assert.deepEqual(ledger.read("key", "operation", { value: 1 }), {
    receipt: 1,
  });
  assert.throws(() => ledger.read("key", "operation", { value: 2 }), /reused/);
  assert.throws(
    () => ledger.read("key", "operation", { value: undefined } as never),
    /JSON|compatible|reused/,
  );
});

test("core and domain modules do not import the Notion provider", async () => {
  for (const directory of ["src/core", "src/domain"]) {
    /** Defines the absolute fixture for “core and domain modules do not import the Notion provider”. */
    const absolute = path.join(process.cwd(), directory);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      /** Defines the source fixture for “core and domain modules do not import the Notion provider”. */
      const source = await readFile(path.join(absolute, entry.name), "utf8");
      /** Defines the imports fixture for “core and domain modules do not import the Notion provider”. */
      const imports = source.match(/^import .*$/gmu) ?? [];
      assert.equal(
        imports.some((statement) => /notion/iu.test(statement)),
        false,
        `${directory}/${entry.name} imports Notion`,
      );
    }
  }
});
