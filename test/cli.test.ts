/** CLI parsing and command-registry regression coverage. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  isDirectExecution,
  proxyExitCode,
  runCli,
  sweepWithRunLeases,
} from "../src/cli.js";
import { AgentCoordinator } from "../src/core/coordinator.js";
import type { ActiveAgentRecord } from "../src/domain/records.js";
import { InMemoryProvider } from "../src/provider/in-memory-provider.js";
import { SingleHostMutex } from "../src/provider/notion/single-host-mutex.js";

test("CLI rejects unknown and command-irrelevant flags", async () => {
  await assert.rejects(
    runCli(["providers", "--sttaus", "Open"]),
    /Flag --sttaus is not allowed for providers/u,
  );
  await assert.rejects(
    runCli(["task", "list", "--outcome", "succeeded"]),
    /Flag --outcome is not allowed for task list/u,
  );
  assert.deepEqual(await runCli(["providers", "--json"]), {
    providers: [{ connectionSecret: "NOTION_TOKEN", type: "notion" }],
  });
  await assert.rejects(
    runCli(["command", "proxy", "--run-id", "other", "--", "git"]),
    /Flag --run-id is not allowed for command proxy/u,
  );
  await assert.rejects(
    runCli(["command", "proxy", "--environment", "other.json", "--", "git"]),
    /Flag --environment is not allowed for command proxy/u,
  );
});

test("boolean flags do not consume command positionals", async () => {
  /** Test fixture for providers. */
  const providers = {
    providers: [{ connectionSecret: "NOTION_TOKEN", type: "notion" }],
  };
  assert.deepEqual(await runCli(["--json", "providers"]), providers);
  /** Test fixture for help. */
  const help = await runCli(["task", "--help", "list"]);
  assert.equal(
    typeof help === "object" && help !== null && "help" in help,
    true,
  );
  await assert.rejects(
    runCli(["providers", "--json=true"]),
    /Boolean flag --json does not accept a value/u,
  );
});

test("CLI rejects unknown command shapes before loading configuration", async () => {
  await assert.rejects(
    runCli(["providers", "bogus", "--json"]),
    /Unknown command: providers bogus/u,
  );
  /** Test fixture for help. */
  const help = await runCli(["help"]);
  assert.equal(
    typeof help === "object" &&
      help !== null &&
      "help" in help &&
      typeof help.help === "string" &&
      help.help.includes("active-agent restart") &&
      help.help.includes("active-agent update-task-section"),
    true,
  );
});

test("CLI reports signalled proxy commands as failures", () => {
  assert.equal(
    proxyExitCode({
      command: "git",
      exitCode: null,
      signal: "SIGTERM",
      stderr: "",
      stdout: "",
    }),
    1,
  );
  assert.equal(proxyExitCode({ exitCode: 7 }), 7);
  assert.equal(proxyExitCode({ exitCode: 0, signal: "SIGTERM" }), 1);
  assert.equal(proxyExitCode({ result: "not a command" }), null);
});

