// Verifies blocker-first human routing and exactly-once response consumption.
import assert from "node:assert/strict";
import test from "node:test";

import { HumanRecoveryManager, InMemoryProvider, parseHumanInteractionSlots, renderHumanInteractionSlot, type ProviderEnvironment, type WorkspaceSchemaDescriptor } from "../src/index.js";

const environment: ProviderEnvironment = { bootstrapParent: null, connection: {}, tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" }, type: "memory" };
const target: WorkspaceSchemaDescriptor = { digest: "target", providerType: "memory", tables: [], version: "v1" };

test("creates a stable Error and resolution slot before Needs Human Resolution", async () => {
  const provider = prepared(); const manager = new HumanRecoveryManager(provider);
  const receipt = await manager.requestResolution({ createdAt: "2026-08-15T10:00:00.000Z", error: { description: "Publication is not configured.", errorKey: "publication/missing", relatedRunId: "run-1", relatedSubAgentId: "coder", resolution: "Configure a draft publication target, then choose resume.", severity: "high", title: "Publication unavailable" }, generation: 1, prompt: "Resolve publication configuration and resume coding.", requestedBy: "coder", resumeStatus: "Coding", taskId: "task-1", waitingStatus: "Needs Human Resolution" });
  assert.equal(receipt.status, "Needs Human Resolution");
  const stored = await provider.getTaskSnapshot("task-1"); const slots = parseHumanInteractionSlots(stored.body);
  assert.equal(slots.length, 1); assert.equal(slots[0]?.sourceErrorKey, "publication/missing");
  assert.equal((await provider.getOptionalResource(`human-slot/${receipt.slot.slotId}`))?.kind, "system/human-interaction-slot");
});

test("consumes one allowed human response and replays without another transition", async () => {
  const provider = prepared(); const manager = new HumanRecoveryManager(provider);
  const requested = await manager.request({ createdAt: "2026-08-15T10:00:00.000Z", error: null, generation: 1, kind: "review", prompt: "Approve or return.", requestedBy: "reviewer", routes: { approve: "Testing", return: "Coding" }, sourceErrorKey: null, taskId: "task-1", waitingStatus: "Human Review" });
  let task = await provider.getTaskSnapshot("task-1"); const edited = { ...requested.slot, response: { action: "approve", text: "Approved." } };
  await provider.applyTaskMutation({ expectedVersion: task.version, idempotencyKey: "human-edit", nextBody: task.body.replace(renderHumanInteractionSlot(requested.slot), renderHumanInteractionSlot(edited)), nextProperties: task.properties, nextStatus: null, taskId: task.id });
  const first = await manager.consume("task-1", requested.slot.slotId); const second = await manager.consume("task-1", requested.slot.slotId);
  assert.equal(first.state, "applied"); assert.deepEqual(second, first);
  task = await provider.getTaskSnapshot("task-1"); assert.equal(task.status, "Testing");
});

function prepared(): InMemoryProvider {
  const provider = new InMemoryProvider(environment, target); provider.seedTaskStatusOptions(["Coding", "Human Review", "Needs Human Resolution", "Testing", "Todo"]); provider.seedTask({ archived: false, body: "Task context", dependencies: [], id: "task-1", priority: 1, properties: { Status: "Todo", custom: "preserved" }, status: "Todo", title: "Task", version: "v1" }); return provider;
}
