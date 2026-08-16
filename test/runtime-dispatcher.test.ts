/** Verifies assignment-bound dispatch, strict contracts, streaming limits, and cleanup. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  activateDefinitions,
  assertSupportedJsonSchema,
  digestJson,
  dispatchActivatedAgent,
  finalizeAgentResult,
  finalizeExplicitAssignment,
  InMemoryProvider,
  NoToolAgentRunnerAdapter,
  NoToolIsolationAdapter,
  NoToolModelTransportAdapter,
  parseEnvironmentConfig,
  prepareSelection,
  promoteExplicitAssignment,
  resolveRuntimeEnvironment,
  RuntimeAdapterRegistry,
  sha256,
  superviseProcess,
  toJsonValue,
  type ActivatedDefinition,
  type ActivationRuntime,
  type AgentProcessCompletion,
  type AgentRunnerAdapter,
  type AssignmentPromotion,
  type ErrorMutation,
  type ModelTransportAdapter,
  type ProviderEnvironment,
  type ResourceMutation,
  type ResolvedRuntimeEnvironment,
  type AgentDefinition,
  type SupervisedAgentProcess,
  type ToolIsolationAdapter,
  type ToolIsolationPolicy,
  type WorkspaceSchemaDescriptor,
  type WriteReceipt,
} from "../src/index.js";

/** Supplies the provider environment shared by the scenarios. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: "e", resources: "r", agents: "a", tasks: "t" },
  type: "memory",
};

/** Supplies the canonical workspace schema target. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};

/** Provides deterministic adapter metadata for definition activation. */
const activationRuntime: ActivationRuntime = {
  installedCapabilities: ["repository.read"],
  installedIntents: ["task.note"],
  installedRunnerProfiles: ["read-only"],
  supportedModels: { model: ["medium"] },
};

/** Implements recording provider. */
class RecordingProvider extends InMemoryProvider {
  /** Captures provider Errors created while dispatching an Agent. */
  public readonly errors: ErrorMutation[] = [];
  /** Creates or updates the Error identified by Error Key. */
  public override async createOrUpdateError(
    error: ErrorMutation,
  ): Promise<WriteReceipt> {
    this.errors.push(structuredClone(error));
    return super.createOrUpdateError(error);
  }
}

