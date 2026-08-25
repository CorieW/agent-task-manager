/** Provider-neutral lifecycle, hierarchy, retry, and ownership coverage. */
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import {
  AgentCoordinator,
  MAX_ATTEMPTS,
  STALE_AFTER_MILLISECONDS,
  retryErrorKey,
} from "../src/core/coordinator.js";
import {
  NO_LIFECYCLE_COMMANDS,
  type AgentLifecycleCommands,
} from "../src/core/lifecycle-commands.js";
import type {
  AgentRecord,
  ResourceRecord,
  TaskRecord,
} from "../src/domain/records.js";
import { EMPTY_AGENT_LIFECYCLE } from "../src/domain/lifecycle.js";
import { EMPTY_AGENT_TASK_DESCRIPTION } from "../src/domain/task-description.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";

/** Builds the canonical eligible Task used by coordinator scenarios. */
function task(): TaskRecord {
  return {
    archived: false,
    body: "Task context",
    dependencies: [],
    id: "task-1",
    priority: 1,
    properties: {},
    status: "Planned",
    title: "Implement",
    type: "Feature",
    version: "1",
  };
}

/** Builds one Resource fixture with configurable kind and lifecycle state. */
function resource(
  id: string,
  kind = "Prompt",
  state: ResourceRecord["state"] = "active",
): ResourceRecord {
  return {
    archived: false,
    body: `${id} body`,
    id,
    key: id,
    kind,
    properties: {},
    state,
    version: "1",
  };
}

/** Builds the canonical Agent definition used by coordinator scenarios. */
function agent(): AgentRecord {
  return {
    allowedStatuses: ["Planned", "Blocked", "In review"],
    allowedTaskTypes: ["Feature"],
    archived: false,
    body: "Agent",
    calledBy: "",
    commands: { exclusion: [] },
    enabled: true,
    id: "agent-1",
    key: "coder",
    lifecycleCommands: EMPTY_AGENT_LIFECYCLE,
    model: "gpt",
    name: "Coder",
    notes: "",
    properties: {},
    reasoning: "high",
    resourceIds: ["prompt", "policy"],
    taskDescription: EMPTY_AGENT_TASK_DESCRIPTION,
    transitions: {
      blocked: "Blocked",
      succeeded: "In review",
      unchanged: "$current",
    },
    version: "1",
  };
}

/** Creates a coordinator fixture with deterministic records and clock. */
function setup(
  now = new Date("2026-08-17T12:00:00.000Z"),
  lifecycle: AgentLifecycleCommands = NO_LIFECYCLE_COMMANDS,
) {
  /** Clock captured by the setup fixture. */
  let clock = now;
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    agents: [agent()],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  /** Coordinator captured by the setup fixture. */
  const coordinator = new AgentCoordinator(provider, () => clock, lifecycle);
  return {
    coordinator,
    provider,
    /** Updates clock. */
    setClock(value: Date) {
      clock = value;
    },
  };
}

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
  const state = setup(new Date("2026-08-17T12:00:00.000Z"), lifecycle);
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
  const state = setup(new Date("2026-08-17T12:00:00.000Z"), lifecycle);
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
  const { coordinator, provider } = setup(undefined, lifecycle);

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
    agents: [{ ...agent(), calledBy: "host-1" }],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
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
  const parentState = setup();
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
  const state = setup(new Date("2026-08-17T12:00:00.000Z"), lifecycle);
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
  const { coordinator } = setup();
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
  const { coordinator } = setup();
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
  const { coordinator, provider } = setup();
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

