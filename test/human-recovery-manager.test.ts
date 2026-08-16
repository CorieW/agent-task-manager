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

/** Defines the shared environment fixture for this test module. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: "e", resources: "r", agents: "a", tasks: "t" },
  type: "memory",
};
/** Defines the shared target fixture for this test module. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};

test("creates a stable Error and resolution slot before Needs Human Resolution", async () => {
  /** Defines the provider fixture for “creates a stable Error and resolution slot before Needs Human Resolution”. */
  const provider = prepared();
  /** Defines the manager fixture for “creates a stable Error and resolution slot before Needs Human Resolution”. */
  const manager = new HumanRecoveryManager(provider);
  /** Defines the receipt fixture for “creates a stable Error and resolution slot before Needs Human Resolution”. */
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
  /** Defines the stored fixture for “creates a stable Error and resolution slot before Needs Human Resolution”. */
  const stored = await provider.getTaskSnapshot("task-1");
  /** Defines the slots fixture for “creates a stable Error and resolution slot before Needs Human Resolution”. */
  const slots = parseHumanInteractionSlots(stored.body);
  assert.equal(slots.length, 1);
  assert.equal(slots[0]?.sourceErrorKey, "publication/missing");
  assert.equal(
    (await provider.getOptionalResource(`human-slot/${receipt.slot.slotId}`))
      ?.kind,
    "system/human-interaction-slot",
  );
  /** Defines the inspection fixture for “creates a stable Error and resolution slot before Needs Human Resolution”. */
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

test("consumes one allowed human response and replays without another transition", async () => {
  /** Defines the provider fixture for “consumes one allowed human response and replays without another transition”. */
  const provider = prepared();
  /** Defines the manager fixture for “consumes one allowed human response and replays without another transition”. */
  const manager = new HumanRecoveryManager(provider);
  /** Defines the requested fixture for “consumes one allowed human response and replays without another transition”. */
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
  /** Defines the task fixture for “consumes one allowed human response and replays without another transition”. */
  let task = await provider.getTaskSnapshot("task-1");
  /** Defines the edited fixture for “consumes one allowed human response and replays without another transition”. */
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
  /** Defines the first fixture for “consumes one allowed human response and replays without another transition”. */
  const first = await manager.consume("task-1", requested.slot.slotId);
  /** Defines the second fixture for “consumes one allowed human response and replays without another transition”. */
  const second = await manager.consume("task-1", requested.slot.slotId);
  assert.equal(first.state, "applied");
  assert.deepEqual(second, first);
  task = await provider.getTaskSnapshot("task-1");
  assert.equal(task.status, "Testing");
  assert.equal(task.properties.Status, "Testing");
  /** Defines the inspection fixture for “consumes one allowed human response and replays without another transition”. */
  const inspection = await inspectHumanRecovery(provider, "task-1");
  assert.equal(inspection.slots[0]?.consumptionState, "applied");
  assert.equal(inspection.slots[0]?.responseState, "completed");
});

test("rejects a response accompanied by unrelated Task body changes", async () => {
  /** Defines the provider fixture for “rejects a response accompanied by unrelated Task body changes”. */
  const provider = prepared();
  /** Defines the manager fixture for “rejects a response accompanied by unrelated Task body changes”. */
  const manager = new HumanRecoveryManager(provider);
  /** Defines the requested fixture for “rejects a response accompanied by unrelated Task body changes”. */
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
  /** Defines the task fixture for “rejects a response accompanied by unrelated Task body changes”. */
  const task = await provider.getTaskSnapshot("task-1");
  /** Defines the edited fixture for “rejects a response accompanied by unrelated Task body changes”. */
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
  /** Defines the provider fixture for “does not adopt a target status that changed before consumption”. */
  const provider = prepared();
  /** Defines the manager fixture for “does not adopt a target status that changed before consumption”. */
  const manager = new HumanRecoveryManager(provider);
  /** Defines the requested fixture for “does not adopt a target status that changed before consumption”. */
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
  /** Defines the task fixture for “does not adopt a target status that changed before consumption”. */
  let task = await provider.getTaskSnapshot("task-1");
  /** Defines the edited fixture for “does not adopt a target status that changed before consumption”. */
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
  /** Defines the provider fixture for “does not adopt a coincidental target status after consumption becomes pending”. */
  const provider = interrupted();
  /** Defines the manager fixture for “does not adopt a coincidental target status after consumption becomes pending”. */
  const manager = new HumanRecoveryManager(provider);
  /** Defines the requested fixture for “does not adopt a coincidental target status after consumption becomes pending”. */
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
  /** Defines the task fixture for “does not adopt a coincidental target status after consumption becomes pending”. */
  let task = await provider.getTaskSnapshot("task-1");
  /** Defines the edited fixture for “does not adopt a coincidental target status after consumption becomes pending”. */
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
  /** Defines the provider fixture for “rejects Task archival during a human wait”. */
  const provider = prepared();
  /** Defines the manager fixture for “rejects Task archival during a human wait”. */
  const manager = new HumanRecoveryManager(provider);
  /** Defines the requested fixture for “rejects Task archival during a human wait”. */
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
  /** Defines the task fixture for “rejects Task archival during a human wait”. */
  let task = await provider.getTaskSnapshot("task-1");
  /** Defines the edited fixture for “rejects Task archival during a human wait”. */
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
  /** Defines the now fixture for “reconciles stale Status and Working On from provider-backed leases”. */
  let now = new Date("2026-08-15T10:00:00.000Z");
  /** Defines the provider fixture for “reconciles stale Status and Working On from provider-backed leases”. */
  const provider = new InMemoryProvider(
    environment,
    target,
    undefined,
    () => now,
  );
  /** Defines the definition fixture for “reconciles stale Status and Working On from provider-backed leases”. */
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
  /** Defines the run fixture for “reconciles stale Status and Working On from provider-backed leases”. */
  const run = await provider.acquireLease({
    expiresAt: "2026-08-15T10:05:00.000Z",
    idempotencyKey: "run",
    ownerId: "owner",
    scope: "agent_run",
    agentId: definition.id,
    taskId: null,
  });
  /** Defines the task fixture for “reconciles stale Status and Working On from provider-backed leases”. */
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
  /** Defines the provider fixture used by prepared. */
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

/** Creates the interrupted test fixture. */
function interrupted(): InterruptingProvider {
  /** Defines the provider fixture used by interrupted. */
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
  /** Contains interrupt for interrupting provider. */
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

/** Creates the definition manifest test fixture. */
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