test("dispatches only from a live assignment through environment-bound adapters", async () => {
  /** Provides an assigned run ready for dispatch. */
  const prepared = await preparedDispatch("run-1");
  /** Captures the isolation policy received by the runner. */
  const observedPolicy: {
    /** Captures the isolation policy observed by the runner. */
    value: ToolIsolationPolicy | null;
  } = { value: null };
  /** Simulates Agent execution for the dispatch scenario. */
  const runner = resultRunner(({ context }) =>
    finalizeAgentResult({
      contextDigest: context.digest,
      definitionDigest: context.definitionDigest,
      outcome: "succeeded",
      payload: { summary: "checked" },
      proposedIntents: [{ kind: "task.note", payload: { text: "done" } }],
      runId: context.runId,
      schema: "agent-result-v1",
    }),
  );
  /** Provides the effect or dispatch runtime exercised by the scenario. */
  const runtime = runtimeEnvironment(runner, undefined, (policy) => {
    observedPolicy.value = policy;
  });
  /** Captures the completed dispatch used for assertions. */
  const dispatched = await dispatchActivatedAgent({
    activated: prepared.activated,
    activationRuntime,
    additionalInput: { request: "inspect" },
    promotion: prepared.promotion,
    provider: prepared.provider,
    runtime,
  });
  assert.equal(dispatched.result.payload.summary, "checked");
  assert.match(dispatched.contextDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(observedPolicy.value?.allowedReadRoots, [
    "A:\\Projects\\Projects\\Ongoing\\agent-task-manager",
  ]);
  assert.deepEqual(observedPolicy.value?.allowedWriteRoots, []);
  assert.deepEqual(prepared.provider.errors, []);
});

test("rejects an outcome that omits its required ordered intent sequence", async () => {
  /** Requires a task-note intent before the success transition. */
  const definition: AgentDefinition = {
    ...agentDefinition(),
    requiredIntentSequenceByOutcome: {
      succeeded: ["task.note"],
    },
    schema: "agent-definition-v1",
  };
  /** Provides an assigned run using the stricter definition. */
  const prepared = await preparedDispatch("run-required-intent", definition);
  /** Returns a success result without the required task-note intent. */
  const runner = resultRunner(({ context }) =>
    finalizeAgentResult({
      contextDigest: context.digest,
      definitionDigest: context.definitionDigest,
      outcome: "succeeded",
      payload: { summary: "checked" },
      proposedIntents: [],
      runId: context.runId,
      schema: "agent-result-v1",
    }),
  );

  await assert.rejects(
    dispatchActivatedAgent({
      activated: prepared.activated,
      activationRuntime,
      additionalInput: {},
      promotion: prepared.promotion,
      provider: prepared.provider,
      runtime: runtimeEnvironment(runner),
    }),
    /missing its required ordered intent sequence/u,
  );
});

test("rejects fabricated isolation receipts and closes prepared sessions", async () => {
  /** Provides an assigned run ready for dispatch. */
  const prepared = await preparedDispatch("run-bad-receipt");
  /** Counts model-session cleanup calls. */
  let modelClosed = 0;
  /** Counts isolation-session cleanup calls. */
  let isolationClosed = 0;
  /** Simulates the configured model transport. */
  const model = modelAdapter(() => {
    modelClosed += 1;
  });
  /** Returns a forged isolation receipt for rejection testing. */
  const badIsolation: ToolIsolationAdapter = {
    id: "isolation",
    /** Creates a prepared adapter session. */
    async prepare(policy) {
      return {
        /** Closes the simulated adapter session. */
        async close() {
          isolationClosed += 1;
        },
        opaqueHandle: {},
        receipt: {
          adapterId: "other",
          environmentDigest: sha256("env"),
          filesystemPolicyDigest: sha256("fs"),
          networkPolicyDigest: sha256("net"),
          policyDigest: digestJson(toJsonValue(policy)),
          processTreeEnforced: true,
          runId: policy.runId,
        },
      };
    },
  };
  await assert.rejects(
    dispatchActivatedAgent({
      activated: prepared.activated,
      activationRuntime,
      additionalInput: {},
      promotion: prepared.promotion,
      provider: prepared.provider,
      runtime: runtimeEnvironment(
        resultRunner(() => {
          throw new Error("unreachable");
        }),
        badIsolation,
        undefined,
        model,
      ),
    }),
    /does not prove the configured policy boundary/,
  );
  assert.equal(modelClosed, 1);
  assert.equal(isolationClosed, 1);
  assert.equal(
    prepared.provider.errors[0]?.description.includes("other"),
    false,
  );
});

test("blocks unauthorized tool activity without retrying", async () => {
  /** Provides an assigned run ready for dispatch. */
  const prepared = await preparedDispatch("run-violation");
  /** Counts runner start attempts to prove violations are not retried. */
  let starts = 0;
  /** Simulates Agent execution for the dispatch scenario. */
  const runner = resultRunner(() => {
    starts += 1;
    return {};
  }, "write_outside_root");
  await assert.rejects(
    dispatchActivatedAgent({
      activated: prepared.activated,
      activationRuntime,
      additionalInput: {},
      promotion: prepared.promotion,
      provider: prepared.provider,
      runtime: runtimeEnvironment(runner),
    }),
    /unauthorized tool operation/,
  );
  assert.equal(starts, 1);
  assert.equal(prepared.provider.errors.length, 1);
  assert.equal(
    prepared.provider.errors[0]?.title,
    "Agent runtime tool_policy_violation",
  );
});

test("rejects malformed primitive result fields", async () => {
  /** Provides an assigned run ready for dispatch. */
  const prepared = await preparedDispatch("run-malformed");
  /** Simulates Agent execution for the dispatch scenario. */
  const runner = resultRunner(({ context }) => {
    /** Builds the otherwise valid result before corrupting one field. */
    const core = {
      contextDigest: context.digest,
      definitionDigest: context.definitionDigest,
      outcome: 42,
      payload: { summary: "bad" },
      proposedIntents: [],
      runId: context.runId,
      schema: "agent-result-v1",
    };
    return { ...core, digest: digestJson(toJsonValue(core)) };
  });
  await assert.rejects(
    dispatchActivatedAgent({
      activated: prepared.activated,
      activationRuntime,
      additionalInput: {},
      promotion: prepared.promotion,
      provider: prepared.provider,
      runtime: runtimeEnvironment(runner),
    }),
    /outcome must be a non-empty string/,
  );
});

test("rejects a Task whose selected version changed before dispatch", async () => {
  /** Provides an assigned run ready for dispatch. */
  const prepared = await preparedDispatch("run-stale-task");
  await prepared.provider.applyTaskMutation({
    expectedVersion: "v1",
    idempotencyKey: "human:done",
    nextBody: null,
    nextProperties: { Status: "Done" },
    nextStatus: "Done",
    taskId: "task-1",
  });
  await assert.rejects(
    dispatchActivatedAgent({
      activated: prepared.activated,
      activationRuntime,
      additionalInput: {},
      promotion: prepared.promotion,
      provider: prepared.provider,
      runtime: runtimeEnvironment(resultRunner(() => ({}))),
    }),
    /changed after selection/,
  );
});

test("cleans a process handle that resolves only after start cancellation", async () => {
  /** Supplies the Agent contract exercised by the scenario. */
  const definition = { ...agentDefinition(), deadlineSeconds: 1 };
  /** Provides an assigned run ready for dispatch. */
  const prepared = await preparedDispatch("run-late-start", definition);
  /** Counts cleanup calls after process cancellation. */
  let cleaned = 0;
  /** Simulates Agent execution for the dispatch scenario. */
  const runner: AgentRunnerAdapter = {
    id: "runner",
    /** Returns the simulated runner identity. */
    async identity() {
      return {
        executableDigest: sha256("runner"),
        executableVersion: "1",
        id: "runner",
        supportedProfiles: ["read-only"],
      };
    },
    /** Starts the simulated agent process. */
    async start({ signal }) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      /** Simulates the child process controlled by the supervisor. */
      const process = completedProcess({
        exitCode: null,
        stderr: "",
        stdout: "",
        toolViolation: null,
      });
      return {
        ...process,
        /** Cleans up the simulated process. */
        async cleanup() {
          cleaned += 1;
        },
      };
    },
  };
  await assert.rejects(
    dispatchActivatedAgent({
      activated: prepared.activated,
      activationRuntime,
      additionalInput: {},
      promotion: prepared.promotion,
      provider: prepared.provider,
      runtime: runtimeEnvironment(runner),
    }),
    /exceeded its deadline/,
  );
  assert.equal(cleaned, 1);
});

