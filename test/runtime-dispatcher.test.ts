// Verifies immutable contexts, strict results, supervision, and fail-closed runtime errors.
import assert from "node:assert/strict";
import test from "node:test";

import {
  activateDefinitions,
  dispatchActivatedAgent,
  finalizeAgentResult,
  InMemoryProvider,
  superviseProcess,
  type AgentProcessCompletion,
  type AgentRunnerAdapter,
  type ErrorMutation,
  type ModelTransportAdapter,
  type ProviderEnvironment,
  type ResourceMutation,
  type SubAgentDefinition,
  type SupervisedAgentProcess,
  type ToolIsolationAdapter,
  type WorkspaceSchemaDescriptor,
  type WriteReceipt,
} from "../src/index.js";
import { sha256 } from "../src/core/digest.js";

const environment: ProviderEnvironment = { bootstrapParent: null, connection: {}, tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" }, type: "memory" };
const target: WorkspaceSchemaDescriptor = { digest: "target", providerType: "memory", tables: [], version: "v1" };

class RecordingProvider extends InMemoryProvider {
  public readonly errors: ErrorMutation[] = [];
  public override async createOrUpdateError(error: ErrorMutation): Promise<WriteReceipt> {
    this.errors.push(structuredClone(error));
    return super.createOrUpdateError(error);
  }
}

const modelTransport: ModelTransportAdapter = {
  id: "model-transport",
  async prepare({ model, reasoning, runId }) {
    return { opaqueHandle: { runId }, receipt: { credentialExposedToTools: false, digest: sha256(`${model}:${reasoning}`), model, reasoning, separatedFromToolProcesses: true } };
  },
};
const isolation: ToolIsolationAdapter = {
  id: "isolation",
  async prepare(policy) {
    return { opaqueHandle: { runId: policy.runId }, receipt: { environmentDigest: sha256("env"), filesystemPolicyDigest: sha256("fs"), networkPolicyDigest: sha256("net"), processTreeEnforced: true } };
  },
};

test("dispatches a schema-valid result through separated runtime boundaries", async () => {
  const provider = await preparedProvider();
  const [activated] = await activateDefinitions({
    installedCapabilities: ["repository.read"], installedIntents: ["task.note"], installedRunnerProfiles: ["read-only"],
    provider, supportedModels: { model: ["medium"] },
  });
  assert.ok(activated);
  const runner: AgentRunnerAdapter = {
    id: "runner",
    async identity() { return { executableDigest: sha256("runner"), executableVersion: "1.0.0", id: "runner" }; },
    async start({ context }) {
      const result = finalizeAgentResult({
        contextDigest: context.digest, definitionDigest: context.definitionDigest, outcome: "succeeded",
        payload: { summary: "checked" }, proposedIntents: [{ kind: "task.note", payload: { text: "done" } }],
        runId: context.runId, schema: "agent-result-v1",
      });
      return completedProcess({ exitCode: 0, stderr: "", stdout: JSON.stringify(result), toolViolation: null });
    },
  };
  const dispatched = await dispatchActivatedAgent({
    activated, additionalInput: { request: "inspect" }, modelTransport, outputLimitBytes: 100_000, provider,
    runId: "run-1", runner, taskId: "task-1", toolIsolation: isolation,
    toolPolicy: { allowedEnvironmentNames: [], allowedReadRoots: ["C:/repo"], allowedWriteRoots: [], network: { allowedOrigins: [], mode: "none" }, runId: "run-1" },
  });
  assert.equal(dispatched.result.payload.summary, "checked");
  assert.match(dispatched.contextDigest, /^[a-f0-9]{64}$/u);
  assert.equal(dispatched.telemetry.toolViolation, null);
  assert.deepEqual(provider.errors, []);
});

test("blocks unauthorized tool activity and records a provider Error", async () => {
  const provider = await preparedProvider();
  const [activated] = await activateDefinitions({
    installedCapabilities: ["repository.read"], installedIntents: ["task.note"], installedRunnerProfiles: ["read-only"],
    provider, supportedModels: { model: ["medium"] },
  });
  assert.ok(activated);
  const runner: AgentRunnerAdapter = {
    id: "runner",
    async identity() { return { executableDigest: sha256("runner"), executableVersion: "1.0.0", id: "runner" }; },
    async start() { return completedProcess({ exitCode: 0, stderr: "", stdout: "{}", toolViolation: "write outside allowed root" }); },
  };
  await assert.rejects(dispatchActivatedAgent({
    activated, additionalInput: {}, modelTransport, outputLimitBytes: 10_000, provider, runId: "run-violation", runner,
    taskId: "task-1", toolIsolation: isolation,
    toolPolicy: { allowedEnvironmentNames: [], allowedReadRoots: [], allowedWriteRoots: [], network: { allowedOrigins: [], mode: "none" }, runId: "run-violation" },
  }), /Unauthorized tool operation/);
  assert.equal(provider.errors.length, 1);
  assert.equal(provider.errors[0]?.relatedSubAgentId, "analyst");
});

test("terminates and hard-kills a process tree that exceeds its deadline", async () => {
  let finish!: (value: AgentProcessCompletion) => void;
  const waiting = new Promise<AgentProcessCompletion>((resolve) => { finish = resolve; });
  let terminated = 0;
  let killed = 0;
  const process: SupervisedAgentProcess = {
    async killTree() { killed += 1; finish({ exitCode: null, stderr: "", stdout: "", toolViolation: null }); },
    async terminateTree() { terminated += 1; },
    async wait() { return waiting; },
  };
  const result = await superviseProcess({ deadlineMilliseconds: 1, graceMilliseconds: 1, outputLimitBytes: 100, process });
  assert.equal(terminated, 1);
  assert.equal(killed, 1);
  assert.equal(result.telemetry.timedOut, true);
  assert.equal(result.telemetry.hardKilled, true);
});

async function preparedProvider(): Promise<RecordingProvider> {
  const provider = new RecordingProvider(environment, target);
  const definition = agentDefinition();
  provider.seedDefinition(definition);
  provider.seedTaskStatusOptions(["Done"]);
  provider.seedTask({ archived: false, body: "Task body", dependencies: [], id: "task-1", priority: 1, properties: { Status: "Todo" }, status: "Todo", title: "Task", version: "v1" });
  for (const record of resources()) await provider.putResource(record);
  return provider;
}

function agentDefinition(): SubAgentDefinition {
  return {
    allowedIntents: ["task.note"], capabilities: ["repository.read"], contextBudgetBytes: 100_000,
    deadlineSeconds: 60, enabled: true, id: "analyst", inputResourceSelectors: [], invocation: { mode: "manual", scheduleResource: null },
    maxAssignmentDepth: 1, maxAssignmentsPerRun: 1, maxConcurrency: 1, model: "model", name: "Analyst", outputSchema: "schema/output",
    priority: 1, prohibitedCapabilities: [], promptResources: ["prompt/analyst"], reasoning: "medium", requiredProviderCapabilities: [],
    retry: { maxAttempts: 1, noVerdict: "block" }, revision: 1, runnerProfile: "read-only", schema: "sub-agent-definition-v1",
    selection: { acceptsAssignmentsFrom: ["explicit", "self"], maxCandidateSummaries: 1, mode: "self", resultSchema: "schema/selection", taskQueryResource: "query/analyst" },
    transitions: { succeeded: "Done" },
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
function completedProcess(completion: AgentProcessCompletion): SupervisedAgentProcess {
  return { async killTree() {}, async terminateTree() {}, async wait() { return completion; } };
}
