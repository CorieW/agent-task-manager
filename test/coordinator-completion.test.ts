/** Task-description completion, drift, and cleanup coverage. */
import assert from "node:assert/strict";
import test from "node:test";
import { AgentCoordinator } from "../src/core/coordinator.js";
import type { AgentLifecycleCommands } from "../src/core/lifecycle-commands.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";
import * as fixtures from "./support/coordinator.js";

test("configured Agents persist required Task sections before completion", async () => {
  /** Planner boundary exercised by "configured Agents persist required Task sections before completion". */
  const planner = {
    ...fixtures.agent(),
    key: "task-planner",
    taskDescription: {
      requiredSectionsByOutcome: { succeeded: ["Planning"] },
      writableSections: ["Planning"],
    },
  };
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    agents: [planner],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [fixtures.task()],
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
    ...fixtures.agent(),
    taskDescription: {
      requiredSectionsByOutcome: {},
      writableSections: ["Planning"],
    },
  };
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    agents: [planner],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [fixtures.task()],
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
    agents: [fixtures.agent()],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [fixtures.task()],
  });
  await assert.rejects(
    new AgentCoordinator(provider).complete("run", "h", "succeeded"),
    /definition changed/,
  );
  assert.equal((await provider.getTask("task-1"))?.status, "Planned");
});

test("completion resumes after a persisted Task transition", async () => {
  /** Coordinator, provider boundary exercised by "completion resumes after a persisted Task transition". */
  const { coordinator, provider } = fixtures.setup();
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
    agents: [fixtures.agent()],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [fixtures.task()],
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
    ...fixtures.agent(),
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
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [fixtures.task()],
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
  const changedAgent = { ...fixtures.agent(), version: "changed-version" };
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    activeAgents: [staleRun],
    agents: [changedAgent],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [fixtures.task()],
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
  const { coordinator, provider } = fixtures.setup();
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