test("runs a context-only agent through the concrete no-tool stack", async () => {
  /** Provides the concrete runtime for a context-only Agent. */
  const noToolRuntime: ActivationRuntime = {
    ...activationRuntime,
    installedRunnerProfiles: ["no-tools"],
  };
  /** Supplies the Agent contract exercised by the scenario. */
  const definition: AgentDefinition = {
    ...agentDefinition(),
    capabilities: [],
    runnerProfile: "no-tools",
  };
  /** Provides an assigned run ready for dispatch. */
  const prepared = await preparedDispatch(
    "run-no-tools",
    definition,
    noToolRuntime,
  );
  /** Simulates the configured model transport. */
  const model = new NoToolModelTransportAdapter(
    "no-tool-model",
    {
      /** Exposes the child process output as a readable stream. */
      async *stream({ context }) {
        yield JSON.stringify(
          finalizeAgentResult({
            contextDigest: context.digest,
            definitionDigest: context.definitionDigest,
            outcome: "succeeded",
            payload: { summary: "bounded" },
            proposedIntents: [],
            runId: context.runId,
            schema: "agent-result-v1",
          }),
        );
      },
    },
    sha256("model-client"),
  );
  /** Simulates Agent execution for the dispatch scenario. */
  const runner = new NoToolAgentRunnerAdapter(
    "no-tool-runner",
    sha256("no-tool-runner"),
    "1.0.0",
  );
  /** Provides the effect or dispatch runtime exercised by the scenario. */
  const runtime = runtimeEnvironment(
    runner,
    new NoToolIsolationAdapter("no-tool-isolation"),
    undefined,
    model,
  );
  /** Captures the completed dispatch used for assertions. */
  const dispatched = await dispatchActivatedAgent({
    activated: prepared.activated,
    activationRuntime: noToolRuntime,
    additionalInput: {},
    promotion: prepared.promotion,
    provider: prepared.provider,
    runtime,
  });
  assert.equal(dispatched.result.payload.summary, "bounded");
});

