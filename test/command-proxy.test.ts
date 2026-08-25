/** Command-policy parsing, authorization, and shell-free proxy coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type BrokerCommandRequest,
  CommandProxy,
  type CommandExecutionGate,
  type CommandExecutor,
} from "../src/core/command-proxy.js";
import { AgentCoordinator } from "../src/core/coordinator.js";
import {
  type AgentCommandPolicy,
  parseAgentCommandPolicy,
} from "../src/domain/commands.js";
import { EMPTY_AGENT_LIFECYCLE } from "../src/domain/lifecycle.js";
import { EMPTY_AGENT_TASK_DESCRIPTION } from "../src/domain/task-description.js";
import type {
  AgentRecord,
  ResourceRecord,
  TaskRecord,
} from "../src/domain/records.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";

/** Creates a running Agent and proxy for one command policy. */
async function setup(policy: AgentCommandPolicy) {
  /** Task captured by the setup fixture. */
  const task: TaskRecord = {
    archived: false,
    body: "Task",
    dependencies: [],
    id: "task-1",
    priority: null,
    properties: {},
    status: "Planned",
    title: "Task",
    type: "Feature",
    version: "1",
  };
  /** Resource currently resolved or validated for Agent context. */
  const resource = (id: string, kind: string): ResourceRecord => ({
    archived: false,
    body: id,
    id,
    key: id,
    kind,
    properties: {},
    state: "active",
    version: "1",
  });
  /** Agent definition resolved for the current run. */
  const agent: AgentRecord = {
    allowedStatuses: ["Planned", "In review"],
    allowedTaskTypes: ["Feature"],
    archived: false,
    body: "Agent",
    calledBy: "harness-1",
    commands: policy,
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
    transitions: { succeeded: "In review" },
    version: "1",
  };
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    agents: [agent],
    resources: [resource("prompt", "Prompt"), resource("policy", "Policy")],
    tasks: [task],
  });
  /** Coordinator captured by the setup fixture. */
  const coordinator = new AgentCoordinator(provider);
  /** Context captured by the setup fixture. */
  const context = await coordinator.start({
    agentKey: "coder",
    harnessId: "harness-1",
    parentRunId: null,
    runId: "run-1",
    taskId: "task-1",
  });
  return { context, coordinator, provider };
}

/** Gate that executes authorized requests immediately in proxy unit tests. */
const immediateGate: CommandExecutionGate = {
  execute: async <T>(
    _runId: string,
    authorize: () => Promise<BrokerCommandRequest>,
    execute: (request: BrokerCommandRequest) => Promise<T>,
  ) => execute(await authorize()),
};

test("command proxy enforces inclusion, ownership, and path-free names", async () => {
  /** Running context and coordinator used for command-policy authorization. */
  const { context, coordinator } = await setup({ inclusion: ["git"] });
  /** Captured calls used to verify "command proxy enforces inclusion, ownership, and path-free names". */
  const calls: BrokerCommandRequest[] = [];
  /** Flag recording locked during "command proxy enforces inclusion, ownership, and path-free names". */
  let locked = false;
  /** Gate boundary exercised by "command proxy enforces inclusion, ownership, and path-free names". */
  const gate: CommandExecutionGate = {
    execute: async <T>(
      _runId: string,
      authorize: () => Promise<BrokerCommandRequest>,
      execute: (request: BrokerCommandRequest) => Promise<T>,
    ) => {
      assert.equal(locked, false);
      locked = true;
      try {
        return await execute(await authorize());
      } finally {
        locked = false;
      }
    },
  };
  /** Executor boundary exercised by "command proxy enforces inclusion, ownership, and path-free names". */
  const executor: CommandExecutor = async (request) => {
    assert.equal(locked, true);
    calls.push(request);
    return {
      command: "git",
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "clean",
    };
  };
  /** Proxy boundary exercised by "command proxy enforces inclusion, ownership, and path-free names". */
  const proxy = new CommandProxy(coordinator, executor, gate, "win32");
  assert.match(context.systemPrompt, /exclusively through/u);
  assert.match(context.systemPrompt, /allowedTaskTypes and allowedStatuses/u);
  assert.match(context.systemPrompt, /Never invoke a shell/u);
  assert.match(context.systemPrompt, /harness binds the current run identity/u);
  assert.doesNotMatch(context.systemPrompt, /--run-id|--harness-id/u);
  assert.equal(
    (
      await proxy.execute({
        arguments: ["status"],
        command: "git.exe.com...",
        harnessId: "harness-1",
        runId: "run-1",
      })
    ).stdout,
    "clean",
  );
  assert.deepEqual(calls, [
    {
      arguments: ["status"],
      command: "git",
      commands: { inclusion: ["git"] },
      runId: "run-1",
      schema: "agent-command-broker-request-v1",
      workingDirectory: null,
    },
  ]);
  await assert.rejects(
    proxy.execute({
      arguments: [],
      command: "node",
      harnessId: "harness-1",
      runId: "run-1",
    }),
    /command is not allowed: node/u,
  );
  await assert.rejects(
    proxy.execute({
      arguments: [],
      command: "git",
      harnessId: "other-harness",
      runId: "run-1",
    }),
    /Harness does not own Active Agent/u,
  );
  await assert.rejects(
    proxy.execute({
      arguments: [],
      command: "C:\\bin\\git.exe",
      harnessId: "harness-1",
      runId: "run-1",
    }),
    /Invalid command name/u,
  );
  assert.equal(calls.length, 1);
});

