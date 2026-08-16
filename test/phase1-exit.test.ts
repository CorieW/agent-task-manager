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

/** Supplies the provider environment shared by the scenarios. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: null, resources: null, agents: null, tasks: null },
  type: "memory",
};

/** Supplies the canonical workspace schema target. */
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
  /** Supplies the coordinator definition authorized to select work. */
  const selector = definition();
  /** Captures the operation outcome used by assertions. */
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
  /** Captures the validated contract produced by the parser. */
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
  /** Captures the deterministic invocation schedule. */
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
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  provider.seedDefinition(definition());
  /** Snapshots provider state before the operation. */
  const before = await provider.inspectWorkspaceSchema();
  /** Captures validation or dry-run findings used as the oracle. */
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
  /** Snapshots provider state after the operation. */
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
  /** Runs the bootstrap workflow exercised by the dry run. */
  const bootstrap = new InMemoryProvider(environment, target);
  /** Captures the bootstrap plan before the dry run. */
  const initialPlan = await bootstrap.planWorkspaceChanges({
    environmentId: "phase-1",
    mode: "bootstrap",
    observed: await bootstrap.inspectWorkspaceSchema(),
    target,
  });
  for (const step of initialPlan.steps)
    await bootstrap.applyWorkspaceStep(step);
  bootstrap.seedDefinition(definition());
  /** Captures validation or dry-run findings used as the oracle. */
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
  /** Records idempotency results for deterministic replay checks. */
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
    /** Resolves the repository path used by the import-boundary check. */
    const absolute = path.join(process.cwd(), directory);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      /** Reads source text for the import-boundary check. */
      const source = await readFile(path.join(absolute, entry.name), "utf8");
      /** Collects source imports checked for provider coupling. */
      const imports = source.match(/^import .*$/gmu) ?? [];
      assert.equal(
        imports.some((statement) => /notion/iu.test(statement)),
        false,
        `${directory}/${entry.name} imports Notion`,
      );
    }
  }
});
