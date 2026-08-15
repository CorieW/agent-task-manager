// Verifies assignment-bound dispatch, strict contracts, streaming limits, and cleanup.
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

const environment: ProviderEnvironment = { bootstrapParent: null, connection: {}, tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" }, type: "memory" };
const target: WorkspaceSchemaDescriptor = { digest: "target", providerType: "memory", tables: [], version: "v1" };
const activationRuntime: ActivationRuntime = {
  installedCapabilities: ["repository.read"], installedIntents: ["task.note"], installedRunnerProfiles: ["read-only"], supportedModels: { model: ["medium"] },
};

class RecordingProvider extends InMemoryProvider {
  public readonly errors: ErrorMutation[] = [];
  public override async createOrUpdateError(error: ErrorMutation): Promise<WriteReceipt> { this.errors.push(structuredClone(error)); return super.createOrUpdateError(error); }
}

test("dispatches only from a live assignment through environment-bound adapters", async () => {
  const prepared = await preparedDispatch("run-1");
  const observedPolicy: { value: ToolIsolationPolicy | null } = { value: null };
  const runner = resultRunner(({ context }) => finalizeAgentResult({
    contextDigest: context.digest, definitionDigest: context.definitionDigest, outcome: "succeeded",
    payload: { summary: "checked" }, proposedIntents: [{ kind: "task.note", payload: { text: "done" } }],
    runId: context.runId, schema: "agent-result-v1",
  }));
  const runtime = runtimeEnvironment(runner, undefined, (policy) => { observedPolicy.value = policy; });
  const dispatched = await dispatchActivatedAgent({
    activated: prepared.activated, activationRuntime, additionalInput: { request: "inspect" },
    promotion: prepared.promotion, provider: prepared.provider, runtime,
  });
  assert.equal(dispatched.result.payload.summary, "checked");
  assert.match(dispatched.contextDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(observedPolicy.value?.allowedReadRoots, ["A:\\Projects\\Projects\\Ongoing\\agent-task-manager"]);
  assert.deepEqual(observedPolicy.value?.allowedWriteRoots, []);
  assert.deepEqual(prepared.provider.errors, []);
});

test("rejects fabricated isolation receipts and closes prepared sessions", async () => {
  const prepared = await preparedDispatch("run-bad-receipt");
  let modelClosed = 0;
  let isolationClosed = 0;
  const model = modelAdapter(() => { modelClosed += 1; });
  const badIsolation: ToolIsolationAdapter = {
    id: "isolation",
    async prepare(policy) {
      return {
        async close() { isolationClosed += 1; }, opaqueHandle: {},
        receipt: { adapterId: "other", environmentDigest: sha256("env"), filesystemPolicyDigest: sha256("fs"), networkPolicyDigest: sha256("net"), policyDigest: digestJson(toJsonValue(policy)), processTreeEnforced: true, runId: policy.runId },
      };
    },
  };
  await assert.rejects(dispatchActivatedAgent({
    activated: prepared.activated, activationRuntime, additionalInput: {}, promotion: prepared.promotion,
    provider: prepared.provider, runtime: runtimeEnvironment(resultRunner(() => { throw new Error("unreachable"); }), badIsolation, undefined, model),
  }), /does not prove the configured policy boundary/);
  assert.equal(modelClosed, 1);
  assert.equal(isolationClosed, 1);
  assert.equal(prepared.provider.errors[0]?.description.includes("other"), false);
});

test("blocks unauthorized tool activity without retrying", async () => {
  const prepared = await preparedDispatch("run-violation");
  let starts = 0;
  const runner = resultRunner(() => { starts += 1; return {}; }, "write_outside_root");
  await assert.rejects(dispatchActivatedAgent({
    activated: prepared.activated, activationRuntime, additionalInput: {}, promotion: prepared.promotion,
    provider: prepared.provider, runtime: runtimeEnvironment(runner),
  }), /unauthorized tool operation/);
  assert.equal(starts, 1);
  assert.equal(prepared.provider.errors.length, 1);
  assert.equal(prepared.provider.errors[0]?.title, "Sub-agent runtime tool_policy_violation");
});

test("rejects malformed primitive result fields", async () => {
  const prepared = await preparedDispatch("run-malformed");
  const runner = resultRunner(({ context }) => {
    const core = { contextDigest: context.digest, definitionDigest: context.definitionDigest, outcome: 42, payload: { summary: "bad" }, proposedIntents: [], runId: context.runId, schema: "agent-result-v1" };
    return { ...core, digest: digestJson(toJsonValue(core)) };
  });
  await assert.rejects(dispatchActivatedAgent({ activated: prepared.activated, activationRuntime, additionalInput: {}, promotion: prepared.promotion, provider: prepared.provider, runtime: runtimeEnvironment(runner) }), /outcome must be a non-empty string/);
});

test("streams output and hard-kills a process tree after its deadline", async () => {
  let finish!: (value: AgentProcessCompletion) => void;
  const waiting = new Promise<AgentProcessCompletion>((resolve) => { finish = resolve; });
  let cleaned = 0;
  let terminated = 0;
  let killed = 0;
  const process: SupervisedAgentProcess = {
    async cleanup() { cleaned += 1; },
    async killTree() { killed += 1; finish({ exitCode: null, toolViolation: null }); },
    async *output() {},
    async terminateTree() { terminated += 1; },
    async wait() { return waiting; },
  };
  const result = await superviseProcess({ deadlineMilliseconds: 1, graceMilliseconds: 1, outputLimitBytes: 100, postKillReapMilliseconds: 10, process });
  assert.equal(terminated, 1);
  assert.equal(killed, 1);
  assert.equal(cleaned, 1);
  assert.equal(result.telemetry.timedOut, true);
  assert.equal(result.telemetry.hardKilled, true);
});

test("rejects unsupported JSON-Schema keywords before activation", () => {
  assert.throws(() => assertSupportedJsonSchema({ additionalProperties: false, minProperties: 1, properties: {}, required: [], type: "object", $ref: "#/x" }), /\$\.\$ref is unsupported/);
  assert.deepEqual(assertSupportedJsonSchema({ additionalProperties: false, minProperties: 1, properties: {}, required: [], type: "object" }), undefined);
});

test("resolves only configured adapters and rejects unsafe environment authority", () => {
  const runner = resultRunner(() => ({}));
  const runtime = runtimeEnvironment(runner);
  assert.equal(runtime.runner, runner);
  assert.match(runtime.digest, /^[a-f0-9]{64}$/u);
  assert.throws(() => runtimeEnvironment(runner, undefined, undefined, undefined, ["API_TOKEN"]), /unsafe/);
});

async function preparedDispatch(ownerId: string): Promise<{ activated: ActivatedDefinition; promotion: AssignmentPromotion; provider: RecordingProvider }> {
  const provider = await preparedProvider();
  const activated = await activateDefinitions({ ...activationRuntime, provider });
  const target = activated[0];
  assert.ok(target);
  const selectionContext = await prepareSelection(provider, target.resolved, activated);
  const assignment = finalizeExplicitAssignment({
    authorityId: ownerId, idempotencyKey: `explicit:${ownerId}`, schema: "explicit-assignment-v1",
    selectionBasisDigest: selectionContext.basisDigest, targetSubAgentId: target.resolved.definition.id,
    targetSubAgentRevision: target.resolved.definition.revision, taskId: "task-1",
  });
  const promotion = await promoteExplicitAssignment({
    activationRuntime, assignment, assignmentDepth: 0, expiresAt: "2099-01-01T00:00:00.000Z", ownerId,
    provider, resolvedTarget: target.resolved, selectionContext,
  });
  return { activated: target, promotion, provider };
}

function runtimeEnvironment(
  runner: AgentRunnerAdapter,
  isolation = isolationAdapter(),
  observePolicy?: (policy: ToolIsolationPolicy) => void,
  model = modelAdapter(),
  allowedEnvironmentNames: readonly string[] = [],
): ResolvedRuntimeEnvironment {
  const runners = new RuntimeAdapterRegistry<AgentRunnerAdapter>();
  const models = new RuntimeAdapterRegistry<ModelTransportAdapter>();
  const isolations = new RuntimeAdapterRegistry<ToolIsolationAdapter>();
  runners.register(runner); models.register(model);
  const observed: ToolIsolationAdapter = observePolicy === undefined ? isolation : { id: isolation.id, async prepare(policy) { observePolicy(policy); return isolation.prepare(policy); } };
  isolations.register(observed);
  const config = parseEnvironmentConfig({
    adapters: { agentRunner: runner.id, modelTransport: model.id, publication: null, sandbox: observed.id }, environmentId: "demo",
    provider: { bootstrapParent: null, connection: {}, tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" }, type: "memory" },
    runtime: {
      allowedEnvironmentNames: [...allowedEnvironmentNames], allowedNetworkOrigins: [], allowedReadRoots: ["A:/Projects/Projects/Ongoing/agent-task-manager"], allowedWriteRoots: [],
      concurrencyMode: "single-host", outputLimitBytes: 100_000, postKillReapMilliseconds: 100, root: "A:/AgentTaskManager/demo", terminationGraceMilliseconds: 10,
    }, schema: "agent-task-manager-environment-v1",
  });
  return resolveRuntimeEnvironment({ config, modelTransports: models, runners, toolIsolations: isolations });
}

function modelAdapter(onClose: () => void = () => {}): ModelTransportAdapter {
  return {
    id: "model-transport",
    async prepare({ model, reasoning, runId }) {
      return { async close() { onClose(); }, opaqueHandle: { runId }, receipt: { adapterId: "model-transport", credentialExposedToTools: false, digest: sha256(`${model}:${reasoning}:${runId}`), model, reasoning, runId, separatedFromToolProcesses: true } };
    },
  };
}
function isolationAdapter(): ToolIsolationAdapter {
  return {
    id: "isolation",
    async prepare(policy) {
      return { async close() {}, opaqueHandle: { runId: policy.runId }, receipt: { adapterId: "isolation", environmentDigest: sha256("env"), filesystemPolicyDigest: sha256("fs"), networkPolicyDigest: sha256("net"), policyDigest: digestJson(toJsonValue(policy)), processTreeEnforced: true, runId: policy.runId } };
    },
  };
}
function resultRunner(result: (input: Parameters<AgentRunnerAdapter["start"]>[0]) => unknown, toolViolation: string | null = null): AgentRunnerAdapter {
  return {
    id: "runner",
    async identity() { return { executableDigest: sha256("runner"), executableVersion: "1.0.0", id: "runner", supportedProfiles: ["read-only"] }; },
    async start(input) { return completedProcess({ exitCode: 0, stderr: "", stdout: JSON.stringify(result(input)), toolViolation }); },
  };
}
function completedProcess(value: AgentProcessCompletion & { readonly stderr: string; readonly stdout: string }): SupervisedAgentProcess {
  return {
    async cleanup() {}, async killTree() {},
    async *output() { if (value.stdout !== "") yield { channel: "stdout" as const, data: value.stdout }; if (value.stderr !== "") yield { channel: "stderr" as const, data: value.stderr }; },
    async terminateTree() {}, async wait() { return { exitCode: value.exitCode, toolViolation: value.toolViolation }; },
  };
}
async function preparedProvider(): Promise<RecordingProvider> {
  const provider = new RecordingProvider(environment, target);
  provider.seedDefinition(agentDefinition());
  provider.seedTaskStatusOptions(["Done", "Todo"]);
  provider.seedTask({ archived: false, body: "Task body", dependencies: [], id: "task-1", priority: 1, properties: { Status: "Todo" }, status: "Todo", title: "Task", version: "v1" });
  for (const record of resources()) await provider.putResource(record);
  return provider;
}
function agentDefinition(): SubAgentDefinition {
  return {
    allowedIntents: ["task.note"], capabilities: ["repository.read"], contextBudgetBytes: 100_000, deadlineSeconds: 60,
    enabled: true, id: "analyst", inputResourceSelectors: [], invocation: { mode: "manual", scheduleResource: null }, maxAssignmentDepth: 1,
    maxAssignmentsPerRun: 1, maxConcurrency: 1, model: "model", name: "Analyst", outputSchema: "schema/output", priority: 1,
    prohibitedCapabilities: [], promptResources: ["prompt/analyst"], reasoning: "medium", requiredProviderCapabilities: [],
    retry: { maxAttempts: 1, noVerdict: "block" }, revision: 1, runnerProfile: "read-only", schema: "sub-agent-definition-v1",
    selection: { acceptsAssignmentsFrom: ["explicit", "self"], maxCandidateSummaries: 1, mode: "self", resultSchema: "schema/selection", taskQueryResource: "query/analyst" }, transitions: { succeeded: "Done" },
  };
}
function resources(): ResourceMutation[] {
  return [
    resource("prompt/analyst", "prompt", "Inspect the supplied Task."),
    resource("query/analyst", "task-query", JSON.stringify({ dependencySatisfiedStatuses: ["Done"], limit: 1, predicate: { status: "Todo" }, schema: "task-query-v1" })),
    resource("schema/selection", "json-schema", closedSchema({})),
    resource("schema/output", "json-schema", closedSchema({ summary: { minLength: 1, type: "string" } }, ["summary"])),
  ];
}
function resource(key: string, kind: string, body: string): ResourceMutation { return { body, dependencies: [], digest: sha256(body), idempotencyKey: `seed:${key}`, key, kind, state: "active", version: "v1" }; }
function closedSchema(properties: object, required: string[] = []): string { return JSON.stringify({ additionalProperties: false, properties, required, type: "object" }); }
