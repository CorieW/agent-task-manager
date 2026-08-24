/** Generic lifecycle command rendering, filtering, ordering, and failure coverage. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  type AgentLifecycleConfig,
  parseAgentLifecycleConfig,
} from "../src/domain/lifecycle.js";
import {
  ConfiguredLifecycleCommands,
  NO_LIFECYCLE_COMMANDS,
  type LifecycleCommandContext,
  type LifecycleCommandInvocation,
} from "../src/core/lifecycle-commands.js";

/** Canonical lifecycle command used by parser and rendering scenarios. */
const command = (executable: string) => ({
  arguments: ["{{runId}}", "{{workingDirectory}}", "{{status}}"],
  environment: {
    AGENT_TASK_MANAGER_RUN_ID: "cannot-override",
    CUSTOM_TASK: "{{taskId}}",
  },
  executable,
  inheritEnvironment: ["FORWARDED"],
  timeoutMilliseconds: 1234,
  workingDirectory: resolve("host", "{{environmentId}}"),
});

test("lifecycle commands render trusted context in configured order", async () => {
  /** Config supplied to "lifecycle commands render trusted context in configured order". */
  const config: AgentLifecycleConfig = {
    afterAgent: [command("cleanup")],
    beforeAgent: [command("prepare")],
    workingDirectory: resolve("runs", "{{runId}}"),
  };
  /** Captured calls used to verify "lifecycle commands render trusted context in configured order". */
  const calls: LifecycleCommandInvocation[] = [];
  /** Lifecycle boundary exercised by "lifecycle commands render trusted context in configured order". */
  const lifecycle = new ConfiguredLifecycleCommands(
    "project",
    { FORWARDED: "yes", PATH: "test-path", SECRET: "must-not-leak" },
    async (invocation) => {
      calls.push(invocation);
    },
  );
  /** Lifecycle context used to render trusted command placeholders. */
  const start = baseContext();
  /** Working directory used to isolate "lifecycle commands render trusted context in configured order". */
  const workingDirectory = lifecycle.workingDirectory(config, start);
  assert.equal(workingDirectory, resolve("runs", "run-1"));
  await lifecycle.before(config, { ...start, workingDirectory });
  await lifecycle.after(config, {
    ...start,
    outcome: "succeeded",
    status: "completed",
    workingDirectory,
  });

  assert.deepEqual(
    calls.map((call) => call.executable),
    ["prepare", "cleanup"],
  );
  assert.deepEqual(calls[0]?.arguments, [
    "run-1",
    resolve("runs", "run-1"),
    "running",
  ]);
  assert.equal(calls[0]?.workingDirectory, resolve("host", "project"));
  assert.equal(calls[0]?.environment.CUSTOM_TASK, "task-1");
  assert.equal(calls[0]?.environment.FORWARDED, "yes");
  assert.equal(calls[0]?.environment.SECRET, undefined);
  assert.equal(calls[0]?.environment.AGENT_TASK_MANAGER_RUN_ID, "run-1");
  assert.equal(
    calls[0]?.environment.AGENT_TASK_MANAGER_LIFECYCLE_PHASE,
    "beforeAgent",
  );
  assert.equal(calls[1]?.environment.AGENT_TASK_MANAGER_STATUS, "completed");
  assert.equal(calls[1]?.environment.AGENT_TASK_MANAGER_OUTCOME, "succeeded");
});

test("lifecycle command failures identify phase and run without leaking output", async () => {
  /** Config supplied to "lifecycle command failures identify phase and run without leaking output". */
  const config: AgentLifecycleConfig = {
    afterAgent: [],
    beforeAgent: [command("prepare")],
    workingDirectory: null,
  };
  /** Lifecycle boundary exercised by "lifecycle command failures identify phase and run without leaking output". */
  const lifecycle = new ConfiguredLifecycleCommands("project", {}, async () => {
    throw new Error("secret command output");
  });
  await assert.rejects(
    lifecycle.before(config, { ...baseContext(), workingDirectory: null }),
    (error: unknown) => {
      assert.match(
        String(error),
        /beforeAgent command 1 failed for run run-1/u,
      );
      assert.doesNotMatch(String(error), /secret command output/u);
      return true;
    },
  );
});

