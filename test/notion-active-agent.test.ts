/** Notion Active Agent persistence and lifecycle decoding coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import { NotionProvider } from "../src/provider/notion/notion-provider.js";
import * as fixtures from "./support/notion.js";

test("Notion Active Agent lookup preserves parent and restart Run IDs", async () => {
  /** Provider serving one child with both hierarchy and retry relations. */
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: fixtures.ids.activeAgents,
        agents: fixtures.ids.agents,
        errors: fixtures.ids.errors,
        resources: fixtures.ids.resources,
        tasks: fixtures.ids.tasks,
      },
    },
    new fixtures.AgentBodyTransport(),
  );

  /** Decoded child run whose hierarchy and retry identities are asserted. */
  const run = await provider.getActiveAgent("child");
  assert.equal(run?.parentRunId, "root");
  assert.equal(run?.restartOfRunId, "failed");
});

test("Notion Active Agent decoding rejects invalid lifecycle status", async () => {
  /** Provider whose Active Agent row contains an out-of-domain status. */
  const provider = fixtures.lifecycleProvider(
    new fixtures.InvalidActiveAgentTransport(),
  );

  await assert.rejects(
    provider.listActiveAgents(),
    /Invalid Active Agent status/u,
  );
});

test("Notion terminal Active Agents detach from Tasks without losing retry identity", async () => {
  for (const status of ["completed", "failed", "stale", "stopped"] as const) {
    /** Transport boundary exercised by "Notion terminal Active Agents detach from Tasks without losing retry identity". */
    const transport = new fixtures.ActiveAgentLifecycleTransport();
    /** Provider implementation that owns persistence for this invocation. */
    const provider = fixtures.lifecycleProvider(transport);
    /** Terminal state observed by "Notion terminal Active Agents detach from Tasks without losing retry identity". */
    const terminal = await provider.updateActiveAgent("child", {
      finishedAt: "2026-08-17T12:01:00.000Z",
      status,
    });
    assert.equal(terminal.taskId, fixtures.ids.task);
    assert.deepEqual(transport.patches[0], {
      properties: {
        "Finished At": fixtures.requestDate("2026-08-17T12:01:00.000Z"),
        Status: fixtures.requestSelect(
          `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`,
        ),
        Task: fixtures.requestRelation([]),
        "Task ID": fixtures.requestRichText(fixtures.ids.task),
      },
    });
  }

  /** Transport boundary exercised by "Notion terminal Active Agents detach from Tasks without losing retry identity". */
  const transport = new fixtures.ActiveAgentLifecycleTransport();
  /** Provider implementation that owns persistence for this invocation. */
  const provider = fixtures.lifecycleProvider(transport);
  await provider.archiveActiveAgent("child");
  assert.deepEqual(transport.patches[0], {
    properties: {
      Archived: { checkbox: true },
      Task: fixtures.requestRelation([]),
      "Task ID": fixtures.requestRichText(fixtures.ids.task),
    },
  });
  assert.equal((await provider.getActiveAgent("child"))?.archived, true);
  assert.deepEqual(await provider.listActiveAgents(), []);
});

test("Notion Active Agent updates decode the authoritative PATCH page", async () => {
  /** Transport whose query remains stale after returning an authoritative patch. */
  const transport = new fixtures.StaleActiveAgentUpdateTransport();
  /** Updated record decoded directly from the mutation response. */
  const updated = await fixtures
    .lifecycleProvider(transport)
    .updateActiveAgent("child", {
      finishedAt: "2026-08-17T12:01:00.000Z",
      outcome: "completed work",
      status: "completed",
    });

  assert.equal(transport.queryCount, 1);
  assert.deepEqual(updated, {
    agentId: fixtures.ids.agent,
    agentVersion: "agent-version",
    archived: false,
    attempt: 1,
    completionTaskStatus: "",
    failureSummary: "",
    finishedAt: "2026-08-17T12:01:00.000Z",
    harnessId: "harness",
    id: fixtures.ids.childRun,
    lastHeartbeat: "2026-08-17T12:00:00.000Z",
    outcome: "completed work",
    parentRunId: null,
    restartOfRunId: null,
    retryKey: "child",
    runId: "child",
    startedAt: "2026-08-17T12:00:00.000Z",
    status: "completed",
    taskId: fixtures.ids.task,
    version: "2026-08-17T12:01:00.000Z",
    workingDirectory: null,
  });
});

test("Notion Active Agent creation persists historical Task identity", async () => {
  /** Transport boundary exercised by "Notion Active Agent creation persists historical Task identity". */
  const transport = new fixtures.ActiveAgentCreationTransport();
  /** Created state observed by "Notion Active Agent creation persists historical Task identity". */
  const created = await fixtures
    .lifecycleProvider(transport)
    .createActiveAgent({
      agentId: fixtures.ids.agent,
      agentVersion: "agent-version",
      attempt: 1,
      harnessId: "harness",
      parentRunId: null,
      restartOfRunId: null,
      retryKey: "child",
      runId: "child",
      startedAt: "2026-08-17T12:00:00.000Z",
      taskId: fixtures.ids.task,
      workingDirectory: fixtures.activeAgentWorkingDirectory,
    });

  assert.equal(transport.queryCount, 1);
  assert.deepEqual(created, {
    agentId: fixtures.ids.agent,
    agentVersion: "agent-version",
    archived: false,
    attempt: 1,
    completionTaskStatus: "",
    failureSummary: "",
    finishedAt: null,
    harnessId: "harness",
    id: fixtures.ids.childRun,
    lastHeartbeat: "2026-08-17T12:00:00.000Z",
    outcome: "",
    parentRunId: null,
    restartOfRunId: null,
    retryKey: "child",
    runId: "child",
    startedAt: "2026-08-17T12:00:00.000Z",
    status: "running",
    taskId: fixtures.ids.task,
    version: "2026-08-17T12:00:00.000Z",
    workingDirectory: fixtures.activeAgentWorkingDirectory,
  });
  assert.deepEqual(
    transport.createdProperties?.Task,
    fixtures.requestRelation([fixtures.ids.task]),
  );
  assert.deepEqual(
    transport.createdProperties?.["Task ID"],
    fixtures.requestRichText(fixtures.ids.task),
  );
  assert.deepEqual(
    transport.createdProperties?.["Working Directory"],
    fixtures.requestRichText(fixtures.activeAgentWorkingDirectory),
  );
});