test("streams output and hard-kills a process tree after its deadline", async () => {
  /** Resolves when the simulated process is allowed to exit. */
  let finish!: (value: AgentProcessCompletion) => void;
  /** Signals when the simulated process has entered its wait state. */
  const waiting = new Promise<AgentProcessCompletion>((resolve) => {
    finish = resolve;
  });
  /** Counts cleanup calls after process cancellation. */
  let cleaned = 0;
  /** Tracks whether graceful process termination was requested. */
  let terminated = 0;
  /** Counts hard-kill requests issued to the process tree. */
  let killed = 0;
  /** Simulates the child process controlled by the supervisor. */
  const process: SupervisedAgentProcess = {
    /** Cleans up the simulated process. */
    async cleanup() {
      cleaned += 1;
    },
    /** Simulates forced process-tree termination. */
    async killTree() {
      killed += 1;
      finish({ exitCode: null, toolViolation: null });
    },
    /** Streams simulated process output. */
    async *output() {},
    /** Simulates graceful process-tree termination. */
    async terminateTree() {
      terminated += 1;
    },
    /** Returns simulated process completion. */
    async wait() {
      return waiting;
    },
  };
  /** Captures the operation outcome used by assertions. */
  const result = await superviseProcess({
    deadlineAt: Date.now() + 1,
    graceMilliseconds: 1,
    outputLimitBytes: 100,
    postKillReapMilliseconds: 10,
    process,
  });
  assert.equal(terminated, 1);
  assert.equal(killed, 1);
  assert.equal(cleaned, 1);
  assert.equal(result.telemetry.timedOut, true);
  assert.equal(result.telemetry.hardKilled, true);
});

test("rejects unsupported JSON-Schema keywords before activation", () => {
  assert.throws(
    () =>
      assertSupportedJsonSchema({
        additionalProperties: false,
        minProperties: 1,
        properties: {},
        required: [],
        type: "object",
        $ref: "#/x",
      }),
    /\$\.\$ref is unsupported/,
  );
  assert.throws(
    () => assertSupportedJsonSchema({ type: "string", pattern: "^(a+)+$" }),
    /pattern is unsupported/,
  );
  assert.throws(
    () =>
      assertSupportedJsonSchema({
        items: { type: "string" },
        maxItems: 1,
        minItems: 2,
        type: "array",
      }),
    /minimum cannot exceed maximum/,
  );
  assert.deepEqual(
    assertSupportedJsonSchema({
      additionalProperties: false,
      minProperties: 1,
      properties: {},
      required: [],
      type: "object",
    }),
    undefined,
  );
});

test("resolves only configured adapters and rejects unsafe environment authority", () => {
  /** Simulates Agent execution for the dispatch scenario. */
  const runner = resultRunner(() => ({}));
  /** Provides the effect or dispatch runtime exercised by the scenario. */
  const runtime = runtimeEnvironment(runner);
  assert.equal(runtime.runner, runner);
  assert.match(runtime.digest, /^[a-f0-9]{64}$/u);
  assert.throws(
    () =>
      runtimeEnvironment(runner, undefined, undefined, undefined, [
        "API_TOKEN",
      ]),
    /unsafe/,
  );
});

/** Creates an activated provider assignment for dispatch tests. */
async function preparedDispatch(
  ownerId: string,
  definition = agentDefinition(),
  runtime = activationRuntime,
): Promise<{
  /** Resolves the immutable Agent definition selected for dispatch. */
  activated: ActivatedDefinition;
  /** Carries the active assignment and lease identifiers for dispatch. */
  promotion: AssignmentPromotion;
  /** Exposes the recording provider for post-dispatch assertions. */
  provider: RecordingProvider;
}> {
  /** Provides isolated provider state for the scenario. */
  const provider = await preparedProvider(definition);
  /** Captures the validated definition ready for dispatch. */
  const activated = await activateDefinitions({ ...runtime, provider });
  /** Supplies the canonical workspace schema target. */
  const target = activated[0];
  assert.ok(target);
  /** Supplies the immutable context used for task selection. */
  const selectionContext = await prepareSelection(
    provider,
    target.resolved,
    activated,
  );
  /** Represents the assignment promoted into active work. */
  const assignment = finalizeExplicitAssignment({
    authorityId: ownerId,
    idempotencyKey: `explicit:${ownerId}`,
    schema: "explicit-assignment-v1",
    selectionBasisDigest: selectionContext.basisDigest,
    targetAgentId: target.resolved.definition.id,
    targetAgentRevision: target.resolved.definition.revision,
    taskId: "task-1",
  });
  /** Describes the assignment-to-worker lease transition. */
  const promotion = await promoteExplicitAssignment({
    activationRuntime: runtime,
    assignment,
    assignmentDepth: 0,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ownerId,
    provider,
    resolvedTarget: target.resolved,
    selectionContext,
  });
  return { activated: target, promotion, provider };
}

