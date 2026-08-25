/** Sandbox broker process, protocol, timeout, and containment coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type BrokerCommandRequest,
  createCommandBrokerExecutor,
} from "../src/core/command-proxy.js";

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
