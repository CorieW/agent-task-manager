/** Verifies that blocked outcome routing cannot bypass durable human recovery. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REVIEW_CYCLE_POLICY,
  DEFAULT_TEST_CYCLE_POLICY,
  InMemoryProvider,
  OutcomeTransitionBroker,
  ReviewCycleLimitError,
  TestCycleLimitError,
  advanceTestCycle,
  type ProviderEnvironment,
  type AgentDefinition,
  type JsonObject,
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

test("persists review-cycle state with a changes-requested transition", async () => {
  /** Defines the provider fixture for the review-cycle transition. */
  const provider = providerWithTask("Review");
  /** Defines the broker fixture for the review-cycle transition. */
  const broker = new OutcomeTransitionBroker(provider);
  await broker.apply({
    definition: reviewDefinition(),
    idempotencyKey: "review-round-1",
    kind: "task_transition",
    outcome: "changes_requested",
    reviewCycle: { findingKeys: ["cleanliness:src/a.ts:duplicate"] },
    taskId: "task-1",
  });

  /** Reads the atomically advanced Task state. */
  const task = await provider.getTaskSnapshot("task-1");
  assert.equal(task.status, "Coding");
  assert.equal(task.properties["Remediation Source"], "Review");
  assert.equal(task.properties[DEFAULT_REVIEW_CYCLE_POLICY.roundProperty], 1);
  assert.equal(
    task.properties[DEFAULT_REVIEW_CYCLE_POLICY.repeatCountProperty],
    1,
  );
  assert.equal(
    task.properties[DEFAULT_REVIEW_CYCLE_POLICY.findingKeysProperty],
    '["cleanliness:src/a.ts:duplicate"]',
  );
  assert.match(
    String(task.properties[DEFAULT_REVIEW_CYCLE_POLICY.findingsDigestProperty]),
    /^[a-f0-9]{64}$/u,
  );
});

test("persists review-cycle state when the routed status is unchanged", async () => {
  /** Defines a review outcome that deliberately remains in Review. */
  const reviewInPlaceDefinition = {
    ...reviewDefinition(),
    transitions: {
      ...reviewDefinition().transitions,
      changes_requested: "Review",
    },
  };
  /** Defines the provider fixture for an in-place review transition. */
  const provider = providerWithTask("Review");
  /** Defines the broker fixture for an in-place review transition. */
  const broker = new OutcomeTransitionBroker(provider);

  await broker.apply({
    definition: reviewInPlaceDefinition,
    idempotencyKey: "review-in-place",
    kind: "task_transition",
    outcome: "changes_requested",
    reviewCycle: { findingKeys: ["branch:src/a.ts:race"] },
    taskId: "task-1",
  });

  /** Reads the Task after the same-status conditional mutation. */
  const task = await provider.getTaskSnapshot("task-1");
  assert.equal(task.status, "Review");
  assert.equal(task.properties[DEFAULT_REVIEW_CYCLE_POLICY.roundProperty], 1);
});

test("blocks a repeated finding set before another coding round", async () => {
  /** Defines the provider fixture for repeated review findings. */
  const provider = providerWithTask("Review", {
    "Review Finding Keys": '["branch:src/a.ts:race"]',
    "Review Findings Digest":
      "6e2f9539d5ff95a9793f4fb415edf5c93ce09abc5e7f5f44c9e477cdd8a5dd57",
    "Review Repeat Count": 1,
    "Review Round": 1,
  });
  /** Defines the broker fixture for repeated review findings. */
  const broker = new OutcomeTransitionBroker(provider);

  await assert.rejects(
    broker.apply({
      definition: reviewDefinition(),
      idempotencyKey: "review-repeat",
      kind: "task_transition",
      outcome: "changes_requested",
      reviewCycle: { findingKeys: ["branch:src/a.ts:race"] },
      taskId: "task-1",
    }),
    (error: unknown) =>
      error instanceof ReviewCycleLimitError &&
      error.reason === "identical_findings_repeated",
  );
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Review");
});

test("blocks review cycles after three changes-requested rounds", async () => {
  /** Defines the provider fixture at the automatic review-round ceiling. */
  const provider = providerWithTask("Review", {
    "Review Finding Keys": '["readability:src/a.ts:naming"]',
    "Review Findings Digest":
      "843b894a6ea76cafa05041ef37f989735d92517040e4740a086c0ef13a520195",
    "Review Repeat Count": 1,
    "Review Round": 3,
  });
  /** Defines the broker fixture at the automatic review-round ceiling. */
  const broker = new OutcomeTransitionBroker(provider);

  await assert.rejects(
    broker.apply({
      definition: reviewDefinition(),
      idempotencyKey: "review-round-limit",
      kind: "task_transition",
      outcome: "changes_requested",
      reviewCycle: { findingKeys: ["branch:src/b.ts:validation"] },
      taskId: "task-1",
    }),
    (error: unknown) =>
      error instanceof ReviewCycleLimitError &&
      error.reason === "review_round_limit",
  );
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Review");
});

