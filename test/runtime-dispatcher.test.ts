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
  type SubAgentDefinition,
  type SupervisedAgentProcess,
  type ToolIsolationAdapter,
  type ToolIsolationPolicy,
  type WorkspaceSchemaDescriptor,
  type WriteReceipt,
} from "../src/index.js";

/** Defines the shared environment fixture for this test module. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" },
  type: "memory",
};
/** Defines the shared target fixture for this test module. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};
/** Defines the shared activation runtime fixture for this test module. */
const activationRuntime: ActivationRuntime = {
  installedCapabilities: ["repository.read"],
  installedIntents: ["task.note"],
  installedRunnerProfiles: ["read-only"],
  supportedModels: { model: ["medium"] },
};

/** Implements recording provider. */
class RecordingProvider extends InMemoryProvider {
  /** Contains errors for recording provider. */
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
  /** Defines the prepared fixture for “dispatches only from a live assignment through environment-bound adapters”. */
  const prepared = await preparedDispatch("run-1");
  /** Defines the observed policy fixture for “dispatches only from a live assignment through environment-bound adapters”. */
  const observedPolicy: {
    /** Contains value for module. */ value: ToolIsolationPolicy | null;
  } = { value: null };
  /** Defines the runner fixture for “dispatches only from a live assignment through environment-bound adapters”. */
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
  /** Defines the runtime fixture for “dispatches only from a live assignment through environment-bound adapters”. */
  const runtime = runtimeEnvironment(runner, undefined, (policy) => {
    observedPolicy.value = policy;
  });
  /** Defines the dispatched fixture for “dispatches only from a live assignment through environment-bound adapters”. */
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

test("rejects fabricated isolation receipts and closes prepared sessions", async () => {
  /** Defines the prepared fixture for “rejects fabricated isolation receipts and closes prepared sessions”. */
  const prepared = await preparedDispatch("run-bad-receipt");
  /** Defines the model closed fixture for “rejects fabricated isolation receipts and closes prepared sessions”. */
  let modelClosed = 0;
  /** Defines the isolation closed fixture for “rejects fabricated isolation receipts and closes prepared sessions”. */
  let isolationClosed = 0;
  /** Defines the model fixture for “rejects fabricated isolation receipts and closes prepared sessions”. */
  const model = modelAdapter(() => {
    modelClosed += 1;
  });
  /** Defines the bad isolation fixture for “rejects fabricated isolation receipts and closes prepared sessions”. */
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
  /** Defines the prepared fixture for “blocks unauthorized tool activity without retrying”. */
  const prepared = await preparedDispatch("run-violation");
  /** Defines the starts fixture for “blocks unauthorized tool activity without retrying”. */
  let starts = 0;
  /** Defines the runner fixture for “blocks unauthorized tool activity without retrying”. */
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
    "Sub-agent runtime tool_policy_violation",
  );
});

