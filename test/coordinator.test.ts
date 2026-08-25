/** Agent start, ownership, hierarchy, and lifecycle-hook coverage. */
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { AgentCoordinator } from "../src/core/coordinator.js";
import type { AgentLifecycleCommands } from "../src/core/lifecycle-commands.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";
import * as fixtures from "./support/coordinator.js";

test("configured lifecycle commands surround duties and replay only once", async () => {
  /** Captured events used to verify "configured lifecycle commands surround duties and replay only once". */
  const events: string[] = [];
  /** Fail after state observed by "configured lifecycle commands surround duties and replay only once". */
  let failAfter = false;
  /** Lifecycle boundary exercised by "configured lifecycle commands surround duties and replay only once". */
  const lifecycle: AgentLifecycleCommands = {
    /** Runs configured post-Agent lifecycle commands in declaration order. */
    async after(_config, context) {
      events.push(`after:${context.status}:${context.outcome}`);
      if (failAfter) throw new Error("cleanup failed");
    },
    /** Runs configured pre-Agent lifecycle commands in declaration order. */
    async before(_config, context) {
      events.push(`before:${context.runId}`);
    },
    /** Resolves the configured absolute working directory for a run. */
    workingDirectory(_config, context) {
      return resolve("runs", context.runId);
    },
  };
  /** Coordinator state instrumented with ordered lifecycle callbacks. */
  const state = fixtures.setup(new Date("2026-08-17T12:00:00.000Z"), lifecycle);
  /** Input supplied to "configured lifecycle commands surround duties and replay only once". */
  const input = {
    agentKey: "coder",
    harnessId: "host-1",
    parentRunId: null,
    runId: "run-hooks",
    taskId: "task-1",
  };
  /** Flag recording started during "configured lifecycle commands surround duties and replay only once". */
  const started = await state.coordinator.start(input);
  assert.equal(started.run.workingDirectory, resolve("runs", "run-hooks"));
  await state.coordinator.start(input);
  assert.deepEqual(events, ["before:run-hooks"]);
  assert.deepEqual(
    await state.coordinator.commandAuthorization("run-hooks", "host-1"),
    {
      commands: { exclusion: [] },
      workingDirectory: resolve("runs", "run-hooks"),
    },
  );

  failAfter = true;
  await assert.rejects(
    state.coordinator.complete("run-hooks", "host-1", "succeeded"),
    /cleanup failed/u,
  );
  assert.equal(
    (await state.provider.getActiveAgent("run-hooks"))?.status,
    "running",
  );
  assert.equal((await state.provider.getTask("task-1"))?.status, "Planned");
  failAfter = false;
  await state.coordinator.complete("run-hooks", "host-1", "succeeded");
  assert.deepEqual(events, [
    "before:run-hooks",
    "after:completed:succeeded",
    "after:completed:succeeded",
  ]);
});

test("a before command failure creates no Active Agent", async () => {
  /** Lifecycle boundary exercised by "a before command failure creates no Active Agent". */
  const lifecycle: AgentLifecycleCommands = {
    /** Runs configured post-Agent lifecycle commands in declaration order. */
    async after() {},
    /** Runs configured pre-Agent lifecycle commands in declaration order. */
    async before() {
      throw new Error("preparation failed");
    },
    /** Resolves the configured absolute working directory for a run. */
    workingDirectory() {
      return null;
    },
  };
  /** Coordinator state whose preparation hook always fails. */
  const state = fixtures.setup(new Date("2026-08-17T12:00:00.000Z"), lifecycle);
  await assert.rejects(
    state.coordinator.start({
      agentKey: "coder",
      harnessId: "host-1",
      parentRunId: null,
      runId: "run-hooks",
      taskId: "task-1",
    }),
    /preparation failed/u,
  );
  assert.equal((await state.provider.listActiveAgents()).length, 0);
});

test("new run IDs cannot escape lifecycle working-directory templates", async () => {
  /** Whether an unsafe identity reached lifecycle execution. */
  let lifecycleStarted = false;
  /** Lifecycle executor used to expose rendering past the coordinator boundary. */
  const lifecycle: AgentLifecycleCommands = {
    /** Terminal hook intentionally inert for the rejected start. */
    async after() {},
    /** Marks whether an unsafe Run ID reached lifecycle execution. */
    async before() {
      lifecycleStarted = true;
    },
    /** Renders the Run ID into a lifecycle working-directory path. */
    workingDirectory(_config, context) {
      return resolve("runs", context.runId);
    },
  };
  /** Coordinator boundary exercised by "new run IDs cannot escape lifecycle working-directory templates". */
  const { coordinator, provider } = fixtures.setup(undefined, lifecycle);

  await assert.rejects(
    coordinator.start({
      agentKey: "coder",
      harnessId: "h",
      parentRunId: null,
      runId: "../escape",
      taskId: "task-1",
    }),
    /path-safe identifier/u,
  );

  assert.equal(lifecycleStarted, false);
  assert.equal((await provider.listActiveAgents()).length, 0);
});

