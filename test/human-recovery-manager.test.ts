/** Verifies blocker-first human routing and exactly-once response consumption. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HumanRecoveryManager,
  InMemoryProvider,
  inspectHumanRecovery,
  parseHumanInteractionSlots,
  parseAgentDefinitionManifest,
  reconcileActivity,
  renderHumanInteractionSlot,
  type ConditionalTaskMutation,
  type JsonObject,
  type ProviderEnvironment,
  type WriteReceipt,
  type WorkspaceSchemaDescriptor,
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

test("creates a stable Error and resolution slot before Needs Human Resolution", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = prepared();
  /** Coordinates the human-recovery workflow under test. */
  const manager = new HumanRecoveryManager(provider);
  /** Captures the durable write or effect result used as the oracle. */
  const receipt = await manager.requestResolution({
    createdAt: "2026-08-15T10:00:00.000Z",
    error: {
      description: "Publication is not configured.",
      errorKey: "publication/missing",
      relatedRunId: "run-1",
      relatedAgentId: "coder",
      resolution: "Configure a draft publication target, then choose resume.",
      severity: "high",
      status: "Not Fixed",
      title: "Publication unavailable",
    },
    generation: 1,
    prompt: "Resolve publication configuration and resume coding.",
    requestedBy: "coder",
    resumeStatus: "Coding",
    taskId: "task-1",
    waitingStatus: "Needs Human Resolution",
  });
  assert.equal(receipt.status, "Needs Human Resolution");
  /** Reads persisted state used as the assertion oracle. */
  const stored = await provider.getTaskSnapshot("task-1");
  /** Captures the parsed human-response slots. */
  const slots = parseHumanInteractionSlots(stored.body);
  assert.equal(slots.length, 1);
  assert.equal(slots[0]?.sourceErrorKey, "publication/missing");
  assert.equal(
    (
      await provider.getOptionalResource(
        `system/human-slot/${receipt.slot.slotId}`,
      )
    )?.kind,
    "system/human-interaction-slot",
  );
  /** Captures the human-interaction state used as the oracle. */
  const inspection = await inspectHumanRecovery(provider, "task-1");
  assert.deepEqual(inspection.slots, [
    {
      baselineValid: true,
      consumptionState: "none",
      kind: "resolution",
      responseState: "blank",
      slotId: receipt.slot.slotId,
    },
  ]);
});

test("replays a slot baseline after provider identity-set reordering", async () => {
  /** Provider retaining the baseline and mutable Task snapshot. */
  const provider = prepared();
  provider.seedTask({
    archived: false,
    body: "Original body",
    dependencies: [],
    id: "task-set-order",
    priority: 1,
    properties: { Related: ["task-b", "task-a"], Status: "Todo" },
    status: "Todo",
    title: "Set ordering",
    version: "v1",
  });
  /** Human recovery manager exercising the immutable baseline replay. */
  const manager = new HumanRecoveryManager(provider);
  /** Stable request reused after the provider reorders a relation collection. */
  const request = {
    createdAt: "2026-08-16T19:00:00.000Z",
    error: null,
    generation: 1,
    kind: "answer" as const,
    prompt: "Choose an option.",
    requestedBy: "planner",
    routes: { continue: "Todo" },
    sourceErrorKey: null,
    taskId: "task-set-order",
    waitingStatus: "Needs Human Resolution",
  };
  await manager.request(request);
  /** Installed Task snapshot whose relation order is provider-controlled. */
  const installed = await provider.getTaskSnapshot("task-set-order");
  await provider.applyTaskMutation({
    expectedVersion: installed.version,
    idempotencyKey: "provider-reorders-relations",
    nextBody: null,
    nextProperties: { ...installed.properties, Related: ["task-a", "task-b"] },
    nextStatus: null,
    taskId: installed.id,
  });

  /** Exact semantic replay accepted despite the provider's relation ordering. */
  const replay = await manager.request(request);
  assert.equal(replay.status, "Needs Human Resolution");
});

