/** Agent Task and Resource eligibility coverage. */
import assert from "node:assert/strict";
import test from "node:test";
import { AgentCoordinator } from "../src/core/coordinator.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";
import * as fixtures from "./support/coordinator.js";

test("ordinary open Errors are informational and inactive Resources block start", async () => {
  /** Coordinator state containing an informational Error and inactive Resource. */
  const state = fixtures.setup();
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
    agents: [fixtures.agent()],
    resources: [
      fixtures.resource("prompt", "Prompt", "draft"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [fixtures.task()],
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
    ...fixtures.agent(),
    resourceIds: ["prompt", "schema"],
  };
  /** Provider containing a non-Prompt, non-Policy Resource. */
  const provider = new InMemoryProvider({
    agents: [customAgent],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("schema", "Schema"),
    ],
    tasks: [fixtures.task()],
  });

  /** Start context retaining every Resource kind granted to the Agent. */
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
    agents: [fixtures.agent()],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [{ ...fixtures.task(), type: "Vulnerability" }],
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
    agents: [fixtures.agent()],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [{ ...fixtures.task(), status: "Ready" }],
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
    ...fixtures.agent(),
    allowedStatuses: ["Planned"],
  };
  /** Transition provider boundary exercised by "Agent Task type and status allowlists guard assignment". */
  const transitionProvider = new InMemoryProvider({
    agents: [transitionAgent],
    resources: [
      fixtures.resource("prompt"),
      fixtures.resource("policy", "Policy"),
    ],
    tasks: [fixtures.task()],
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
