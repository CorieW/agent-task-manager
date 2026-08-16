/** Verifies the explicit execution host from assignment through outcome routing and lease cleanup. */
import assert from "node:assert/strict";
import test from "node:test";

import { parseEnvironmentConfig } from "../src/config/environment.js";
import { activateDefinitions } from "../src/core/definition-activation.js";
import { sha256 } from "../src/core/digest.js";
import type { ActivationRuntime } from "../src/core/selection-coordinator.js";
import type {
  AgentDefinition,
  ResourceMutation,
} from "../src/domain/records.js";
import type { ProviderEnvironment } from "../src/domain/provider.js";
import { toJsonValue } from "../src/domain/json.js";
import type { WorkspaceSchemaDescriptor } from "../src/domain/schema.js";
import { runExplicitAgentTask } from "../src/host/execution-host.js";
import { materializeAgentContexts } from "../src/host/agent-context.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";
import {
  NoToolAgentRunnerAdapter,
  NoToolIsolationAdapter,
  NoToolModelTransportAdapter,
} from "../src/runtime/no-tool-adapters.js";
import {
  RuntimeAdapterRegistry,
  type AgentRunnerAdapter,
  type ModelTransportAdapter,
  type ToolIsolationAdapter,
} from "../src/runtime/adapters.js";
import { finalizeAgentResult } from "../src/runtime/contracts.js";
import { resolveRuntimeEnvironment } from "../src/runtime/environment.js";

/** Provider environment used by the execution-host fixture. */
const providerEnvironment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { agents: "a", errors: "e", resources: "r", tasks: "t" },
  type: "memory",
};

/** Minimal provider schema descriptor used by the in-memory fixture. */
const schema: WorkspaceSchemaDescriptor = {
  digest: "schema",
  providerType: "memory",
  tables: [],
  version: "v1",
};

/** Runtime features installed by the concrete no-tool test host. */
const activationRuntime: ActivationRuntime = {
  installedCapabilities: [],
  installedIntents: [],
  installedRunnerProfiles: ["no-tools"],
  supportedModels: { model: ["medium"] },
};

test("runs an explicit Agent through effects, outcome routing, and cleanup", async () => {
  /** Isolated provider containing one eligible Task and Agent. */
  const provider = new InMemoryProvider(providerEnvironment, schema);
  provider.seedDefinition(agentDefinition());
  provider.seedTaskStatusOptions(["Done", "Ready"]);
  provider.seedTask({
    archived: false,
    body: "Do the bounded work.",
    dependencies: [],
    id: "task-1",
    priority: 1,
    properties: { Status: "Ready" },
    status: "Ready",
    title: "Task 001",
    version: "task-v1",
  });
  for (const record of resources()) await provider.putResource(record);
  /** Parsed runtime environment supplied to the execution request. */
  const config = parseEnvironmentConfig(
    toJsonValue({
      adapters: {
        agentRunner: "no-tool-runner",
        modelTransport: "no-tool-model",
        publication: null,
        sandbox: "no-tool-isolation",
      },
      environmentId: "test",
      provider: providerEnvironment,
      runtime: {
        allowedEnvironmentNames: [],
        allowedNetworkOrigins: [],
        allowedReadRoots: [],
        allowedWriteRoots: [],
        concurrencyMode: "single-host",
        outputLimitBytes: 100_000,
        postKillReapMilliseconds: 100,
        root: "A:/AgentTaskManager/test",
        terminationGraceMilliseconds: 10,
      },
      schema: "agent-task-manager-environment-v1",
    }),
  );
  /** Registered no-tool model adapter returning one schema-valid result. */
  const model = new NoToolModelTransportAdapter(
    "no-tool-model",
    {
      /** Streams one result bound to the supplied immutable context. */
      async *stream({ context }) {
        yield JSON.stringify(
          finalizeAgentResult({
            contextDigest: context.digest,
            definitionDigest: context.definitionDigest,
            outcome: "succeeded",
            payload: { summary: "complete" },
            proposedIntents: [],
            runId: context.runId,
            schema: "agent-result-v1",
          }),
        );
      },
    },
    sha256("test-model-client"),
  );
  /** Runtime resolved from the exact adapters named by configuration. */
  const runtime = runtimeEnvironment(config, model);
  /** Activated worker reused as a deterministic child-context fixture. */
  const activated = await activateDefinitions({
    ...activationRuntime,
    definitionIds: ["worker"],
    provider,
  });
  assert.ok(activated[0]);
  /** First deterministic child-context catalog. */
  const firstCatalog = await materializeAgentContexts({
    parent: activated[0],
    provider,
    targets: activated,
    task: await provider.getTaskSnapshot("task-1"),
  });
  /** Replayed catalog proving idempotent context materialization. */
  const replayedCatalog = await materializeAgentContexts({
    parent: activated[0],
    provider,
    targets: activated,
    task: await provider.getTaskSnapshot("task-1"),
  });
  assert.deepEqual(replayedCatalog, firstCatalog);
  /** Terminal execution report returned after the Task transition. */
  const report = await runExplicitAgentTask({
    bindings: {
      activationRuntime,
      async executeEffects({ result }) {
        assert.deepEqual(result.proposedIntents, []);
        return [];
      },
      async prepare() {
        return { additionalInput: { source: "test" }, runtime };
      },
    },
    request: {
      agentId: "worker",
      assignmentDepth: 0,
      config,
      expiresAt: "2099-01-01T00:00:00.000Z",
      operationKey: "test-run-1",
      provider,
      taskId: "task-1",
    },
  });
  assert.equal(report.outcome, "succeeded");
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Done");
  assert.deepEqual(await provider.getLeaseProjection("worker"), {
    runLeaseIds: [],
    taskIds: [],
    taskLeaseIds: [],
  });
  assert.equal((await provider.getAgentActivity("worker")).status, "Offline");
});

