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

/** Decodes a Task record from its Notion page and Markdown. */
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
/** Decodes a Resource record from its Notion page and Markdown. */
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
/** Decodes an Agent record from a stable Notion page and body. */
function agent(): AgentRecord {
  return {
    allowedStatuses: ["Planned", "Blocked", "In review"],
    allowedTaskTypes: ["Feature"],
    archived: false,
    body: "Agent",
    calledBy: "harness",
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
  /** Test fixture for events. */
  const events: string[] = [];
  /** Test fixture for fail after. */
  let failAfter = false;
  /** Test fixture for lifecycle. */
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
  /** Test fixture for state. */
  const state = setup(new Date("2026-08-17T12:00:00.000Z"), lifecycle);
  /** Test fixture for input. */
  const input = {
    agentKey: "coder",
    harnessId: "host-1",
    parentRunId: null,
    runId: "run-hooks",
    taskId: "task-1",
  };
  /** Test fixture for started. */
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
  /** Test fixture for lifecycle. */
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
  /** Test fixture for state. */
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

test("after commands run for stopped descendants and their failed root", async () => {
  /** Test fixture for terminal. */
  const terminal: string[] = [];
  /** Test fixture for lifecycle. */
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
  /** Test fixture for state. */
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
  await state.coordinator.fail("root", "host-1", "failed");
  assert.deepEqual(terminal, ["child:stopped", "root:failed"]);
});

test("start returns current context, replays a matching Run ID, and enforces one root", async () => {
  /** Test fixture for coordinator. */
  const { coordinator } = setup();
  /** Test fixture for input. */
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

test("children require a running same-Task parent and a root cannot complete over them", async () => {
  /** Test fixture for coordinator, provider. */
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
  /** Test fixture for planner. */
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
  /** Test fixture for coordinator. */
  const coordinator = new AgentCoordinator(provider);
  /** Test fixture for context. */
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
  /** Test fixture for revised. */
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
  /** Test fixture for planner. */
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
  /** Test fixture for coordinator. */
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
  /** Test fixture for current. */
  const current = (await provider.getTask("task-1"))!;
  await provider.updateTaskBody("task-1", current.body, "Changed externally.");
  await assert.rejects(
    provider.updateTaskBody("task-1", current.body, "Stale replacement."),
    /changed before update/u,
  );
});

test("heartbeats expire only after five minutes and stale parents stop their subtree", async () => {
  /** Test fixture for state. */
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
  /** Test fixture for result. */
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
  /** Test fixture for coordinator, provider. */
  const { coordinator, provider } = setup();
  await coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "attempt-1",
    taskId: "task-1",
  });
  /** Test fixture for run. */
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
  /** Test fixture for error key. */
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
  /** Test fixture for restarted. */
  const restarted = await coordinator.restart({
    restartOfRunId: run.runId,
    harnessId: "h",
    runId: "fresh-chain",
  });
  assert.equal(restarted.run.attempt, 1);
  assert.equal(restarted.run.retryKey, "fresh-chain");
});

test("ordinary open Errors are informational and inactive Resources block start", async () => {
  /** Test fixture for state. */
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
  /** Test fixture for unavailable. */
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

test("Agent Task type and status allowlists guard assignment", async () => {
  /** Test fixture for denied type. */
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

  /** Test fixture for denied status. */
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

  /** Test fixture for transition agent. */
  const transitionAgent = {
    ...agent(),
    allowedStatuses: ["Planned"],
  };
  /** Test fixture for transition provider. */
  const transitionProvider = new InMemoryProvider({
    agents: [transitionAgent],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  /** Test fixture for coordinator. */
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

test("legacy Agent versions fail closed until a canonical restart", async () => {
  /** Test fixture for canonical agent. */
  const canonicalAgent = {
    ...agent(),
    restartCompatibleVersions: ["legacy-timestamp"],
    version: "body-digest",
  };
  /** Test fixture for legacy run. */
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
  /** Test fixture for coordinator. */
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
  /** Test fixture for restarted. */
  const restarted = await coordinator.restart({
    harnessId: "h",
    restartOfRunId: legacyRun.runId,
    runId: "digest-run",
  });

  assert.equal(restarted.run.agentVersion, "body-digest");
});

test("completion rejects inherited transition property names", async () => {
  /** Test fixture for coordinator, provider. */
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
