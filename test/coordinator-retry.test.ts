/** Heartbeat, sweep, retry-chain, and restart coverage. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentCoordinator,
  MAX_ATTEMPTS,
  STALE_AFTER_MILLISECONDS,
  retryErrorKey,
} from "../src/core/coordinator.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";
import * as fixtures from "./support/coordinator.js";

test("heartbeats expire only after five minutes and stale parents stop their subtree", async () => {
  /** Coordinator state driven by a controllable clock. */
  const state = fixtures.setup();
  await state.coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "root",
    taskId: "task-1",
  });
  await state.coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: "root",
    runId: "child",
    taskId: "task-1",
  });
  state.setClock(
    new Date(Date.parse("2026-08-17T12:00:00.000Z") + STALE_AFTER_MILLISECONDS),
  );
  assert.equal((await state.coordinator.sweep()).length, 0);
  state.setClock(
    new Date(
      Date.parse("2026-08-17T12:00:00.000Z") + STALE_AFTER_MILLISECONDS + 1,
    ),
  );
  /** Sweep result after the heartbeat crosses the stale threshold. */
  const result = await state.coordinator.sweep();
  assert.equal(result.length, 1);
  assert.equal(result[0]!.run.status, "stale");
  assert.equal(
    (await state.provider.getActiveAgent("child"))?.status,
    "stopped",
  );
  assert.equal((await state.provider.getActiveAgent("child"))?.archived, true);
  assert.equal((await state.provider.getActiveAgent("root"))?.archived, false);
});

test("third infrastructure failure blocks retry until its Error is resolved, then resets the chain", async () => {
  /** Coordinator, provider boundary exercised by "third infrastructure failure blocks retry until its Error is resolved, then resets the chain". */
  const { coordinator, provider } = fixtures.setup();
  await coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "attempt-1",
    taskId: "task-1",
  });
  /** Current run attempt advanced through the retry-limit scenario. */
  let run = await coordinator.fail("attempt-1", "h", "infra");
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
    /** Run ID selected by the restart scenario. */
    const id = `attempt-${attempt}`;
    await coordinator.restart({
      restartOfRunId: run.runId,
      harnessId: "h",
      runId: id,
    });
    run = await coordinator.fail(id, "h", "infra");
  }
  /** Error key supplied to "third infrastructure failure blocks retry until its Error is resolved, then resets the chain". */
  const errorKey = retryErrorKey("attempt-1");
  assert.equal((await provider.getErrorByKey(errorKey))?.status, "open");
  await assert.rejects(
    coordinator.restart({
      restartOfRunId: run.runId,
      harnessId: "h",
      runId: "attempt-4",
    }),
    /blocked/,
  );
  await coordinator.resolveError(errorKey, "Human approved a clean retry");
  /** Restarted state observed by "third infrastructure failure blocks retry until its Error is resolved, then resets the chain". */
  const restarted = await coordinator.restart({
    restartOfRunId: run.runId,
    harnessId: "h",
    runId: "fresh-chain",
  });
  assert.equal(restarted.run.attempt, 1);
  assert.equal(restarted.run.retryKey, "fresh-chain");
});

test("a failed attempt can have only one replacement", async () => {
  /** Coordinator boundary exercised by "a failed attempt can have only one replacement". */
  const { coordinator } = fixtures.setup();
  await coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "attempt-1",
    taskId: "task-1",
  });
  await coordinator.fail("attempt-1", "h", "infra");
  /** Unique replacement created for the failed source attempt. */
  const replacement = await coordinator.restart({
    harnessId: "h",
    restartOfRunId: "attempt-1",
    runId: "attempt-2",
  });
  assert.equal(replacement.run.attempt, 2);
  await assert.rejects(
    coordinator.restart({
      harnessId: "h",
      restartOfRunId: "attempt-1",
      runId: "duplicate-attempt-2",
    }),
    /already has a replacement/u,
  );
});

test("a disabled Agent cannot create a restart attempt", async () => {
  /** Disabled definition retained so an existing failed run remains inspectable. */
  const disabled = { ...fixtures.agent(), enabled: false };
  /** Provider retaining a failed run whose Agent is now disabled. */
  const provider = new InMemoryProvider({
    activeAgents: [
      {
        agentId: disabled.id,
        agentVersion: disabled.version,
        archived: false,
        attempt: 1,
        failureSummary: "stopped",
        finishedAt: "2026-08-17T12:01:00.000Z",
        harnessId: "h",
        id: "active-disabled",
        lastHeartbeat: "2026-08-17T12:00:00.000Z",
        outcome: "",
        parentRunId: null,
        restartOfRunId: null,
        retryKey: "disabled-run",
        runId: "disabled-run",
        startedAt: "2026-08-17T12:00:00.000Z",
        status: "failed",
        taskId: "task-1",
        version: "run-version",
        workingDirectory: null,
      },
    ],
    agents: [disabled],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [fixtures.task()],
  });
  await assert.rejects(
    new AgentCoordinator(provider).restart({
      harnessId: "h",
      restartOfRunId: "disabled-run",
      runId: "replacement",
    }),
    /Disabled Agent cannot restart/u,
  );
});