test("configured Agents persist required Task sections before completion", async () => {
  /** Planner boundary exercised by "configured Agents persist required Task sections before completion". */
  const planner = {
    ...agent(),
    key: "task-planner",
    taskDescription: {
      requiredSectionsByOutcome: { succeeded: ["Planning"] },
      writableSections: ["Planning"],
    },
  };
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    agents: [planner],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  /** Coordinator boundary exercised by "configured Agents persist required Task sections before completion". */
  const coordinator = new AgentCoordinator(provider);
  /** Started context whose system prompt advertises the section capability. */
  const context = await coordinator.start({
    agentKey: planner.key,
    harnessId: "h",
    parentRunId: null,
    runId: "planner",
    taskId: "task-1",
  });
  assert.match(context.systemPrompt, /update-task-section/u);
  await assert.rejects(
    coordinator.complete("planner", "h", "succeeded"),
    /requires Task description section: Planning/u,
  );
  await assert.rejects(
    coordinator.updateTaskSection("planner", "h", "Review", "No."),
    /not allowed to write/u,
  );
  /** First Active Agent record used to verify relation consistency. */
  const first = await coordinator.updateTaskSection(
    "planner",
    "h",
    "Planning",
    "### Scope\n\nImplementation-ready.",
  );
  assert.equal(
    first.body,
    "Task context\n\n## Planning\n\n### Scope\n\nImplementation-ready.\n",
  );
  /** Revised state observed by "configured Agents persist required Task sections before completion". */
  const revised = await coordinator.updateTaskSection(
    "planner",
    "h",
    "Planning",
    "### Scope\n\nRevised.",
  );
  assert.equal(revised.body.match(/^## Planning$/gmu)?.length, 1);
  assert.doesNotMatch(revised.body, /Implementation-ready/u);
  await coordinator.complete("planner", "h", "succeeded");
  assert.equal((await provider.getTask("task-1"))?.status, "In review");
});

test("Task section updates enforce run ownership and description drift", async () => {
  /** Planner boundary exercised by "Task section updates enforce run ownership and description drift". */
  const planner = {
    ...agent(),
    taskDescription: {
      requiredSectionsByOutcome: {},
      writableSections: ["Planning"],
    },
  };
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    agents: [planner],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  /** Coordinator boundary exercised by "Task section updates enforce run ownership and description drift". */
  const coordinator = new AgentCoordinator(provider);
  await coordinator.start({
    agentKey: planner.key,
    harnessId: "h",
    parentRunId: null,
    runId: "planner",
    taskId: "task-1",
  });
  await assert.rejects(
    coordinator.updateTaskSection("planner", "other", "Planning", "Plan."),
    /Harness does not own/u,
  );
  /** Task body after the authorized section replacement. */
  const current = (await provider.getTask("task-1"))!;
  await provider.updateTaskBody("task-1", current.body, "Changed externally.");
  await assert.rejects(
    provider.updateTaskBody("task-1", current.body, "Stale replacement."),
    /changed before update/u,
  );
});

test("heartbeats expire only after five minutes and stale parents stop their subtree", async () => {
  /** Coordinator state driven by a controllable clock. */
  const state = setup();
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
  const { coordinator, provider } = setup();
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
  const { coordinator } = setup();
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
  const disabled = { ...agent(), enabled: false };
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
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
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

test("ordinary open Errors are informational and inactive Resources block start", async () => {
  /** Coordinator state containing an informational Error and inactive Resource. */
  const state = setup();
  await state.coordinator.reportError({
    activeAgentId: null,
    agentId: null,
    description: "FYI",
    errorKey: "ordinary",
    resolution: "",
    severity: "low",
    source: "human",
    taskId: "task-1",
    title: "Note",
  });
  assert.equal(
    (
      await state.coordinator.start({
        agentKey: "coder",
        harnessId: "h",
        parentRunId: null,
        runId: "run",
        taskId: "task-1",
      })
    ).run.status,
    "running",
  );
  /** Unavailable case exercised by "ordinary open Errors are informational and inactive Resources block start". */
  const unavailable = new InMemoryProvider({
    agents: [agent()],
    resources: [
      resource("prompt", "Prompt", "draft"),
      resource("policy", "Policy"),
    ],
    tasks: [task()],
  });
  await assert.rejects(
    new AgentCoordinator(unavailable).start({
      agentKey: "coder",
      harnessId: "h",
      parentRunId: null,
      runId: "other",
      taskId: "task-1",
    }),
    /unavailable/,
  );
  assert.equal((await unavailable.listActiveAgents()).length, 0);
});

test("Agent context includes arbitrary active Resource kinds", async () => {
  /** Agent granted a schema Resource through its resolved Resource IDs. */
  const customAgent = {
    ...agent(),
    resourceIds: ["prompt", "schema"],
  };
  /** Provider containing a non-Prompt, non-Policy Resource. */
  const provider = new InMemoryProvider({
    agents: [customAgent],
    resources: [resource("prompt"), resource("schema", "Schema")],
    tasks: [task()],
  });

  const context = await new AgentCoordinator(provider).start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "custom-resource",
    taskId: "task-1",
  });

  assert.deepEqual(
    context.resources.map(({ key, kind }) => ({ key, kind })),
    [
      { key: "prompt", kind: "Prompt" },
      { key: "schema", kind: "Schema" },
    ],
  );
});

test("Agent Task type and status allowlists guard assignment", async () => {
  /** Denied type case exercised by "Agent Task type and status allowlists guard assignment". */
  const deniedType = new InMemoryProvider({
    agents: [agent()],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [{ ...task(), type: "Vulnerability" }],
  });
  await assert.rejects(
    new AgentCoordinator(deniedType).start({
      agentKey: "coder",
      harnessId: "h",
      parentRunId: null,
      runId: "wrong-type",
      taskId: "task-1",
    }),
    /not allowed to use Task type: Vulnerability/u,
  );

  /** Denied status case exercised by "Agent Task type and status allowlists guard assignment". */
  const deniedStatus = new InMemoryProvider({
    agents: [agent()],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [{ ...task(), status: "Ready" }],
  });
  await assert.rejects(
    new AgentCoordinator(deniedStatus).start({
      agentKey: "coder",
      harnessId: "h",
      parentRunId: null,
      runId: "wrong-status",
      taskId: "task-1",
    }),
    /not allowed to use Task status: Ready/u,
  );

  /** Transition agent case exercised by "Agent Task type and status allowlists guard assignment". */
  const transitionAgent = {
    ...agent(),
    allowedStatuses: ["Planned"],
  };
  /** Transition provider boundary exercised by "Agent Task type and status allowlists guard assignment". */
  const transitionProvider = new InMemoryProvider({
    agents: [transitionAgent],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  /** Coordinator boundary exercised by "Agent Task type and status allowlists guard assignment". */
  const coordinator = new AgentCoordinator(transitionProvider);
  await coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "transition",
    taskId: "task-1",
  });
  await coordinator.complete("transition", "h", "succeeded");
  assert.equal(
    (await transitionProvider.getTask("task-1"))?.status,
    "In review",
  );
});

test("completion rejects Agent definition drift before mutating its Task", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    activeAgents: [
      {
        agentId: "agent-1",
        agentVersion: "older-definition",
        archived: false,
        attempt: 1,
        failureSummary: "",
        finishedAt: null,
        harnessId: "h",
        id: "active-1",
        lastHeartbeat: "2026-08-17T12:00:00.000Z",
        outcome: "",
        parentRunId: null,
        restartOfRunId: null,
        retryKey: "run",
        runId: "run",
        startedAt: "2026-08-17T12:00:00.000Z",
        status: "running",
        taskId: "task-1",
        version: "run-version",
        workingDirectory: null,
      },
    ],
    agents: [agent()],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  await assert.rejects(
    new AgentCoordinator(provider).complete("run", "h", "succeeded"),
    /definition changed/,
  );
  assert.equal((await provider.getTask("task-1"))?.status, "Planned");
});

test("completion resumes after a persisted Task transition", async () => {
  /** Coordinator, provider boundary exercised by "completion resumes after a persisted Task transition". */
  const { coordinator, provider } = setup();
  await coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "partial-completion",
    taskId: "task-1",
  });
  await provider.updateActiveAgent("partial-completion", {
    completionTaskStatus: "Planned",
    outcome: "succeeded",
  });
  /** Task snapshot used to simulate an already-persisted status transition. */
  const taskBefore = (await provider.getTask("task-1"))!;
  await provider.setTaskStatus(
    taskBefore.id,
    taskBefore.status,
    taskBefore.version,
    "In review",
  );

  /** Resumed completion result after the Task already reached its target. */
  const completed = await coordinator.complete(
    "partial-completion",
    "h",
    "succeeded",
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.archived, true);
});