test("consumes one allowed human response and replays without another transition", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = prepared();
  /** Coordinates the human-recovery workflow under test. */
  const manager = new HumanRecoveryManager(provider);
  /** Captures the persisted human-recovery request. */
  const requested = await manager.request({
    createdAt: "2026-08-15T10:00:00.000Z",
    error: null,
    generation: 1,
    kind: "review",
    prompt: "Approve or return.",
    requestedBy: "reviewer",
    routes: { approve: "Testing", return: "Coding" },
    sourceErrorKey: null,
    taskId: "task-1",
    waitingStatus: "Human Review",
  });
  /** Represents the Task state exercised by the scenario. */
  let task = await provider.getTaskSnapshot("task-1");
  /** Represents the Task after the permitted human edit. */
  const edited = {
    ...requested.slot,
    response: { action: "approve", text: "Approved." },
  };
  await provider.applyTaskMutation({
    expectedVersion: task.version,
    idempotencyKey: "human-edit",
    nextBody: task.body.replace(
      renderHumanInteractionSlot(requested.slot),
      renderHumanInteractionSlot(edited),
    ),
    nextProperties: task.properties,
    nextStatus: null,
    taskId: task.id,
  });
  /** Captures the first operation result for replay comparison. */
  const first = await manager.consume("task-1", requested.slot.slotId);
  /** Captures the replayed result for idempotency comparison. */
  const second = await manager.consume("task-1", requested.slot.slotId);
  assert.equal(first.state, "applied");
  assert.deepEqual(second, first);
  task = await provider.getTaskSnapshot("task-1");
  assert.equal(task.status, "Testing");
  assert.equal(task.properties.Status, "Testing");
  /** Captures the human-interaction state used as the oracle. */
  const inspection = await inspectHumanRecovery(provider, "task-1");
  assert.equal(inspection.slots[0]?.consumptionState, "applied");
  assert.equal(inspection.slots[0]?.responseState, "completed");
});

test("rejects a response accompanied by unrelated Task body changes", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = prepared();
  /** Coordinates the human-recovery workflow under test. */
  const manager = new HumanRecoveryManager(provider);
  /** Captures the persisted human-recovery request. */
  const requested = await manager.request({
    createdAt: "2026-08-15T10:00:00.000Z",
    error: null,
    generation: 1,
    kind: "answer",
    prompt: "Choose resume.",
    requestedBy: "worker",
    routes: { resume: "Coding" },
    sourceErrorKey: null,
    taskId: "task-1",
    waitingStatus: "Human Review",
  });
  /** Represents the Task state exercised by the scenario. */
  const task = await provider.getTaskSnapshot("task-1");
  /** Represents the Task after the permitted human edit. */
  const edited = {
    ...requested.slot,
    response: { action: "resume", text: "Resolved." },
  };
  await provider.applyTaskMutation({
    expectedVersion: task.version,
    idempotencyKey: "human-edit-with-drift",
    nextBody: `${task.body.replace(renderHumanInteractionSlot(requested.slot), renderHumanInteractionSlot(edited))}\n\nUnrelated edit`,
    nextProperties: task.properties,
    nextStatus: null,
    taskId: task.id,
  });
  await assert.rejects(
    manager.consume("task-1", requested.slot.slotId),
    /unrelated Task body content/u,
  );
});

test("does not adopt a target status that changed before consumption", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = prepared();
  /** Coordinates the human-recovery workflow under test. */
  const manager = new HumanRecoveryManager(provider);
  /** Captures the persisted human-recovery request. */
  const requested = await manager.request({
    createdAt: "2026-08-15T10:00:00.000Z",
    error: null,
    generation: 1,
    kind: "review",
    prompt: "Approve.",
    requestedBy: "worker",
    routes: { approve: "Testing" },
    sourceErrorKey: null,
    taskId: "task-1",
    waitingStatus: "Human Review",
  });
  /** Represents the Task state exercised by the scenario. */
  let task = await provider.getTaskSnapshot("task-1");
  /** Represents the Task after the permitted human edit. */
  const edited = {
    ...requested.slot,
    response: { action: "approve", text: "Approved." },
  };
  await provider.applyTaskMutation({
    expectedVersion: task.version,
    idempotencyKey: "human-edit-before-drift",
    nextBody: task.body.replace(
      renderHumanInteractionSlot(requested.slot),
      renderHumanInteractionSlot(edited),
    ),
    nextProperties: task.properties,
    nextStatus: null,
    taskId: task.id,
  });
  task = await provider.getTaskSnapshot("task-1");
  await provider.applyTaskMutation({
    expectedVersion: task.version,
    idempotencyKey: "unrelated-status",
    nextBody: null,
    nextProperties: task.properties,
    nextStatus: "Testing",
    taskId: task.id,
  });
  await assert.rejects(
    manager.consume("task-1", requested.slot.slotId),
    /waiting status/u,
  );
});