/** Resolves the no-tool runtime used by the execution-host fixture. */
function runtimeEnvironment(
  config: ReturnType<typeof parseEnvironmentConfig>,
  model: ModelTransportAdapter,
) {
  /** Registry containing the selected runner. */
  const runners = new RuntimeAdapterRegistry<AgentRunnerAdapter>();
  /** Registry containing the selected model transport. */
  const models = new RuntimeAdapterRegistry<ModelTransportAdapter>();
  /** Registry containing the selected isolation adapter. */
  const isolations = new RuntimeAdapterRegistry<ToolIsolationAdapter>();
  runners.register(
    new NoToolAgentRunnerAdapter(
      "no-tool-runner",
      sha256("no-tool-runner"),
      "1.0.0",
    ),
  );
  models.register(model);
  isolations.register(new NoToolIsolationAdapter("no-tool-isolation"));
  return resolveRuntimeEnvironment({
    config,
    modelTransports: models,
    runners,
    toolIsolations: isolations,
  });
}

/** Agent definition assigned by the execution-host fixture. */
function agentDefinition(): AgentDefinition {
  return {
    allowedIntents: [],
    capabilities: [],
    contextBudgetBytes: 100_000,
    deadlineSeconds: 60,
    enabled: true,
    humanResolutionOutcomes: [],
    id: "worker",
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    maxAssignmentDepth: 1,
    maxAssignmentsPerRun: 1,
    maxConcurrency: 1,
    model: "model",
    name: "Worker",
    outputSchema: "schema/output",
    priority: 1,
    prohibitedCapabilities: [],
    promptResources: ["prompt/worker"],
    reasoning: "medium",
    requiredProviderCapabilities: [],
    retry: { maxAttempts: 1, noVerdict: "block" },
    revision: 1,
    runnerProfile: "no-tools",
    schema: "agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: ["explicit"],
      maxCandidateSummaries: 1,
      mode: "explicit",
      resultSchema: "schema/selection",
      taskQueryResource: "query/worker",
    },
    transitions: { succeeded: "Done" },
  };
}

/** Resource graph resolved into the test Agent context. */
function resources(): readonly ResourceMutation[] {
  return [
    resource("prompt/worker", "prompt", "Complete the assigned Task."),
    resource(
      "query/worker",
      "task-query",
      JSON.stringify({
        dependencySatisfiedStatuses: ["Done"],
        limit: 1,
        predicate: { status: "Ready" },
        schema: "task-query-v1",
      }),
    ),
    resource("schema/selection", "json-schema", closedSchema({})),
    resource(
      "schema/output",
      "json-schema",
      closedSchema({ summary: { minLength: 1, type: "string" } }, ["summary"]),
    ),
  ];
}

/** Builds one active Resource mutation with a body-bound digest. */
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

/** Returns the closed JSON Schema used by a fixture Resource. */
function closedSchema(properties: object, required: string[] = []): string {
  return JSON.stringify({
    additionalProperties: false,
    properties,
    required,
    type: "object",
  });
}
