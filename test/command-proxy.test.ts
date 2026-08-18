/** Command-policy parsing, authorization, and shell-free proxy coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandProxy,
  createCommandBrokerExecutor,
  type CommandExecutor,
} from "../src/core/command-proxy.js";
import { AgentCoordinator } from "../src/core/coordinator.js";
import type { AgentCommandPolicy } from "../src/domain/commands.js";
import type {
  AgentRecord,
  ResourceRecord,
  TaskRecord,
} from "../src/domain/records.js";
import { parseAgentDefinition } from "../src/domain/records.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";

/** Creates a running Agent and proxy for one command policy. */
async function setup(policy: AgentCommandPolicy) {
  const task: TaskRecord = {
    archived: false,
    body: "Task",
    dependencies: [],
    id: "task-1",
    priority: null,
    properties: {},
    status: "Planned",
    title: "Task",
    version: "1",
  };
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
  const agent: AgentRecord = {
    archived: false,
    body: "Agent",
    calledBy: "harness",
    commands: policy,
    enabled: true,
    id: "agent-1",
    key: "coder",
    model: "gpt",
    name: "Coder",
    notes: "",
    properties: {},
    reasoning: "high",
    resourceIds: ["prompt", "policy"],
    transitions: { succeeded: "In review" },
    version: "1",
  };
  const provider = new InMemoryProvider({
    agents: [agent],
    resources: [resource("prompt", "Prompt"), resource("policy", "Policy")],
    tasks: [task],
  });
  const coordinator = new AgentCoordinator(provider);
  const context = await coordinator.start({
    agentKey: "coder",
    harnessId: "harness-1",
    parentRunId: null,
    runId: "run-1",
    taskId: "task-1",
  });
  return { context, coordinator };
}

test("Agent command policies require exactly one normalized list", () => {
  const definition = {
    enabled: true,
    id: "coder",
    inputResourceSelectors: ["policy/review"],
    model: "gpt",
    promptResources: ["prompt/coder"],
    reasoning: "high",
    schema: "agent-definition-v2",
    transitions: { succeeded: "In review" },
  };
  const markdown = (commands: object): string =>
    `## Agent definition\n\n\`\`\`json\n${JSON.stringify({ ...definition, commands })}\n\`\`\`\n`;
  assert.throws(
    () => parseAgentDefinition(markdown({ inclusion: ["git"], exclusion: [] })),
    /commands must define exactly one/u,
  );
});

test("command proxy enforces inclusion, ownership, and path-free names", async () => {
  const { context, coordinator } = await setup({ inclusion: ["git"] });
  const calls: Array<{ arguments: readonly string[]; command: string }> = [];
  const executor: CommandExecutor = async (command, arguments_) => {
    calls.push({ arguments: arguments_, command });
    return {
      command: "git",
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "clean",
    };
  };
  const proxy = new CommandProxy(coordinator, executor);
  assert.match(context.systemPrompt, /exclusively through/u);
  assert.match(context.systemPrompt, /Never invoke a shell/u);
  assert.match(context.systemPrompt, /--run-id "run-1"/u);
  assert.match(context.systemPrompt, /--harness-id "harness-1"/u);
  assert.equal(
    (
      await proxy.execute({
        arguments: ["status"],
        command: "git.exe",
        harnessId: "harness-1",
        runId: "run-1",
      })
    ).stdout,
    "clean",
  );
  assert.deepEqual(calls, [{ arguments: ["status"], command: "git.exe" }]);
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
  const { coordinator } = await setup({ exclusion: ["rm"] });
  const executor: CommandExecutor = async (command) => ({
    command,
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout: command,
  });
  const proxy = new CommandProxy(coordinator, executor);
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
      command: "rm",
      harnessId: "harness-1",
      runId: "run-1",
    }),
    /command is not allowed: rm/u,
  );
});

test("sandbox broker receives literal arguments without manager secrets", async () => {
  const secretName = "AGENT_TASK_MANAGER_PROXY_TEST_SECRET";
  const previous = process.env[secretName];
  process.env[secretName] = "must-not-leak";
  try {
    const broker = `
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const request = JSON.parse(input);
        process.stdout.write(JSON.stringify({
          command: request.command,
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: JSON.stringify({ arguments: request.arguments, secret: process.env.${secretName} })
        }));
      });
    `;
    const executor = createCommandBrokerExecutor(process.execPath, [
      "--input-type=commonjs",
      "-e",
      broker,
    ]);
    const result = await executor("git", ["status", "&&", "node"]);
    assert.deepEqual(JSON.parse(result.stdout), {
      arguments: ["status", "&&", "node"],
    });
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
  }
});

test("sandbox broker path must be absolute", () => {
  assert.throws(
    () => createCommandBrokerExecutor("broker"),
    /must be an absolute path/u,
  );
});
