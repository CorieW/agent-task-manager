/** Verifies canonical human slots and machine-owned allowed-delta boundaries. */
import assert from "node:assert/strict";
import test from "node:test";

import { appendHumanInteractionSlot, createHumanInteractionSlot, parseHumanInteractionSlots, renderHumanInteractionSlot, verifyAllowedHumanDelta } from "../src/index.js";

test("round-trips every canonical human interaction kind", () => {
  for (const kind of ["answer", "resolution", "review", "testing"] as const) {
    const slot = createHumanInteractionSlot({ createdAt: "2026-08-15T10:00:00.000Z", generation: 1, kind, prompt: `Respond to ${kind}`, requestedBy: "manager", routes: { approve: "Done", return: "Todo" }, sourceErrorKey: kind === "resolution" ? "error/one" : null, taskId: "task-1" });
    assert.deepEqual(parseHumanInteractionSlots(renderHumanInteractionSlot(slot)), [slot]);
    assert.equal(parseHumanInteractionSlots(appendHumanInteractionSlot("Task context", slot)).length, 1);
  }
});

test("accepts one response while rejecting machine-owned edits", () => {
  const baseline = createHumanInteractionSlot({ createdAt: "2026-08-15T10:00:00.000Z", generation: 2, kind: "review", prompt: "Review it", requestedBy: "reviewer", routes: { approve: "Testing", return: "Coding" }, sourceErrorKey: null, taskId: "task-1" });
  const edited = { ...baseline, response: { action: "approve", text: "Looks good." } };
  assert.equal(verifyAllowedHumanDelta(baseline, edited).targetStatus, "Testing");
  assert.throws(() => verifyAllowedHumanDelta(baseline, { ...edited, prompt: "Changed" }), /digest|machine-owned/);
  assert.throws(() => verifyAllowedHumanDelta(baseline, { ...edited, response: { action: "delete", text: "No" } }), /not allowed/);
  assert.throws(() => verifyAllowedHumanDelta(baseline, { ...edited, response: { action: "constructor", text: "No" } }), /not allowed/);
});

test("rejects malformed and duplicate slot markers", () => {
  const slot = createHumanInteractionSlot({ createdAt: "2026-08-15T10:00:00.000Z", generation: 1, kind: "answer", prompt: "Answer", requestedBy: "planner", routes: { submit: "Planning" }, sourceErrorKey: null, taskId: "task-1" });
  const rendered = renderHumanInteractionSlot(slot);
  assert.throws(() => parseHumanInteractionSlots(`${rendered}\n\n${rendered}`), /duplicate/);
  assert.throws(() => parseHumanInteractionSlots(rendered.replace(":end -->", ":broken -->")), /malformed/);
});