test("does not adopt a coincidental target status after consumption becomes pending", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = interrupted();
  /** Coordinates the human-recovery workflow under test. */
  const manager = new HumanRecoveryManager(provider);
  /** Captures the persisted human-recovery request. */
  const requested = await manager.request({
    createdAt: "2026-08-15T10:00:00.000Z",
    error: null,
    generation: 1,
    kind: "review",
    prompt: "Approve.",
    requestedBy: "worker",
    routes: { approve: "Testing" },
    sourceErrorKey: null,
    taskId: "task-1",
    waitingStatus: "Human Review",
  });
  /** Represents the Task state exercised by the scenario. */
  let task = await provider.getTaskSnapshot("task-1");
  /** Represents the Task after the permitted human edit. */
  const edited = {
    ...requested.slot,
    response: { action: "approve", text: "Approved." },
  };
  await provider.applyTaskMutation({
    expectedVersion: task.version,
    idempotencyKey: "human-edit-before-interrupt",
    nextBody: task.body.replace(
      renderHumanInteractionSlot(requested.slot),
      renderHumanInteractionSlot(edited),
    ),
    nextProperties: task.properties,
    nextStatus: null,
    taskId: task.id,
  });
  await assert.rejects(
    manager.consume("task-1", requested.slot.slotId),
    /simulated interruption/u,
  );
  task = await provider.getTaskSnapshot("task-1");
  await provider.applyTaskMutation({
    expectedVersion: task.version,
    idempotencyKey: "coincidental-target",
    nextBody: null,
    nextProperties: task.properties,
    nextStatus: "Testing",
    taskId: task.id,
  });
  await assert.rejects(
    manager.consume("task-1", requested.slot.slotId),
    /version conflict/u,
  );
});

test("rejects Task archival during a human wait", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = prepared();
  /** Coordinates the human-recovery workflow under test. */
  const manager = new HumanRecoveryManager(provider);
  /** Captures the persisted human-recovery request. */
  const requested = await manager.request({
    createdAt: "2026-08-15T10:00:00.000Z",
    error: null,
    generation: 1,
    kind: "answer",
    prompt: "Resume?",
    requestedBy: "worker",
    routes: { resume: "Coding" },
    sourceErrorKey: null,
    taskId: "task-1",
    waitingStatus: "Human Review",
  });
  /** Represents the Task state exercised by the scenario. */
  let task = await provider.getTaskSnapshot("task-1");
  /** Represents the Task after the permitted human edit. */
  const edited = {
    ...requested.slot,
    response: { action: "resume", text: "Resume." },
  };
  await provider.applyTaskMutation({
    expectedVersion: task.version,
    idempotencyKey: "human-edit-before-archive",
    nextBody: task.body.replace(
      renderHumanInteractionSlot(requested.slot),
      renderHumanInteractionSlot(edited),
    ),
    nextProperties: task.properties,
    nextStatus: null,
    taskId: task.id,
  });
  task = await provider.getTaskSnapshot("task-1");
  provider.seedTask({ ...task, archived: true, version: "archived-v1" });
  await assert.rejects(
    manager.consume("task-1", requested.slot.slotId),
    /archive state/u,
  );
});

