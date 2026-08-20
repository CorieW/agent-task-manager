/** Provider-neutral lifecycle, hierarchy, retry, and ownership coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentCoordinator,
  MAX_ATTEMPTS,
  STALE_AFTER_MILLISECONDS,
  retryErrorKey,
} from "../src/core/coordinator.js";
import type {
  AgentRecord,
  ResourceRecord,
  TaskRecord,
} from "../src/domain/records.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";

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
    model: "gpt",
    name: "Coder",
    notes: "",
    properties: {},
    reasoning: "high",
    resourceIds: ["prompt", "policy"],
    transitions: {
      blocked: "Blocked",
      succeeded: "In review",
      unchanged: "$current",
    },
    version: "1",
  };
}
function setup(now = new Date("2026-08-17T12:00:00.000Z")) {
  let clock = now;
  const provider = new InMemoryProvider({
    agents: [agent()],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  const coordinator = new AgentCoordinator(provider, () => clock);
  return {
    coordinator,
    provider,
    setClock(value: Date) {
      clock = value;
    },
  };
}

test("start returns current context, replays a matching Run ID, and enforces one root", async () => {
  const { coordinator } = setup();
  const input = {
    agentKey: "coder",
    harnessId: "host-1",
    parentRunId: null,
    runId: "run-1",
    taskId: "task-1",
  };
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

test("heartbeats expire only after five minutes and stale parents stop their subtree", async () => {
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
  const { coordinator, provider } = setup();
  await coordinator.start({
    agentKey: "coder",
    harnessId: "h",
    parentRunId: null,
    runId: "attempt-1",
    taskId: "task-1",
  });
  let run = await coordinator.fail("attempt-1", "h", "infra");
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const id = `attempt-${attempt}`;
    await coordinator.restart({
      restartOfRunId: run.runId,
      harnessId: "h",
      runId: id,
    });
    run = await coordinator.fail(id, "h", "infra");
  }
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
  const restarted = await coordinator.restart({
    restartOfRunId: run.runId,
    harnessId: "h",
    runId: "fresh-chain",
  });
  assert.equal(restarted.run.attempt, 1);
  assert.equal(restarted.run.retryKey, "fresh-chain");
});

test("ordinary open Errors are informational and inactive Resources block start", async () => {
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

  const transitionAgent = {
    ...agent(),
    allowedStatuses: ["Planned"],
  };
  const transitionProvider = new InMemoryProvider({
    agents: [transitionAgent],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
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
  const provider = new InMemoryProvider({
    activeAgents: [
      {
        agentId: "agent-1",
        agentVersion: "older-definition",
        archived: false,
        attempt: 1,
        branch: null,
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
        worktreePath: null,
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
  const canonicalAgent = {
    ...agent(),
    restartCompatibleVersions: ["legacy-timestamp"],
    version: "body-digest",
  };
  const legacyRun = {
    agentId: canonicalAgent.id,
    agentVersion: "legacy-timestamp",
    archived: false,
    attempt: 1,
    branch: null,
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
    worktreePath: null,
  };
  const provider = new InMemoryProvider({
    activeAgents: [legacyRun],
    agents: [canonicalAgent],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
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
  const restarted = await coordinator.restart({
    harnessId: "h",
    restartOfRunId: legacyRun.runId,
    runId: "digest-run",
  });

  assert.equal(restarted.run.agentVersion, "body-digest");
});

test("completion rejects inherited transition property names", async () => {
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
