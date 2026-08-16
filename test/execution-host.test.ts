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
import {
  runExplicitAgentTask,
  type AgentExecutionBindings,
} from "../src/host/execution-host.js";
import { materializeAgentContexts } from "../src/host/agent-context.js";
import { finalizeRequest } from "../src/effects/external-effect-broker.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";
import {
  NoToolAgentRunnerAdapter,
  NoToolIsolationAdapter,
  NoToolModelTransportAdapter,
  type NoToolModelClient,
} from "../src/runtime/no-tool-adapters.js";
import {
  RuntimeAdapterRegistry,
  type AgentRunnerAdapter,
  type ModelTransportAdapter,
  type ToolIsolationAdapter,
} from "../src/runtime/adapters.js";
import {
  finalizeAgentResult,
  type AgentResultCore,
  type RunContext,
} from "../src/runtime/contracts.js";
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
  const provider = await executionProvider();
  /** Parsed runtime environment supplied to the execution request. */
  const config = environmentConfig();
  /** Counts model invocations across the initial run and terminal replay. */
  let modelCalls = 0;
  /** Registered no-tool model adapter returning one schema-valid result. */
  const model = new NoToolModelTransportAdapter(
    "no-tool-model",
    {
      /** Streams one result bound to the supplied immutable context. */
      async *stream({ context }) {
        modelCalls += 1;
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
  /** Counts cleanup calls across the initial run and terminal replay. */
  let closeCalls = 0;
  /** Trusted bindings used by both invocations of the same logical run. */
  const bindings: AgentExecutionBindings = {
    activationRuntime,
    /** Records release of host-owned resources after each invocation. */
    async close() {
      closeCalls += 1;
    },
    /** Confirms the no-intent result requires no external effect execution. */
    async executeEffects({ result }) {
      assert.deepEqual(result.proposedIntents, []);
      return [];
    },
    /** Supplies the exact resolved runtime for dispatch. */
    async prepare() {
      return { additionalInput: { source: "test" }, runtime };
    },
  };
  /** Stable request reused to exercise exact terminal replay. */
  const request = {
    agentId: "worker",
    assignmentDepth: 0,
    config,
    expiresAt: "2099-01-01T00:00:00.000Z",
    operationKey: "test-run-1",
    provider,
    taskId: "task-1",
  };

  /** Terminal execution report returned after the Task transition. */
  const report = await runExplicitAgentTask({ bindings, request });
  assert.equal(report.outcome, "succeeded");
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Done");
  assert.deepEqual(await provider.getLeaseProjection("worker"), {
    runLeaseIds: [],
    taskIds: [],
    taskLeaseIds: [],
  });
  assert.equal((await provider.getAgentActivity("worker")).status, "Offline");
  /** Replayed report loaded after the Task and leases have already advanced. */
  const replay = await runExplicitAgentTask({ bindings, request });
  assert.deepEqual(replay, report);
  assert.equal(modelCalls, 1);
  assert.equal(closeCalls, 2);
});

test("materializes Agent contexts idempotently", async () => {
  /** Isolated provider containing the parent Agent, Task, and Resource graph. */
  const provider = await executionProvider();
  /** Activated parent reused as the sole deterministic child target. */
  const activated = await activateDefinitions({
    ...activationRuntime,
    definitionIds: ["worker"],
    provider,
  });
  assert.ok(activated[0]);

  /** First deterministic child-context catalog. */
  const firstCatalog = await materializeAgentContexts({
    assignmentDepth: 0,
    parent: activated[0],
    parentRunId: "run-context-test",
    provider,
    targets: activated,
    task: await provider.getTaskSnapshot("task-1"),
  });
  /** Replayed catalog for the identical parent, target, and Task snapshot. */
  const replayedCatalog = await materializeAgentContexts({
    assignmentDepth: 0,
    parent: activated[0],
    parentRunId: "run-context-test",
    provider,
    targets: activated,
    task: await provider.getTaskSnapshot("task-1"),
  });

  assert.deepEqual(replayedCatalog, firstCatalog);
});

test("closes trusted bindings when request validation fails", async () => {
  /** Provider that must remain untouched by malformed request handling. */
  const provider = new InMemoryProvider(providerEnvironment, schema);
  /** Counts the one cleanup attempt owned by the public execution API. */
  let closeCalls = 0;
  await assert.rejects(
    runExplicitAgentTask({
      bindings: {
        activationRuntime,
        /** Records cleanup even though validation rejects before provider access. */
        async close() {
          closeCalls += 1;
        },
        /** Must remain unreachable for a malformed request. */
        async executeEffects() {
          throw new Error("unreachable");
        },
        /** Must remain unreachable for a malformed request. */
        async prepare() {
          throw new Error("unreachable");
        },
      },
      request: {
        agentId: "",
        assignmentDepth: 0,
        config: environmentConfig(),
        expiresAt: "2099-01-01T00:00:00.000Z",
        operationKey: "invalid-run",
        provider,
        taskId: "task-1",
      },
    }),
    /Agent ID is required/u,
  );
  assert.equal(closeCalls, 1);
});

test("rejects an applied effect that is not bound to the exact Agent intent", async () => {
  /** Agent whose result is permitted to propose the test effect. */
  const definition = { ...agentDefinition(), allowedIntents: ["test.effect"] };
  /** Isolated provider containing the effect-capable Agent and Task. */
  const provider = await executionProvider(definition);
  /** Trusted environment used by the effect-correlation scenario. */
  const config = environmentConfig();
  /** Runtime result proposing one exact payload. */
  const model = modelAdapter((context) => ({
    contextDigest: context.digest,
    definitionDigest: context.definitionDigest,
    outcome: "succeeded",
    payload: { summary: "complete" },
    proposedIntents: [{ kind: "test.effect", payload: { value: "expected" } }],
    runId: context.runId,
    schema: "agent-result-v1" as const,
  }));
  /** Runtime capability set that installs the proposed effect kind. */
  const effectRuntime = {
    ...activationRuntime,
    installedIntents: ["test.effect"],
  };
  /** Resolved no-tool runtime used for the single dispatch. */
  const runtime = runtimeEnvironment(config, model);

  await assert.rejects(
    runExplicitAgentTask({
      bindings: {
        activationRuntime: effectRuntime,
        /** Returns an applied execution for a deliberately different payload. */
        async executeEffects({ result }) {
          /** Canonical wrong-payload request used to test correlation rejection. */
          const request = finalizeRequest({
            kind: "test.effect",
            payload: { value: "wrong" },
            source: {
              contextDigest: result.contextDigest,
              definitionDigest: result.definitionDigest,
              intentIndex: 0,
              resultDigest: result.digest,
              runId: result.runId,
            },
          });
          return [
            {
              receipt: {
                effectId: request.effectId,
                evidence: {},
                externalIdentity: {},
                handlerId: "test-handler",
                handlerVersion: "1",
                schema: "external-effect-receipt-v1" as const,
                state: "applied" as const,
              },
              request,
              state: "applied" as const,
            },
          ];
        },
        /** Supplies the resolved runtime for the correlation scenario. */
        async prepare() {
          return { additionalInput: {}, runtime };
        },
      },
      request: executionRequest(provider, config, "wrong-effect"),
    }),
    /does not match the Agent result/u,
  );
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Ready");
});

test("rejects a result when the promoted Task changes before outcome routing", async () => {
  /** Isolated provider whose Task is mutated from the effect callback. */
  const provider = await executionProvider();
  /** Trusted environment used by the stale-result scenario. */
  const config = environmentConfig();
  /** Runtime result that would normally route the Task to Done. */
  const model = modelAdapter((context) => ({
    contextDigest: context.digest,
    definitionDigest: context.definitionDigest,
    outcome: "succeeded",
    payload: { summary: "complete" },
    proposedIntents: [],
    runId: context.runId,
    schema: "agent-result-v1" as const,
  }));
  /** Resolved no-tool runtime used for dispatch. */
  const runtime = runtimeEnvironment(config, model);

  await assert.rejects(
    runExplicitAgentTask({
      bindings: {
        activationRuntime,
        /** Simulates a concurrent human edit after dispatch but before routing. */
        async executeEffects() {
          /** Live Task snapshot used as the expected version for the human edit. */
          const task = await provider.getTaskSnapshot("task-1");
          await provider.applyTaskMutation({
            expectedVersion: task.version,
            idempotencyKey: "concurrent-human-edit",
            nextBody: `${task.body}\n\nHuman clarification`,
            nextProperties: task.properties,
            nextStatus: null,
            taskId: task.id,
          });
          return [];
        },
        /** Supplies the resolved runtime before the concurrent edit is injected. */
        async prepare() {
          return { additionalInput: {}, runtime };
        },
      },
      request: executionRequest(provider, config, "stale-task"),
    }),
    /Assigned Task changed after selection/u,
  );
  /** Task state retained after stale Agent output is rejected. */
  const task = await provider.getTaskSnapshot("task-1");
  assert.equal(task.status, "Ready");
  assert.match(task.body, /Human clarification/u);
});

test("resumes cleanup after one assignment lease was already released", async () => {
  /** Isolated provider whose second release fails once after outcome persistence. */
  const provider = await executionProvider();
  /** Trusted environment shared by the interrupted attempt and retry. */
  const config = environmentConfig();
  /** Counts model dispatches across the resumed logical operation. */
  let modelCalls = 0;
  /** Model adapter whose output must be checkpointed before cleanup fails. */
  const model = new NoToolModelTransportAdapter(
    "no-tool-model",
    {
      /** Streams the one result that must survive the cleanup interruption. */
      async *stream({ context }) {
        modelCalls += 1;
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
    sha256("cleanup-model"),
  );
  /** Runtime resolved once for both attempts. */
  const runtime = runtimeEnvironment(config, model);
  /** Retains the provider's real release implementation beneath fault injection. */
  const release = provider.releaseLease.bind(provider);
  /** Counts release calls so only the second lease fails once. */
  let releaseCalls = 0;
  provider.releaseLease = async (request) => {
    releaseCalls += 1;
    if (releaseCalls === 2) throw new Error("simulated cleanup interruption");
    return release(request);
  };
  /** Bindings reused by the exact logical retry. */
  const bindings: AgentExecutionBindings = {
    activationRuntime,
    /** Confirms the checkpointed result has no proposed effects. */
    async executeEffects() {
      return [];
    },
    /** Supplies the same runtime to the initial attempt and retry. */
    async prepare() {
      return { additionalInput: {}, runtime };
    },
  };
  /** Stable request reused after the first lease release. */
  const request = executionRequest(provider, config, "cleanup-resume");

  await assert.rejects(
    runExplicitAgentTask({ bindings, request }),
    /simulated cleanup interruption/u,
  );
  /** Terminal report produced by resuming after the first lease release. */
  const report = await runExplicitAgentTask({ bindings, request });
  assert.equal(report.outcome, "succeeded");
  assert.equal(modelCalls, 1);
  assert.deepEqual(await provider.getLeaseProjection("worker"), {
    runLeaseIds: [],
    taskIds: [],
    taskLeaseIds: [],
  });
});

/** Parses the trusted no-tool environment shared by execution-host tests. */
function environmentConfig(): ReturnType<typeof parseEnvironmentConfig> {
  return parseEnvironmentConfig(
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
}

/** Seeds one executable Agent, its Resources, and one Ready Task. */
async function executionProvider(
  definition: AgentDefinition = agentDefinition(),
): Promise<InMemoryProvider> {
  /** Fresh provider preventing execution state from leaking between tests. */
  const provider = new InMemoryProvider(providerEnvironment, schema);
  provider.seedDefinition(definition);
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
  return provider;
}

/** Builds a no-tool model adapter from one context-bound result factory. */
function modelAdapter(
  result: (context: RunContext) => AgentResultCore,
): NoToolModelTransportAdapter {
  /** Minimal client that binds the supplied result factory to each run context. */
  const client: NoToolModelClient = {
    /** Streams one finalized result for the immutable context. */
    async *stream({ context }) {
      yield JSON.stringify(finalizeAgentResult(result(context)));
    },
  };
  return new NoToolModelTransportAdapter(
    "no-tool-model",
    client,
    sha256("test-model-client"),
  );
}

/** Builds the standard explicit execution request for a test operation. */
function executionRequest(
  provider: InMemoryProvider,
  config: ReturnType<typeof parseEnvironmentConfig>,
  operationKey: string,
) {
  return {
    agentId: "worker",
    assignmentDepth: 0,
    config,
    expiresAt: "2099-01-01T00:00:00.000Z",
    operationKey,
    provider,
    taskId: "task-1",
  };
}

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
      acceptsAssignmentsFrom: ["coordinator", "explicit"],
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