test("CLI entry detection resolves linked global package directories", async () => {
  /** Test fixture for root. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-entry-"));
  /** Test fixture for real directory. */
  const realDirectory = join(root, "real");
  /** Test fixture for linked directory. */
  const linkedDirectory = join(root, "linked");
  /** Test fixture for real entry. */
  const realEntry = join(realDirectory, "cli.js");
  try {
    await mkdir(realDirectory);
    await writeFile(realEntry, "// test entry\n", "utf8");
    await symlink(
      realDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      isDirectExecution(
        pathToFileURL(realEntry).href,
        join(linkedDirectory, "cli.js"),
      ),
      true,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

/** Creates one Active Agent fixture for scoped sweep orchestration. */
function activeRun(
  runId: string,
  lastHeartbeat: string,
  parentRunId: string | null = null,
): ActiveAgentRecord {
  return {
    agentId: "agent",
    agentVersion: "1",
    archived: false,
    attempt: 1,
    failureSummary: "",
    finishedAt: null,
    harnessId: "harness",
    id: runId,
    lastHeartbeat,
    outcome: "",
    parentRunId,
    restartOfRunId: null,
    retryKey: runId,
    runId,
    startedAt: lastHeartbeat,
    status: "running",
    taskId: `task-${runId}`,
    version: "1",
    workingDirectory: null,
  };
}

test("sweep ignores an unrelated healthy command lease", async () => {
  /** Test fixture for root. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-sweep-"));
  try {
    /** Provider implementation that owns persistence for this invocation. */
    const provider = new InMemoryProvider({
      activeAgents: [
        activeRun("stale", "2026-08-17T12:00:00.000Z"),
        activeRun("healthy", "2026-08-17T12:09:00.000Z"),
      ],
    });
    /** Test fixture for coordinator. */
    const coordinator = new AgentCoordinator(
      provider,
      () => new Date("2026-08-17T12:10:00.000Z"),
    );
    /** Test fixture for run mutex. */
    const runMutex = (runId: string) =>
      new SingleHostMutex(
        { environmentId: "environment", runId, scope: "command" },
        root,
      );
    /** Test fixture for release healthy. */
    const releaseHealthy = await runMutex("healthy").lock({
      reclaimable: false,
    });
    try {
      /** Test fixture for result. */
      const result = await sweepWithRunLeases(
        new SingleHostMutex(
          { environmentId: "environment", scope: "environment" },
          root,
        ),
        runMutex,
        coordinator,
      );
      assert.deepEqual(result.blockedRunIds, []);
      assert.deepEqual(
        result.swept.map((entry) => entry.run.runId),
        ["stale"],
      );
    } finally {
      await releaseHealthy();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("sweep isolates a fenced stale subtree and releases partial leases", async () => {
  /** Test fixture for root. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-sweep-"));
  try {
    /** Provider implementation that owns persistence for this invocation. */
    const provider = new InMemoryProvider({
      activeAgents: [
        activeRun("stale-a", "2026-08-17T12:00:00.000Z"),
        activeRun("child-a", "2026-08-17T12:09:00.000Z", "stale-a"),
        activeRun("stale-b", "2026-08-17T12:00:00.000Z"),
      ],
    });
    /** Test fixture for coordinator. */
    const coordinator = new AgentCoordinator(
      provider,
      () => new Date("2026-08-17T12:10:00.000Z"),
    );
    /** Test fixture for run mutex. */
    const runMutex = (runId: string) =>
      new SingleHostMutex(
        { environmentId: "environment", runId, scope: "command" },
        root,
      );
    /** Test fixture for release child. */
    const releaseChild = await runMutex("child-a").lock({ reclaimable: false });
    try {
      /** Test fixture for result. */
      const result = await sweepWithRunLeases(
        new SingleHostMutex(
          { environmentId: "environment", scope: "environment" },
          root,
        ),
        runMutex,
        coordinator,
      );
      assert.deepEqual(result.blockedRunIds, ["stale-a"]);
      assert.deepEqual(
        result.swept.map((entry) => entry.run.runId),
        ["stale-b"],
      );
      assert.equal(
        (await provider.getActiveAgent("stale-a"))?.status,
        "running",
      );
      /** Test fixture for release root. */
      const releaseRoot = await runMutex("stale-a").lock();
      await releaseRoot();
    } finally {
      await releaseChild();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("sweep attempts every run-lease release and preserves the first cleanup failure", async () => {
  /** Order in which release callbacks are invoked. */
  const releaseOrder: string[] = [];
  /** Operation failure that cleanup must continue to override. */
  const operationFailure = new Error("sweep failed");
  /** First cleanup failure encountered in reverse release order. */
  const firstCleanupFailure = new Error("release c failed");
  /** Later cleanup failure that must not replace the first. */
  const laterCleanupFailure = new Error("release b failed");
  /** Minimal global mutex that executes the protected callback directly. */
  const globalMutex = {
    run: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
  } as unknown as SingleHostMutex;
  /** Per-run mutexes that expose deterministic failing release callbacks. */
  const runMutex = (runId: string) =>
    ({
      lock: async () => async () => {
        releaseOrder.push(runId);
        if (runId === "c") throw firstCleanupFailure;
        if (runId === "b") throw laterCleanupFailure;
      },
    }) as unknown as SingleHostMutex;
  /** Coordinator fixture that fails only after all leases are acquired. */
  const coordinator = {
    planSweep: async () => [{ rootRunId: "root", runIds: ["a", "b", "c"] }],
    sweep: async () => {
      throw operationFailure;
    },
  } as unknown as AgentCoordinator;

  await assert.rejects(
    sweepWithRunLeases(globalMutex, runMutex, coordinator),
    (error) => error === firstCleanupFailure,
  );
  assert.deepEqual(releaseOrder, ["c", "b", "a"]);
});