test("command proxy exclusion denies only configured commands", async () => {
  /** Coordinator boundary exercised by "command proxy exclusion denies only configured commands". */
  const { coordinator } = await setup(
    parseAgentCommandPolicy({ exclusion: ["rm"] }, "win32"),
  );
  /** Executor boundary exercised by "command proxy exclusion denies only configured commands". */
  const executor: CommandExecutor = async (request) => ({
    command: request.command,
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout: request.command,
  });
  /** Proxy boundary exercised by "command proxy exclusion denies only configured commands". */
  const proxy = new CommandProxy(coordinator, executor, immediateGate, "win32");
  assert.equal(
    (
      await proxy.execute({
        arguments: [],
        command: "git",
        harnessId: "harness-1",
        runId: "run-1",
      })
    ).stdout,
    "git",
  );
  await assert.rejects(
    proxy.execute({
      arguments: [],
      command: "rm.exe.com...",
      harnessId: "harness-1",
      runId: "run-1",
    }),
    /command is not allowed: rm/u,
  );
});

test("command authorization does not enumerate unrelated Agents", async () => {
  /** Coordinator, provider boundary exercised by "command authorization does not enumerate unrelated Agents". */
  const { coordinator, provider } = await setup({ inclusion: ["git"] });
  provider.listAgents = async () => {
    throw new Error("unrelated Agent body is malformed");
  };
  assert.deepEqual(
    await coordinator.commandAuthorization("run-1", "harness-1"),
    { commands: { inclusion: ["git"] }, workingDirectory: null },
  );
});

test("POSIX proxy preserves the exact authorized executable name", async () => {
  /** Strictly decoded Agent command policy. */
  const policy = parseAgentCommandPolicy({ inclusion: ["Safe.exe"] }, "linux");
  /** Coordinator boundary exercised by "POSIX proxy preserves the exact authorized executable name". */
  const { coordinator } = await setup(policy);
  /** Captured requests used to verify "POSIX proxy preserves the exact authorized executable name". */
  const requests: BrokerCommandRequest[] = [];
  /** Proxy boundary exercised by "POSIX proxy preserves the exact authorized executable name". */
  const proxy = new CommandProxy(
    coordinator,
    async (request) => {
      requests.push(request);
      return {
        command: request.command,
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: "",
      };
    },
    immediateGate,
    "linux",
  );
  await proxy.execute({
    arguments: [],
    command: "Safe.exe",
    harnessId: "harness-1",
    runId: "run-1",
  });
  assert.equal(requests[0]?.command, "Safe.exe");
  assert.deepEqual(requests[0]?.commands, { inclusion: ["Safe.exe"] });
  await assert.rejects(
    proxy.execute({
      arguments: [],
      command: "safe",
      harnessId: "harness-1",
      runId: "run-1",
    }),
    /command is not allowed: safe/u,
  );
});