/** Resolves a runtime environment from registered fake adapters. */
function runtimeEnvironment(
  runner: AgentRunnerAdapter,
  isolation = isolationAdapter(),
  observePolicy?: (policy: ToolIsolationPolicy) => void,
  model = modelAdapter(),
  allowedEnvironmentNames: readonly string[] = [],
): ResolvedRuntimeEnvironment {
  /** Registers the Agent runners available at runtime. */
  const runners = new RuntimeAdapterRegistry<AgentRunnerAdapter>();
  /** Registers the model transports available at runtime. */
  const models = new RuntimeAdapterRegistry<ModelTransportAdapter>();
  /** Registers the tool-isolation adapters available at runtime. */
  const isolations = new RuntimeAdapterRegistry<ToolIsolationAdapter>();
  runners.register(runner);
  models.register(model);
  /** Captures observed state used as the assertion oracle. */
  const observed: ToolIsolationAdapter =
    observePolicy === undefined
      ? isolation
      : {
          id: isolation.id,
          /** Creates a prepared adapter session. */
          async prepare(policy, signal) {
            observePolicy(policy);
            return isolation.prepare(policy, signal);
          },
        };
  isolations.register(observed);
  /** Binds the runtime adapters and policies used by the scenario. */
  const config = parseEnvironmentConfig({
    adapters: {
      agentRunner: runner.id,
      modelTransport: model.id,
      publication: null,
      sandbox: observed.id,
    },
    environmentId: "demo",
    provider: {
      bootstrapParent: null,
      connection: {},
      tables: { errors: "e", resources: "r", agents: "a", tasks: "t" },
      type: "memory",
    },
    runtime: {
      allowedEnvironmentNames: [...allowedEnvironmentNames],
      allowedNetworkOrigins: [],
      allowedReadRoots: ["A:/Projects/Projects/Ongoing/agent-task-manager"],
      allowedWriteRoots: [],
      concurrencyMode: "single-host",
      outputLimitBytes: 100_000,
      postKillReapMilliseconds: 100,
      root: "A:/AgentTaskManager/demo",
      terminationGraceMilliseconds: 10,
    },
    schema: "agent-task-manager-environment-v1",
  });
  return resolveRuntimeEnvironment({
    config,
    modelTransports: models,
    runners,
    toolIsolations: isolations,
  });
}

/** Builds a model adapter that exposes deterministic session metadata. */
function modelAdapter(onClose: () => void = () => {}): ModelTransportAdapter {
  return {
    id: "model-transport",
    /** Creates a prepared adapter session. */
    async prepare({ model, reasoning, runId }) {
      return {
        /** Closes the simulated adapter session. */
        async close() {
          onClose();
        },
        opaqueHandle: { runId },
        receipt: {
          adapterId: "model-transport",
          credentialExposedToTools: false,
          digest: sha256(`${model}:${reasoning}:${runId}`),
          model,
          reasoning,
          runId,
          separatedFromToolProcesses: true,
        },
      };
    },
  };
}

/** Builds an isolation adapter with observable policy and cleanup hooks. */
function isolationAdapter(): ToolIsolationAdapter {
  return {
    id: "isolation",
    /** Creates a prepared adapter session. */
    async prepare(policy) {
      return {
        /** Closes the simulated adapter session. */
        async close() {},
        opaqueHandle: { runId: policy.runId },
        receipt: {
          adapterId: "isolation",
          environmentDigest: sha256("env"),
          filesystemPolicyDigest: sha256("fs"),
          networkPolicyDigest: sha256("net"),
          policyDigest: digestJson(toJsonValue(policy)),
          processTreeEnforced: true,
          runId: policy.runId,
        },
      };
    },
  };
}

