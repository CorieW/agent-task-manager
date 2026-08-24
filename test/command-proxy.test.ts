/** Command-policy parsing, authorization, and shell-free proxy coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type BrokerCommandRequest,
  CommandProxy,
  ContainmentShutdownUnconfirmedError,
  createCommandBrokerExecutor,
  createCommandExecutionGate,
  type CommandExecutionGate,
  type CommandExecutor,
} from "../src/core/command-proxy.js";
import { commandProxySystemPrompt } from "../src/core/agent-system-prompt.js";
import { AgentCoordinator } from "../src/core/coordinator.js";
import {
  commandIsAllowed,
  type AgentCommandPolicy,
  normalizeCommandName,
  parseAgentCommandPolicy,
} from "../src/domain/commands.js";
import { EMPTY_AGENT_LIFECYCLE } from "../src/domain/lifecycle.js";
import { EMPTY_AGENT_TASK_DESCRIPTION } from "../src/domain/task-description.js";
import type {
  AgentRecord,
  ResourceRecord,
  TaskRecord,
} from "../src/domain/records.js";
import { parseAgentDefinition } from "../src/domain/records.js";
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

test("Agent command policies require exactly one normalized list", () => {
  /** Strict Agent definition parsed from authoritative Markdown. */
  const definition = {
    allowedStatuses: ["In review"],
    allowedTaskTypes: ["Feature"],
    enabled: true,
    id: "coder",
    inputResourceSelectors: ["policy/review"],
    model: "gpt",
    promptResources: ["prompt/coder"],
    reasoning: "high",
    schema: "agent-definition-v1",
    transitions: { succeeded: "In review" },
  };
  /** Markdown supplied to "Agent command policies require exactly one normalized list". */
  const markdown = (commands: object): string =>
    `## Agent definition\n\n\`\`\`json\n${JSON.stringify({ ...definition, commands })}\n\`\`\`\n`;
  assert.throws(
    () => parseAgentDefinition(markdown({ inclusion: ["git"], exclusion: [] })),
    /commands must define exactly one/u,
  );
  assert.deepEqual(parseAgentCommandPolicy({ inclusion: ["git.com"] }), {
    inclusion: ["git"],
  });
  assert.deepEqual(parseAgentCommandPolicy({ inclusion: ["git.exe.com..."] }), {
    inclusion: ["git"],
  });
  assert.throws(
    () =>
      parseAgentCommandPolicy({
        inclusion: ["git", "git.com", "git.exe.com..."],
      }),
    /contains duplicates/u,
  );
});

test("command identities follow host-platform executable semantics", () => {
  assert.equal(normalizeCommandName("Tool.EXE...", "win32"), "tool");
  assert.deepEqual(
    parseAgentCommandPolicy(
      { inclusion: ["Tool", "tool.exe", "tool."] },
      "linux",
    ),
    { inclusion: ["Tool", "tool.exe", "tool."] },
  );
  /** Upper case exercised by "command identities follow host-platform executable semantics". */
  const upper = parseAgentCommandPolicy({ inclusion: ["Safe"] }, "linux");
  assert.equal(commandIsAllowed(upper, "Safe", "linux"), true);
  assert.equal(commandIsAllowed(upper, "safe", "linux"), false);
  /** Suffixed case exercised by "command identities follow host-platform executable semantics". */
  const suffixed = parseAgentCommandPolicy(
    { inclusion: ["safe.exe"] },
    "linux",
  );
  assert.equal(commandIsAllowed(suffixed, "safe.exe", "linux"), true);
  assert.equal(commandIsAllowed(suffixed, "safe", "linux"), false);
});

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
  const proxy = new CommandProxy(coordinator, executor, gate);
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

test("command prompt leaves run identity to the trusted harness", () => {
  /** Prompt supplied to "command prompt leaves run identity to the trusted harness". */
  const prompt = commandProxySystemPrompt(EMPTY_AGENT_TASK_DESCRIPTION);
  assert.match(prompt, /command proxy -- <command>/u);
  assert.doesNotMatch(prompt, /--run-id|--harness-id/u);
});