test("completion rejects Task status drift observed after its intent", async () => {
  /** Provider mutated by the lifecycle hook to simulate a concurrent operator. */
  const provider = new InMemoryProvider({
    agents: [agent()],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  /** Lifecycle hook that introduces Task drift after completion intent. */
  const lifecycle: AgentLifecycleCommands = {
    /** Changes the Task between intent persistence and guarded transition. */
    async after() {
      /** Task snapshot mutated to simulate a concurrent operator. */
      const current = (await provider.getTask("task-1"))!;
      await provider.setTaskStatus(
        current.id,
        current.status,
        current.version,
        "Blocked",
      );
    },
    /** Preparation hook intentionally inert for this completion scenario. */
    async before() {},
    /** Uses the host default because path rendering is unrelated to the test. */
    workingDirectory() {
      return null;
    },
  };
  /** Coordinator executing the lifecycle hook that introduces drift. */
  const coordinator = new AgentCoordinator(provider, undefined, lifecycle);
  await coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "drifted-completion",
    taskId: "task-1",
  });
  await assert.rejects(
    coordinator.complete("drifted-completion", "h", "succeeded"),
    /Task status changed while completion was pending/u,
  );
  assert.equal((await provider.getTask("task-1"))?.status, "Blocked");
});

test("legacy Agent versions fail closed until a canonical restart", async () => {
  /** Canonical agent case exercised by "legacy Agent versions fail closed until a canonical restart". */
  const canonicalAgent = {
    ...agent(),
    restartCompatibleVersions: ["legacy-timestamp"],
    version: "body-digest",
  };
  /** Legacy run case exercised by "legacy Agent versions fail closed until a canonical restart". */
  const legacyRun = {
    agentId: canonicalAgent.id,
    agentVersion: "legacy-timestamp",
    archived: false,
    attempt: 1,
    failureSummary: "",
    finishedAt: null,
    harnessId: "h",
    id: "active-legacy",
    lastHeartbeat: "2026-08-17T12:00:00.000Z",
    outcome: "",
    parentRunId: null,
    restartOfRunId: null,
    retryKey: "legacy-run",
    runId: "legacy-run",
    startedAt: "2026-08-17T12:00:00.000Z",
    status: "running" as const,
    taskId: "task-1",
    version: "run-version",
    workingDirectory: null,
  };
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    activeAgents: [legacyRun],
    agents: [canonicalAgent],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  /** Coordinator boundary exercised by "legacy Agent versions fail closed until a canonical restart". */
  const coordinator = new AgentCoordinator(provider);

  await assert.rejects(
    coordinator.start({
      agentKey: canonicalAgent.key,
      harnessId: "h",
      parentRunId: null,
      runId: legacyRun.runId,
      taskId: legacyRun.taskId,
    }),
    /Run ID reuse conflicts/u,
  );
  await assert.rejects(
    coordinator.commandAuthorization(legacyRun.runId, "h"),
    /definition changed/u,
  );
  await assert.rejects(
    coordinator.complete(legacyRun.runId, "h", "succeeded"),
    /definition changed/u,
  );
  assert.equal((await provider.getTask("task-1"))?.status, "Planned");
  await coordinator.fail(legacyRun.runId, "h", "infra");
  /** Restarted state observed by "legacy Agent versions fail closed until a canonical restart". */
  const restarted = await coordinator.restart({
    harnessId: "h",
    restartOfRunId: legacyRun.runId,
    runId: "digest-run",
  });

  assert.equal(restarted.run.agentVersion, "body-digest");
});