/** Builds a runner that returns a configurable Agent result and tool activity. */
function resultRunner(
  result: (input: Parameters<AgentRunnerAdapter["start"]>[0]) => unknown,
  toolViolation: string | null = null,
): AgentRunnerAdapter {
  return {
    id: "runner",
    /** Returns the simulated runner identity. */
    async identity() {
      return {
        executableDigest: sha256("runner"),
        executableVersion: "1.0.0",
        id: "runner",
        supportedProfiles: ["read-only"],
      };
    },
    /** Starts the simulated agent process. */
    async start(input) {
      return completedProcess({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify(result(input)),
        toolViolation,
      });
    },
  };
}

/** Creates a completed simulated agent process. */
function completedProcess(
  value: AgentProcessCompletion & {
    /** Captures the bounded standard-error output from the child process. */
    readonly stderr: string;
    /** Captures the bounded standard output from the child process. */
    readonly stdout: string;
  },
): SupervisedAgentProcess {
  return {
    /** Cleans up the simulated process. */
    async cleanup() {},
    /** Simulates forced process-tree termination. */
    async killTree() {},
    /** Streams simulated process output. */
    async *output() {
      if (value.stdout !== "")
        yield { channel: "stdout" as const, data: value.stdout };
      if (value.stderr !== "")
        yield { channel: "stderr" as const, data: value.stderr };
    },
    /** Simulates graceful process-tree termination. */
    async terminateTree() {},
    /** Returns simulated process completion. */
    async wait() {
      return { exitCode: value.exitCode, toolViolation: value.toolViolation };
    },
  };
}

/** Creates a provider populated with runtime fixtures. */
async function preparedProvider(
  definition = agentDefinition(),
): Promise<RecordingProvider> {
  /** Provides isolated provider state for the scenario. */
  const provider = new RecordingProvider(environment, target);
  provider.seedDefinition(definition);
  provider.seedTaskStatusOptions(["Done", "Todo"]);
  provider.seedTask({
    archived: false,
    body: "Task body",
    dependencies: [],
    id: "task-1",
    priority: 1,
    properties: { Status: "Todo" },
    status: "Todo",
    title: "Task",
    version: "v1",
  });
  for (const record of resources()) await provider.putResource(record);
  return provider;
}

/** Builds the canonical Agent definition used by dispatch scenarios. */
function agentDefinition(): AgentDefinition {
  return {
    allowedIntents: ["task.note"],
    capabilities: ["repository.read"],
    contextBudgetBytes: 100_000,
    deadlineSeconds: 60,
    enabled: true,
    humanResolutionOutcomes: [],
    id: "analyst",
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    maxAssignmentDepth: 1,
    maxAssignmentsPerRun: 1,
    maxConcurrency: 1,
    model: "model",
    name: "Analyst",
    outputSchema: "schema/output",
    priority: 1,
    prohibitedCapabilities: [],
    promptResources: ["prompt/analyst"],
    reasoning: "medium",
    requiredProviderCapabilities: [],
    retry: { maxAttempts: 1, noVerdict: "block" },
    revision: 1,
    runnerProfile: "read-only",
    schema: "agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: ["explicit", "self"],
      maxCandidateSummaries: 1,
      mode: "self",
      resultSchema: "schema/selection",
      taskQueryResource: "query/analyst",
    },
    transitions: { succeeded: "Done" },
  };
}

/** Builds the Resource graph required by the dispatch definition. */
function resources(): ResourceMutation[] {
  return [
    resource("prompt/analyst", "prompt", "Inspect the supplied Task."),
    resource(
      "query/analyst",
      "task-query",
      JSON.stringify({
        dependencySatisfiedStatuses: ["Done"],
        limit: 1,
        predicate: { status: "Todo" },
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

/** Returns a minimal closed JSON Schema for Agent outputs. */
function closedSchema(properties: object, required: string[] = []): string {
  return JSON.stringify({
    additionalProperties: false,
    properties,
    required,
    type: "object",
  });
}