test("command prompt delegates configured Task sections to the harness", () => {
  /** Prompt supplied to "command prompt delegates configured Task sections to the harness". */
  const prompt = commandProxySystemPrompt({
    requiredSectionsByOutcome: { succeeded: ["Planning"] },
    writableSections: ["Planning"],
  });
  assert.match(prompt, /only these Task-description sections: `Planning`/u);
  assert.match(prompt, /active-agent update-task-section/u);
  assert.match(prompt, /do not invoke it through the operating-system/u);
});

test("command proxy exclusion denies only configured commands", async () => {
  /** Coordinator boundary exercised by "command proxy exclusion denies only configured commands". */
  const { coordinator } = await setup(
    parseAgentCommandPolicy({ exclusion: ["rm"] }),
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

test("sandbox broker receives literal arguments without manager secrets", async () => {
  /** Secret name supplied to "sandbox broker receives literal arguments without manager secrets". */
  const secretName = "AGENT_TASK_MANAGER_PROXY_TEST_SECRET";
  /** Host broker setting restored after the isolation assertion. */
  const previous = process.env[secretName];
  process.env[secretName] = "must-not-leak";
  try {
    /** Broker boundary exercised by "sandbox broker receives literal arguments without manager secrets". */
    const broker = `
      let input = "";
      let handled = false;
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => {
        input += chunk;
        if (handled || !input.includes("\\n")) return;
        handled = true;
        const request = JSON.parse(input);
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            command: request.command,
            exitCode: 0,
            signal: null,
            stderr: "",
            stdout: JSON.stringify({
              arguments: request.arguments,
              commands: request.commands,
              cwd: process.cwd(),
              locale: process.env.LANG,
              livenessChannelOpen: !process.stdin.readableEnded,
              runId: request.runId,
              schema: request.schema,
              workingDirectory: request.workingDirectory,
              secret: process.env.${secretName},
              tempLeaked: process.env.TEMP === "manager-temp-sentinel",
              tmpLeaked: process.env.TMP === "manager-tmp-sentinel",
              tmpdirLeaked: process.env.TMPDIR === "manager-tmpdir-sentinel"
            })
          }), () => process.exit(0));
        }, 20);
      });
    `;
    /** Executor boundary exercised by "sandbox broker receives literal arguments without manager secrets". */
    const executor = createCommandBrokerExecutor(
      process.execPath,
      ["--input-type=commonjs", "-e", broker],
      {
        environment: {
          ...process.env,
          LANG: "broker-locale",
          TEMP: "manager-temp-sentinel",
          TMP: "manager-tmp-sentinel",
          TMPDIR: "manager-tmpdir-sentinel",
        },
      },
    );
    /** Broker result returned after inspecting the sanitized request. */
    const result = await executor({
      arguments: ["status", "&&", "node"],
      command: "git",
      commands: { inclusion: ["git"] },
      runId: "run-1",
      schema: "agent-command-broker-request-v1",
      workingDirectory: process.cwd(),
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      arguments: ["status", "&&", "node"],
      commands: { inclusion: ["git"] },
      cwd: process.cwd(),
      locale: "broker-locale",
      livenessChannelOpen: true,
      runId: "run-1",
      schema: "agent-command-broker-request-v1",
      tempLeaked: false,
      tmpLeaked: false,
      tmpdirLeaked: false,
      workingDirectory: process.cwd(),
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

test("sandbox broker exchange enforces timeout and output bounds", async () => {
  /** Flag recording hanging during "sandbox broker exchange enforces timeout and output bounds". */
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
    /** Script used to isolate "sandbox broker exchange enforces timeout and output bounds". */
    const script = `process.${stream}.write("x".repeat(256))`;
    /** Overflowing case exercised by "sandbox broker exchange enforces timeout and output bounds". */
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
    /** Flag recording resistant during "sandbox broker confirms forced shutdown and handles early stdin closure". */
    const resistant = createCommandBrokerExecutor(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000)',
      ],
      { terminationGraceMilliseconds: 40, timeoutMilliseconds: 20 },
    );
    /** Flag recording started during "sandbox broker confirms forced shutdown and handles early stdin closure". */
    const started = Date.now();
    await assert.rejects(
      resistant(brokerRequest()),
      /timed out after 20 milliseconds/u,
    );
    assert.ok(Date.now() - started >= 40);
  }
  /** Early exit state observed by "sandbox broker confirms forced shutdown and handles early stdin closure". */
  const earlyExit = createCommandBrokerExecutor(process.execPath, [
    "-e",
    "process.exit(0)",
  ]);
  await assert.rejects(earlyExit(brokerRequest()));
});

test("sandbox broker receives cancellation through its liveness channel", async () => {
  if (process.platform === "win32") return;
  /** Broker boundary exercised by "sandbox broker receives cancellation through its liveness channel". */
  const broker = `
    process.on("SIGTERM", () => undefined);
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    setInterval(() => undefined, 1000);
  `;
  /** Executor boundary exercised by "sandbox broker receives cancellation through its liveness channel". */
  const executor = createCommandBrokerExecutor(
    process.execPath,
    ["-e", broker],
    { terminationGraceMilliseconds: 1000, timeoutMilliseconds: 25 },
  );
  /** Flag recording started during "sandbox broker receives cancellation through its liveness channel". */
  const started = Date.now();
  await assert.rejects(
    executor(brokerRequest()),
    /timed out after 25 milliseconds/u,
  );
  assert.ok(Date.now() - started < 1000);
});

test("sandbox broker rejects ambiguous terminal results", async () => {
  for (const terminal of [
    { exitCode: null, signal: null },
    { exitCode: 0, signal: "SIGTERM" },
    { exitCode: -1, signal: null },
    { exitCode: null, signal: "NOT_A_SIGNAL" },
  ]) {
    /** Ambiguous broker response used to exercise strict result parsing. */
    const result = JSON.stringify({
      command: "git",
      ...terminal,
      stderr: "",
      stdout: "",
    });
    /** Executor boundary exercised by "sandbox broker rejects ambiguous terminal results". */
    const executor = createCommandBrokerExecutor(process.execPath, [
      "-e",
      `process.stdin.once("data", () => process.stdout.write(${JSON.stringify(result)}, () => process.exit(0)))`,
    ]);
    await assert.rejects(
      executor(brokerRequest()),
      /returned an invalid result/u,
    );
  }
});

test("command gate releases the global mutex while retaining the run lease", async () => {
  /** Whether the short-lived global mutex is currently held. */
  let globallyLocked = false;
  /** Whether containment failure deliberately abandoned the run lease. */
  let runAbandoned = false;
  /** Whether command execution still owns the non-reclaimable run lease. */
  let runLocked = false;
  /** Global mutex boundary exercised by "command gate releases the global mutex while retaining the run lease". */
  const globalMutex = {
    lock: async () =>
      Object.assign(async () => undefined, {
        abandon: async () => undefined,
      }),
    run: async <T>(operation: () => Promise<T>) => {
      globallyLocked = true;
      try {
        return await operation();
      } finally {
        globallyLocked = false;
      }
    },
  };
  /** Run mutex boundary exercised by "command gate releases the global mutex while retaining the run lease". */
  const runMutex = {
    lock: async (options?: {
      /** Whether a dead owner permits the test mutex to be reclaimed. */
      readonly reclaimable?: boolean;
    }) => {
      assert.equal(globallyLocked, true);
      assert.deepEqual(options, { reclaimable: false });
      runLocked = true;
      return Object.assign(
        async () => {
          runLocked = false;
        },
        {
          abandon: async () => {
            runAbandoned = true;
            runLocked = false;
          },
        },
      );
    },
    run: async <T>(operation: () => Promise<T>) => operation(),
  };
  /** Gate boundary exercised by "command gate releases the global mutex while retaining the run lease". */
  const gate = createCommandExecutionGate(globalMutex, () => runMutex);
  /** Command result returned while only the run lease is held. */
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
        workingDirectory: null,
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
  assert.equal(runAbandoned, false);
  await assert.rejects(
    gate.execute(
      "run-1",
      async () => brokerRequest(),
      async () => {
        throw new ContainmentShutdownUnconfirmedError("unconfirmed");
      },
    ),
    /unconfirmed/u,
  );
  assert.equal(runLocked, false);
  assert.equal(runAbandoned, true);
});

/** Builds the minimal authorized request accepted by broker tests. */
function brokerRequest(): BrokerCommandRequest {
  return {
    arguments: [],
    command: "git",
    commands: { inclusion: ["git"] },
    runId: "run-1",
    schema: "agent-command-broker-request-v1",
    workingDirectory: null,
  };
}
