/** Command-policy parsing, authorization, and shell-free proxy coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type BrokerCommandRequest,
  CommandProxy,
  createCommandBrokerExecutor,
  createCommandExecutionGate,
  type CommandExecutionGate,
  type CommandExecutor,
} from "../src/core/command-proxy.js";
import { commandProxySystemPrompt } from "../src/core/agent-system-prompt.js";
import { AgentCoordinator } from "../src/core/coordinator.js";
import {
  type AgentCommandPolicy,
  parseAgentCommandPolicy,
} from "../src/domain/commands.js";
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

const immediateGate: CommandExecutionGate = {
  execute: async <T>(
    _runId: string,
    authorize: () => Promise<BrokerCommandRequest>,
    execute: (request: BrokerCommandRequest) => Promise<T>,
  ) => execute(await authorize()),
};

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
  assert.deepEqual(parseAgentCommandPolicy({ inclusion: ["git.com"] }), {
    inclusion: ["git"],
  });
  assert.deepEqual(parseAgentCommandPolicy({ inclusion: ["git.exe.com"] }), {
    inclusion: ["git"],
  });
  assert.throws(
    () =>
      parseAgentCommandPolicy({
        inclusion: ["git", "git.com", "git.exe.com"],
      }),
    /contains duplicates/u,
  );
});

test("command proxy enforces inclusion, ownership, and path-free names", async () => {
  const { context, coordinator } = await setup({ inclusion: ["git"] });
  const calls: BrokerCommandRequest[] = [];
  let locked = false;
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
  const proxy = new CommandProxy(coordinator, executor, gate);
  assert.match(context.systemPrompt, /exclusively through/u);
  assert.match(context.systemPrompt, /Never invoke a shell/u);
  assert.match(context.systemPrompt, /--run-id="run-1"/u);
  assert.match(context.systemPrompt, /--harness-id="harness-1"/u);
  assert.equal(
    (
      await proxy.execute({
        arguments: ["status"],
        command: "git.exe.com",
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

test("command prompt binds flag-like run identifiers", () => {
  const prompt = commandProxySystemPrompt("--run", "--harness");
  assert.match(prompt, /--run-id="--run"/u);
  assert.match(prompt, /--harness-id="--harness"/u);
});

test("command proxy exclusion denies only configured commands", async () => {
  const { coordinator } = await setup(
    parseAgentCommandPolicy({ exclusion: ["rm.exe.com"] }),
  );
  const executor: CommandExecutor = async (request) => ({
    command: request.command,
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout: request.command,
  });
  const proxy = new CommandProxy(coordinator, executor, immediateGate);
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
      command: "rm.exe.com",
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
          stdout: JSON.stringify({
            arguments: request.arguments,
            commands: request.commands,
            locale: process.env.LANG,
            runId: request.runId,
            schema: request.schema,
            secret: process.env.${secretName}
          })
        }));
      });
    `;
    const executor = createCommandBrokerExecutor(
      process.execPath,
      ["--input-type=commonjs", "-e", broker],
      { environment: { ...process.env, LANG: "broker-locale" } },
    );
    const result = await executor({
      arguments: ["status", "&&", "node"],
      command: "git",
      commands: { inclusion: ["git"] },
      runId: "run-1",
      schema: "agent-command-broker-request-v1",
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      arguments: ["status", "&&", "node"],
      commands: { inclusion: ["git"] },
      locale: "broker-locale",
      runId: "run-1",
      schema: "agent-command-broker-request-v1",
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

test("sandbox broker exchange enforces timeout and output bounds", async () => {
  const hanging = createCommandBrokerExecutor(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { terminationGraceMilliseconds: 25, timeoutMilliseconds: 25 },
  );
  await assert.rejects(
    hanging(brokerRequest()),
    /timed out after 25 milliseconds/u,
  );
  for (const stream of ["stdout", "stderr"] as const) {
    const script = `process.${stream}.write("x".repeat(256))`;
    const overflowing = createCommandBrokerExecutor(
      process.execPath,
      ["-e", script],
      { maxOutputBytes: 64 },
    );
    await assert.rejects(
      overflowing(brokerRequest()),
      /output exceeded 64 bytes/u,
    );
  }
});

test("sandbox broker confirms forced shutdown and handles early stdin closure", async () => {
  if (process.platform !== "win32") {
    const resistant = createCommandBrokerExecutor(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000)',
      ],
      { terminationGraceMilliseconds: 40, timeoutMilliseconds: 20 },
    );
    const started = Date.now();
    await assert.rejects(
      resistant(brokerRequest()),
      /timed out after 20 milliseconds/u,
    );
    assert.ok(Date.now() - started >= 40);
  }
  const earlyExit = createCommandBrokerExecutor(process.execPath, [
    "-e",
    "process.exit(0)",
  ]);
  await assert.rejects(earlyExit(brokerRequest()));
});

test("sandbox broker rejects ambiguous terminal results", async () => {
  for (const terminal of [
    { exitCode: null, signal: null },
    { exitCode: 0, signal: "SIGTERM" },
    { exitCode: -1, signal: null },
    { exitCode: null, signal: "NOT_A_SIGNAL" },
  ]) {
    const result = JSON.stringify({
      command: "git",
      ...terminal,
      stderr: "",
      stdout: "",
    });
    const executor = createCommandBrokerExecutor(process.execPath, [
      "-e",
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(result)}))`,
    ]);
    await assert.rejects(
      executor(brokerRequest()),
      /returned an invalid result/u,
    );
  }
});

test("command gate releases the global mutex while retaining the run lease", async () => {
  let globallyLocked = false;
  let runLocked = false;
  const globalMutex = {
    lock: async () => async () => undefined,
    run: async <T>(operation: () => Promise<T>) => {
      globallyLocked = true;
      try {
        return await operation();
      } finally {
        globallyLocked = false;
      }
    },
  };
  const runMutex = {
    lock: async (options?: { readonly reclaimable?: boolean }) => {
      assert.equal(globallyLocked, true);
      assert.deepEqual(options, { reclaimable: false });
      runLocked = true;
      return async () => {
        runLocked = false;
      };
    },
    run: async <T>(operation: () => Promise<T>) => operation(),
  };
  const gate = createCommandExecutionGate(globalMutex, () => runMutex);
  const result = await gate.execute(
    "run-1",
    async () => {
      assert.equal(globallyLocked, true);
      assert.equal(runLocked, true);
      return {
        arguments: [],
        command: "git",
        commands: { inclusion: ["git"] },
        runId: "run-1",
        schema: "agent-command-broker-request-v1",
      };
    },
    async () => {
      assert.equal(globallyLocked, false);
      assert.equal(runLocked, true);
      return "complete";
    },
  );
  assert.equal(result, "complete");
  assert.equal(runLocked, false);
  await assert.rejects(
    gate.execute(
      "run-1",
      async () => brokerRequest(),
      async () => {
        throw new Error("broker failed");
      },
    ),
    /broker failed/u,
  );
  assert.equal(runLocked, false);
});

function brokerRequest(): BrokerCommandRequest {
  return {
    arguments: [],
    command: "git",
    commands: { inclusion: ["git"] },
    runId: "run-1",
    schema: "agent-command-broker-request-v1",
  };
}