test("termination never runs cleanup from a changed Agent definition", async () => {
  /** Lifecycle calls that would execute the changed definition's commands. */
  const cleanupVersions: string[] = [];
  /** A run pinned to an earlier Agent definition case exercised by "termination never runs cleanup from a changed Agent definition". */
  const staleRun = {
    agentId: "agent-1",
    agentVersion: "original-version",
    archived: false,
    attempt: 1,
    failureSummary: "",
    finishedAt: null,
    harnessId: "h",
    id: "active-stale-definition",
    lastHeartbeat: "2026-08-17T12:00:00.000Z",
    outcome: "",
    parentRunId: null,
    restartOfRunId: null,
    retryKey: "stale-definition",
    runId: "stale-definition",
    startedAt: "2026-08-17T12:00:00.000Z",
    status: "running" as const,
    taskId: "task-1",
    version: "run-version",
    workingDirectory: null,
  };
  /** Current mutable definition, changed after the run began. */
  const changedAgent = { ...agent(), version: "changed-version" };
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    activeAgents: [staleRun],
    agents: [changedAgent],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  /** Lifecycle executor that exposes any untrusted cleanup attempt. */
  const lifecycle: AgentLifecycleCommands = {
    /** Records cleanup execution so definition drift cannot go unnoticed. */
    async after(_config, context) {
      cleanupVersions.push(context.agentKey);
    },
    /** Preparation hook unused during terminal cleanup. */
    async before() {},
    /** Uses the host default working directory for the cleanup scenario. */
    workingDirectory() {
      return null;
    },
  };
  /** Coordinator asked to fail a run pinned to a stale Agent definition. */
  const coordinator = new AgentCoordinator(provider, undefined, lifecycle);

  /** Failed run returned after cleanup is deliberately withheld. */
  const failed = await coordinator.fail(staleRun.runId, "h", "infra");

  assert.equal(failed.status, "failed");
  assert.deepEqual(cleanupVersions, []);
  assert.equal(
    (await provider.getErrorByKey("active-agent-cleanup:stale-definition"))
      ?.severity,
    "high",
  );
});

test("completion rejects inherited transition property names", async () => {
  /** Coordinator, provider boundary exercised by "completion rejects inherited transition property names". */
  const { coordinator, provider } = setup();
  await coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "run",
    taskId: "task-1",
  });

  await assert.rejects(
    coordinator.complete("run", "h", "toString"),
    /does not declare outcome/u,
  );
  assert.equal((await provider.getTask("task-1"))?.status, "Planned");
  assert.equal((await provider.getActiveAgent("run"))?.status, "running");
});