test("rejects malformed primitive result fields", async () => {
  /** Defines the prepared fixture for “rejects malformed primitive result fields”. */
  const prepared = await preparedDispatch("run-malformed");
  /** Defines the runner fixture for “rejects malformed primitive result fields”. */
  const runner = resultRunner(({ context }) => {
    /** Defines the core fixture for “rejects malformed primitive result fields”. */
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
  /** Defines the prepared fixture for “rejects a Task whose selected version changed before dispatch”. */
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
  /** Defines the definition fixture for “cleans a process handle that resolves only after start cancellation”. */
  const definition = { ...agentDefinition(), deadlineSeconds: 1 };
  /** Defines the prepared fixture for “cleans a process handle that resolves only after start cancellation”. */
  const prepared = await preparedDispatch("run-late-start", definition);
  /** Defines the cleaned fixture for “cleans a process handle that resolves only after start cancellation”. */
  let cleaned = 0;
  /** Defines the runner fixture for “cleans a process handle that resolves only after start cancellation”. */
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
      /** Defines the process fixture for “cleans a process handle that resolves only after start cancellation”. */
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
  /** Defines the no tool runtime fixture for “runs a context-only agent through the concrete no-tool stack”. */
  const noToolRuntime: ActivationRuntime = {
    ...activationRuntime,
    installedRunnerProfiles: ["no-tools"],
  };
  /** Defines the definition fixture for “runs a context-only agent through the concrete no-tool stack”. */
  const definition: SubAgentDefinition = {
    ...agentDefinition(),
    capabilities: [],
    runnerProfile: "no-tools",
  };
  /** Defines the prepared fixture for “runs a context-only agent through the concrete no-tool stack”. */
  const prepared = await preparedDispatch(
    "run-no-tools",
    definition,
    noToolRuntime,
  );
  /** Defines the model fixture for “runs a context-only agent through the concrete no-tool stack”. */
  const model = new NoToolModelTransportAdapter(
    "no-tool-model",
    {
      /** Creates the stream test fixture. */
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
  /** Defines the runner fixture for “runs a context-only agent through the concrete no-tool stack”. */
  const runner = new NoToolAgentRunnerAdapter(
    "no-tool-runner",
    sha256("no-tool-runner"),
    "1.0.0",
  );
  /** Defines the runtime fixture for “runs a context-only agent through the concrete no-tool stack”. */
  const runtime = runtimeEnvironment(
    runner,
    new NoToolIsolationAdapter("no-tool-isolation"),
    undefined,
    model,
  );
  /** Defines the dispatched fixture for “runs a context-only agent through the concrete no-tool stack”. */
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
  /** Defines the finish fixture for “streams output and hard-kills a process tree after its deadline”. */
  let finish!: (value: AgentProcessCompletion) => void;
  /** Defines the waiting fixture for “streams output and hard-kills a process tree after its deadline”. */
  const waiting = new Promise<AgentProcessCompletion>((resolve) => {
    finish = resolve;
  });
  /** Defines the cleaned fixture for “streams output and hard-kills a process tree after its deadline”. */
  let cleaned = 0;
  /** Defines the terminated fixture for “streams output and hard-kills a process tree after its deadline”. */
  let terminated = 0;
  /** Defines the killed fixture for “streams output and hard-kills a process tree after its deadline”. */
  let killed = 0;
  /** Defines the process fixture for “streams output and hard-kills a process tree after its deadline”. */
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
  /** Defines the result fixture for “streams output and hard-kills a process tree after its deadline”. */
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
  /** Defines the runner fixture for “resolves only configured adapters and rejects unsafe environment authority”. */
  const runner = resultRunner(() => ({}));
  /** Defines the runtime fixture for “resolves only configured adapters and rejects unsafe environment authority”. */
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
  /** Contains activated for prepared dispatch. */
  activated: ActivatedDefinition;
  /** Contains promotion for prepared dispatch. */
  promotion: AssignmentPromotion;
  /** Contains provider for prepared dispatch. */
  provider: RecordingProvider;
}> {
  /** Defines the provider fixture used by prepared dispatch. */
  const provider = await preparedProvider(definition);
  /** Defines the activated fixture used by prepared dispatch. */
  const activated = await activateDefinitions({ ...runtime, provider });
  /** Defines the target fixture used by prepared dispatch. */
  const target = activated[0];
  assert.ok(target);
  /** Defines the selection context fixture used by prepared dispatch. */
  const selectionContext = await prepareSelection(
    provider,
    target.resolved,
    activated,
  );
  /** Defines the assignment fixture used by prepared dispatch. */
  const assignment = finalizeExplicitAssignment({
    authorityId: ownerId,
    idempotencyKey: `explicit:${ownerId}`,
    schema: "explicit-assignment-v1",
    selectionBasisDigest: selectionContext.basisDigest,
    targetSubAgentId: target.resolved.definition.id,
    targetSubAgentRevision: target.resolved.definition.revision,
    taskId: "task-1",
  });
  /** Defines the promotion fixture used by prepared dispatch. */
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

/** Creates the runtime environment test fixture. */
function runtimeEnvironment(
  runner: AgentRunnerAdapter,
  isolation = isolationAdapter(),
  observePolicy?: (policy: ToolIsolationPolicy) => void,
  model = modelAdapter(),
  allowedEnvironmentNames: readonly string[] = [],
): ResolvedRuntimeEnvironment {
  /** Defines the runners fixture used by runtime environment. */
  const runners = new RuntimeAdapterRegistry<AgentRunnerAdapter>();
  /** Defines the models fixture used by runtime environment. */
  const models = new RuntimeAdapterRegistry<ModelTransportAdapter>();
  /** Defines the isolations fixture used by runtime environment. */
  const isolations = new RuntimeAdapterRegistry<ToolIsolationAdapter>();
  runners.register(runner);
  models.register(model);
  /** Defines the observed fixture used by runtime environment. */
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
  /** Defines the config fixture used by runtime environment. */
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
      tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" },
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

/** Creates the model adapter test fixture. */
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
/** Creates the isolation adapter test fixture. */
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
/** Creates the result runner test fixture. */
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
    /** Contains stderr for completed process. */
    readonly stderr: string;
    /** Contains stdout for completed process. */
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
  /** Defines the provider fixture used by prepared provider. */
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
/** Creates the agent definition test fixture. */
function agentDefinition(): SubAgentDefinition {
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
    schema: "sub-agent-definition-v1",
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
/** Creates the resources test fixture. */
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
/** Creates the closed schema test fixture. */
function closedSchema(properties: object, required: string[] = []): string {
  return JSON.stringify({
    additionalProperties: false,
    properties,
    required,
    type: "object",
  });
}