test("Agent lifecycle configuration rejects filters and unsafe templates", () => {
  /** Base supplied to "Agent lifecycle configuration rejects filters and unsafe templates". */
  const base = {
    afterAgent: [],
    beforeAgent: [],
    workingDirectory: resolve("runs", "{{runId}}"),
  };
  assert.throws(
    () => parseAgentLifecycleConfig({ ...base, agentKeys: ["coder"] }),
    /unsupported fields: agentKeys/u,
  );
  assert.throws(
    () =>
      parseAgentLifecycleConfig({
        ...base,
        workingDirectory: resolve("runs", "{{status}}"),
      }),
    /stable start-context/u,
  );
  assert.throws(
    () =>
      parseAgentLifecycleConfig({
        ...base,
        beforeAgent: [
          {
            arguments: ["{{unknown}}"],
            environment: {},
            executable: "prepare",
            inheritEnvironment: [],
            timeoutMilliseconds: 0,
            workingDirectory: null,
          },
        ],
      }),
    /unsupported placeholder|positive integer/u,
  );
});

test("the no-op host fails closed for Agent-owned lifecycle commands", () => {
  /** Config supplied to "the no-op host fails closed for Agent-owned lifecycle commands". */
  const config: AgentLifecycleConfig = {
    afterAgent: [],
    beforeAgent: [],
    workingDirectory: resolve("runs", "{{runId}}"),
  };
  assert.throws(
    () => NO_LIFECYCLE_COMMANDS.workingDirectory(config, baseContext()),
    /requires a host lifecycle executor/u,
  );
});

test("generic before and after commands can manage a Git worktree", async () => {
  /** Root used to isolate "generic before and after commands can manage a Git worktree". */
  const root = await mkdtemp(join(tmpdir(), "atm-lifecycle-git-"));
  /** Repository used to isolate "generic before and after commands can manage a Git worktree". */
  const repository = join(root, "repository");
  /** Captured runs used to verify "generic before and after commands can manage a Git worktree". */
  const runs = join(root, "runs");
  await mkdir(repository);
  try {
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "atm@example.invalid"]);
    await git(repository, ["config", "user.name", "ATM Test"]);
    await writeFile(join(repository, "committed.txt"), "committed\n", "utf8");
    await git(repository, ["add", "committed.txt"]);
    await git(repository, ["commit", "-m", "test: seed"]);
    await writeFile(join(repository, "local-only.txt"), "local\n", "utf8");

    /** Config supplied to "generic before and after commands can manage a Git worktree". */
    const config: AgentLifecycleConfig = {
      beforeAgent: [
        {
          arguments: [
            "worktree",
            "add",
            "-b",
            "atm/{{runId}}",
            "{{workingDirectory}}",
            "main",
          ],
          environment: {},
          executable: "git",
          inheritEnvironment: [],
          timeoutMilliseconds: 30_000,
          workingDirectory: repository,
        },
      ],
      afterAgent: [
        {
          arguments: ["worktree", "remove", "--force", "{{workingDirectory}}"],
          environment: {},
          executable: "git",
          inheritEnvironment: [],
          timeoutMilliseconds: 30_000,
          workingDirectory: repository,
        },
      ],
      workingDirectory: join(runs, "{{runId}}"),
    };
    /** Lifecycle boundary exercised by "generic before and after commands can manage a Git worktree". */
    const lifecycle = new ConfiguredLifecycleCommands("project");
    /** Lifecycle context rooted in the temporary Git worktree. */
    const start = baseContext();
    /** Working directory used to isolate "generic before and after commands can manage a Git worktree". */
    const workingDirectory = lifecycle.workingDirectory(config, start);
    assert.notEqual(workingDirectory, null);
    await lifecycle.before(config, { ...start, workingDirectory });
    assert.equal(
      await readFile(join(workingDirectory!, "committed.txt"), "utf8"),
      "committed\n",
    );
    await assert.rejects(readFile(join(workingDirectory!, "local-only.txt")));
    assert.equal(
      await git(workingDirectory!, ["branch", "--show-current"]),
      "atm/run-1",
    );

    await lifecycle.after(config, {
      ...start,
      outcome: "succeeded",
      status: "completed",
      workingDirectory,
    });
    await assert.rejects(stat(workingDirectory!));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

/** Builds the stable lifecycle context shared by command tests. */
function baseContext(): Omit<LifecycleCommandContext, "workingDirectory"> {
  return {
    agentKey: "coder",
    failureSummary: "",
    harnessId: "harness-1",
    outcome: "",
    parentRunId: null,
    runId: "run-1",
    status: "running",
    taskId: "task-1",
  };
}

/** Runs Git without a shell and returns trimmed standard output. */
function git(
  workingDirectory: string,
  arguments_: readonly string[],
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      [...arguments_],
      { cwd: workingDirectory, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message, { cause: error }));
          return;
        }
        resolveOutput(stdout.trim());
      },
    );
  });
}