test("start and restart enforce Agent and parent harness authority", async () => {
  /** Provider with one Agent restricted to an exact harness identity. */
  const restrictedProvider = new InMemoryProvider({
    agents: [{ ...fixtures.agent(), calledBy: "host-1" }],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [fixtures.task()],
  });
  /** Coordinator enforcing the Agent's exact harness restriction. */
  const restricted = new AgentCoordinator(restrictedProvider);
  await assert.rejects(
    restricted.start({
      agentKey: "coder",
      harnessId: "host-2",
      parentRunId: null,
      runId: "denied",
      taskId: "task-1",
    }),
    /not allowed to invoke Agent/u,
  );
  await restricted.start({
    agentKey: "coder",
    harnessId: "host-1",
    parentRunId: null,
    runId: "allowed",
    taskId: "task-1",
  });
  await restricted.fail("allowed", "host-1", "retry");
  await assert.rejects(
    restricted.restart({
      harnessId: "host-2",
      restartOfRunId: "allowed",
      runId: "denied-restart",
    }),
    /not allowed to invoke Agent/u,
  );

  /** Unrestricted Agent still requires children to use the owning harness. */
  const parentState = fixtures.setup();
  await parentState.coordinator.start({
    agentKey: "coder",
    harnessId: "host-1",
    parentRunId: null,
    runId: "parent",
    taskId: "task-1",
  });
  await assert.rejects(
    parentState.coordinator.start({
      agentKey: "coder",
      harnessId: "host-2",
      parentRunId: "parent",
      runId: "foreign-child",
      taskId: "task-1",
    }),
    /must use its parent harness/u,
  );
});

test("after commands run for stopped descendants and their failed root", async () => {
  /** Terminal state observed by "after commands run for stopped descendants and their failed root". */
  const terminal: string[] = [];
  /** Lifecycle boundary exercised by "after commands run for stopped descendants and their failed root". */
  const lifecycle: AgentLifecycleCommands = {
    /** Runs configured post-Agent lifecycle commands in declaration order. */
    async after(_config, context) {
      terminal.push(`${context.runId}:${context.status}`);
    },
    /** Runs configured pre-Agent lifecycle commands in declaration order. */
    async before() {},
    /** Resolves the configured absolute working directory for a run. */
    workingDirectory() {
      return null;
    },
  };
  /** Coordinator state recording descendant and root cleanup order. */
  const state = fixtures.setup(new Date("2026-08-17T12:00:00.000Z"), lifecycle);
  await state.coordinator.start({
    agentKey: "coder",
    harnessId: "host-1",
    parentRunId: null,
    runId: "root",
    taskId: "task-1",
  });
  await state.coordinator.start({
    agentKey: "coder",
    harnessId: "host-1",
    parentRunId: "root",
    runId: "child",
    taskId: "task-1",
  });
  await state.coordinator.start({
    agentKey: "coder",
    harnessId: "host-1",
    parentRunId: "child",
    runId: "grandchild",
    taskId: "task-1",
  });
  await state.coordinator.fail("root", "host-1", "failed");
  assert.deepEqual(terminal, [
    "grandchild:stopped",
    "child:stopped",
    "root:failed",
  ]);
});

test("start returns current context, replays a matching Run ID, and enforces one root", async () => {
  /** Coordinator boundary exercised by "start returns current context, replays a matching Run ID, and enforces one root". */
  const { coordinator } = fixtures.setup();
  /** Input supplied to "start returns current context, replays a matching Run ID, and enforces one root". */
  const input = {
    agentKey: "coder",
    harnessId: "host-1",
    parentRunId: null,
    runId: "run-1",
    taskId: "task-1",
  };
  /** First Active Agent record used to verify relation consistency. */
  const first = await coordinator.start(input);
  assert.equal(first.task.body, "Task context");
  assert.deepEqual(
    first.resources.map((entry) => entry.key),
    ["prompt", "policy"],
  );
  assert.equal("lifecycleCommands" in first.agent, false);
  assert.equal("commands" in first.agent, false);
  assert.equal("body" in first.agent, false);
  assert.equal("properties" in first.agent, false);
  assert.equal("properties" in first.resources[0]!, false);
  assert.equal("properties" in first.task, false);
  assert.equal((await coordinator.start(input)).run.id, first.run.id);
  await assert.rejects(
    coordinator.start({ ...input, runId: "run-2" }),
    /running root/,
  );
  await assert.rejects(
    coordinator.start({ ...input, harnessId: "host-2" }),
    /Run ID reuse conflicts/,
  );
});

test("start never replays a terminal Run ID", async () => {
  /** Coordinator boundary exercised by "start never replays a terminal Run ID". */
  const { coordinator } = fixtures.setup();
  /** Stable invocation reused after its run becomes terminal. */
  const input = {
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "terminal-run",
    taskId: "task-1",
  };
  await coordinator.start(input);
  await coordinator.complete("terminal-run", "h", "succeeded");
  await assert.rejects(
    coordinator.start(input),
    /belongs to a terminal Active Agent/u,
  );
});

test("children require a running same-Task parent and a root cannot complete over them", async () => {
  /** Coordinator, provider boundary exercised by "children require a running same-Task parent and a root cannot complete over them". */
  const { coordinator, provider } = fixtures.setup();
  await coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "root",
    taskId: "task-1",
  });
  await coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: "root",
    runId: "child",
    taskId: "task-1",
  });
  await assert.rejects(
    coordinator.complete("root", "h", "succeeded"),
    /descendants/,
  );
  await coordinator.complete("child", "h", "unchanged");
  assert.equal((await provider.getTask("task-1"))?.status, "Planned");
  await coordinator.complete("root", "h", "succeeded");
  assert.equal((await provider.getTask("task-1"))?.status, "In review");
  assert.equal((await provider.getActiveAgent("root"))?.archived, true);
  assert.equal((await provider.getActiveAgent("child"))?.archived, true);
});