test("reconciles stale Status and Working On from provider-backed leases", async () => {
  /** Controls the simulated provider clock deterministically. */
  let now = new Date("2026-08-15T10:00:00.000Z");
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(
    environment,
    target,
    undefined,
    () => now,
  );
  /** Supplies the Agent contract exercised by the scenario. */
  const definition = parseAgentDefinitionManifest(definitionManifest());
  provider.seedDefinition(definition);
  provider.seedTask({
    archived: false,
    body: "Task",
    dependencies: [],
    id: "task-1",
    priority: 1,
    properties: { Status: "Todo" },
    status: "Todo",
    title: "Task",
    version: "v1",
  });
  /** Represents the active Agent run exercised by the scenario. */
  const run = await provider.acquireLease({
    expiresAt: "2026-08-15T10:05:00.000Z",
    idempotencyKey: "run",
    ownerId: "owner",
    scope: "agent_run",
    agentId: definition.id,
    taskId: null,
  });
  /** Represents the Task state exercised by the scenario. */
  const task = await provider.acquireLease({
    expiresAt: "2026-08-15T10:05:00.000Z",
    idempotencyKey: "task",
    ownerId: "owner",
    scope: "task_assignment",
    agentId: definition.id,
    taskId: "task-1",
  });
  await provider.updateAgentActivity({
    expectedRunLeaseIds: [],
    expectedTaskIds: [],
    idempotencyKey: "online",
    nextRunLeaseIds: [run.leaseId!],
    nextTaskIds: ["task-1"],
    agentId: definition.id,
  });
  now = new Date("2026-08-15T10:10:00.000Z");
  assert.equal(
    (await reconcileActivity(provider, definition.id)).state,
    "applied",
  );
  assert.deepEqual(await provider.getAgentActivity(definition.id), {
    status: "Offline",
    taskIds: [],
    version: "2",
  });
  assert.equal(task.acquired, true);
});

/** Creates an in-memory provider populated for human-recovery tests. */
function prepared(): InMemoryProvider {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  provider.seedTaskStatusOptions([
    "Coding",
    "Human Review",
    "Needs Human Resolution",
    "Testing",
    "Todo",
  ]);
  provider.seedTask({
    archived: false,
    body: "Task context",
    dependencies: [],
    id: "task-1",
    priority: 1,
    properties: { Status: "Todo", custom: "preserved" },
    status: "Todo",
    title: "Task",
    version: "v1",
  });
  return provider;
}

/** Builds a provider that interrupts one human-response mutation. */
function interrupted(): InterruptingProvider {
  /** Provides isolated provider state for the scenario. */
  const provider = new InterruptingProvider(environment, target);
  provider.seedTaskStatusOptions([
    "Coding",
    "Human Review",
    "Needs Human Resolution",
    "Testing",
    "Todo",
  ]);
  provider.seedTask({
    archived: false,
    body: "Task context",
    dependencies: [],
    id: "task-1",
    priority: 1,
    properties: { Status: "Todo", custom: "preserved" },
    status: "Todo",
    title: "Task",
    version: "v1",
  });
  return provider;
}

/** Implements interrupting provider. */
class InterruptingProvider extends InMemoryProvider {
  /** Arms the provider to interrupt one human-response mutation. */
  #interrupt = true;
  /** Applies task mutation. */
  public override async applyTaskMutation(
    mutation: ConditionalTaskMutation,
  ): Promise<WriteReceipt> {
    if (
      this.#interrupt &&
      mutation.idempotencyKey.startsWith("human-consume:")
    ) {
      this.#interrupt = false;
      throw new Error("simulated interruption");
    }
    return super.applyTaskMutation(mutation);
  }
}

/** Builds the Agent manifest used by recovery scenarios. */
function definitionManifest(): JsonObject {
  return {
    allowedIntents: [],
    capabilities: [],
    contextBudgetBytes: 1000,
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
    runnerProfile: "runner",
    schema: "agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: ["explicit"],
      maxCandidateSummaries: 1,
      mode: "explicit",
      resultSchema: "schema/result",
      taskQueryResource: null,
    },
    transitions: { succeeded: "Done" },
  };
}
