/** Verifies that blocked outcome routing cannot bypass durable human recovery. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryProvider,
  OutcomeTransitionBroker,
  type ProviderEnvironment,
  type AgentDefinition,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";

/** Defines the shared environment fixture for this test module. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: {
    errors: "errors",
    resources: "resources",
    agents: "agents",
    tasks: "tasks",
  },
  type: "memory",
};
/** Defines the shared target fixture for this test module. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};

test("requires and persists human recovery for an explicitly declared outcome", async () => {
  /** Defines the provider fixture for “requires and persists human recovery for an explicitly declared outcome”. */
  const provider = providerWithTask();
  /** Defines the broker fixture for “requires and persists human recovery for an explicitly declared outcome”. */
  const broker = new OutcomeTransitionBroker(provider);
  await assert.rejects(
    broker.apply({
      definition: definition(),
      idempotencyKey: "failed",
      kind: "task_transition",
      outcome: "failed",
      taskId: "task-1",
    }),
    /durable human resolution/u,
  );
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Coding");

  /** Defines the receipt fixture for “requires and persists human recovery for an explicitly declared outcome”. */
  const receipt = await broker.apply({
    resolution: {
      createdAt: "2026-08-15T10:00:00.000Z",
      error: {
        description: "The configured publication target is unavailable.",
        errorKey: "publication-target",
        relatedRunId: "run-1",
        relatedAgentId: "writer",
        resolution: "Configure a valid target and resume Coding.",
        severity: "high",
        status: "Not Fixed",
        title: "Publication target unavailable",
      },
      generation: 1,
      prompt: "Configure the publication target, then choose resume.",
      requestedBy: "writer",
      resumeStatus: "Coding",
    },
    definition: definition(),
    kind: "human_resolution",
    outcome: "failed",
    taskId: "task-1",
  });
  assert.equal(receipt.kind, "human_resolution");
  assert.equal(receipt.targetStatus, "Needs Human Resolution");
  assert.match(receipt.humanSlotId ?? "", /^[a-f0-9]{64}$/u);
  assert.match(
    (await provider.getTaskSnapshot("task-1")).body,
    /agent-task-manager:human-slot/u,
  );
});

test("routes ordinary outcomes without accepting human recovery payloads", async () => {
  /** Defines the provider fixture for “routes ordinary outcomes without accepting human recovery payloads”. */
  const provider = providerWithTask();
  /** Defines the broker fixture for “routes ordinary outcomes without accepting human recovery payloads”. */
  const broker = new OutcomeTransitionBroker(provider);
  /** Defines the receipt fixture for “routes ordinary outcomes without accepting human recovery payloads”. */
  const receipt = await broker.apply({
    definition: definition(),
    idempotencyKey: "success",
    kind: "task_transition",
    outcome: "succeeded",
    taskId: "task-1",
  });
  assert.equal(receipt.kind, "task_transition");
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Review");
});

/** Creates the provider with task test fixture. */
function providerWithTask(): InMemoryProvider {
  /** Defines the provider fixture used by provider with task. */
  const provider = new InMemoryProvider(environment, target);
  provider.seedTaskStatusOptions([
    "Coding",
    "Needs Human Resolution",
    "Review",
  ]);
  provider.seedTask({
    archived: false,
    body: "Task body",
    dependencies: [],
    id: "task-1",
    priority: 1,
    properties: { Status: "Coding" },
    status: "Coding",
    title: "Task",
    version: "v1",
  });
  return provider;
}

/** Creates an Agent definition fixture. */
function definition(): AgentDefinition {
  return {
    allowedIntents: ["task.status.transition"],
    capabilities: [],
    contextBudgetBytes: 1000,
    deadlineSeconds: 60,
    enabled: true,
    humanResolutionOutcomes: ["failed"],
    id: "writer",
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    maxAssignmentDepth: 1,
    maxAssignmentsPerRun: 1,
    maxConcurrency: 1,
    model: "model",
    name: "Writer",
    outputSchema: "schema/result",
    priority: 1,
    prohibitedCapabilities: [],
    promptResources: [],
    reasoning: "medium",
    requiredProviderCapabilities: [],
    retry: { maxAttempts: 1, noVerdict: "block" },
    revision: 1,
    runnerProfile: "runner",
    schema: "agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: ["explicit"],
      maxCandidateSummaries: 1,
      mode: "explicit",
      resultSchema: "schema/selection",
      taskQueryResource: null,
    },
    transitions: { failed: "Needs Human Resolution", succeeded: "Review" },
  };
}