test("persists test-cycle state with a failed transition", async () => {
  /** Defines the provider fixture for the failed test transition. */
  const provider = providerWithTask("In progress");
  /** Defines the broker fixture for the failed test transition. */
  const broker = new OutcomeTransitionBroker(provider);

  await broker.apply({
    definition: testDefinition(),
    idempotencyKey: "test-round-1",
    kind: "task_transition",
    outcome: "failed",
    taskId: "task-1",
    testCycle: { failureKeys: ["unit:src/a.test.ts:returns-wrong-value"] },
  });

  /** Reads the atomically advanced Task state. */
  const task = await provider.getTaskSnapshot("task-1");
  assert.equal(task.status, "Planned");
  assert.equal(task.properties["Remediation Source"], "Test");
  assert.equal(task.properties[DEFAULT_TEST_CYCLE_POLICY.roundProperty], 1);
  assert.equal(
    task.properties[DEFAULT_TEST_CYCLE_POLICY.repeatCountProperty],
    1,
  );
  assert.equal(
    task.properties[DEFAULT_TEST_CYCLE_POLICY.failureKeysProperty],
    '["unit:src/a.test.ts:returns-wrong-value"]',
  );
  assert.match(
    String(task.properties[DEFAULT_TEST_CYCLE_POLICY.failuresDigestProperty]),
    /^[a-f0-9]{64}$/u,
  );
});

test("blocks a repeated test failure set before another coding round", async () => {
  /** Builds one valid prior failure state without duplicating digest logic. */
  const prior = advanceTestCycle({ Status: "In progress" }, [
    "unit:src/a.test.ts:returns-wrong-value",
  ]).nextProperties;
  /** Defines the provider fixture for repeated test failures. */
  const provider = providerWithTask("In progress", prior);
  /** Defines the broker fixture for repeated test failures. */
  const broker = new OutcomeTransitionBroker(provider);

  await assert.rejects(
    broker.apply({
      definition: testDefinition(),
      idempotencyKey: "test-repeat",
      kind: "task_transition",
      outcome: "failed",
      taskId: "task-1",
      testCycle: { failureKeys: ["unit:src/a.test.ts:returns-wrong-value"] },
    }),
    (error: unknown) =>
      error instanceof TestCycleLimitError &&
      error.reason === "identical_failures_repeated",
  );
  assert.equal(
    (await provider.getTaskSnapshot("task-1")).status,
    "In progress",
  );
});

test("blocks test cycles after three failed rounds", async () => {
  /** Builds a valid prior failure state at the automatic test-round ceiling. */
  const prior = {
    ...advanceTestCycle({ Status: "In progress" }, [
      "unit:src/a.test.ts:returns-wrong-value",
    ]).nextProperties,
    "Test Round": 3,
  };
  /** Defines the provider fixture at the automatic test-round ceiling. */
  const provider = providerWithTask("In progress", prior);
  /** Defines the broker fixture at the automatic test-round ceiling. */
  const broker = new OutcomeTransitionBroker(provider);

  await assert.rejects(
    broker.apply({
      definition: testDefinition(),
      idempotencyKey: "test-round-limit",
      kind: "task_transition",
      outcome: "failed",
      taskId: "task-1",
      testCycle: { failureKeys: ["integration:api:timeout"] },
    }),
    (error: unknown) =>
      error instanceof TestCycleLimitError &&
      error.reason === "test_round_limit",
  );
  assert.equal(
    (await provider.getTaskSnapshot("task-1")).status,
    "In progress",
  );
});

/** Creates the provider with task test fixture. */
function providerWithTask(
  status = "Coding",
  properties: JsonObject = {},
): InMemoryProvider {
  /** Defines the provider fixture used by provider with task. */
  const provider = new InMemoryProvider(environment, target);
  provider.seedTaskStatusOptions([
    "Coding",
    "Completed",
    "In progress",
    "Needs Human Resolution",
    "Planned",
    "Review",
  ]);
  provider.seedTask({
    archived: false,
    body: "Task body",
    dependencies: [],
    id: "task-1",
    priority: 1,
    properties: { ...properties, Status: status },
    status,
    title: "Task",
    version: "v1",
  });
  return provider;
}

/** Creates the Code Tester definition fixture. */
function testDefinition(): AgentDefinition {
  return {
    ...definition(),
    humanResolutionOutcomes: ["blocked"],
    id: "tester",
    name: "Tester",
    transitions: {
      blocked: "Needs Human Resolution",
      failed: "Planned",
      succeeded: "Completed",
    },
  };
}

/** Creates the review Agent definition fixture. */
function reviewDefinition(): AgentDefinition {
  return {
    ...definition(),
    humanResolutionOutcomes: ["blocked"],
    id: "reviewer",
    name: "Reviewer",
    transitions: {
      blocked: "Needs Human Resolution",
      changes_requested: "Coding",
      succeeded: "Testing",
    },
  };
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
