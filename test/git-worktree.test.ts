/** Git worktree allocation, isolation, and binding verification coverage. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitWorktreeAllocator } from "../src/core/git-worktree.js";
import type { ActiveAgentRecord } from "../src/domain/records.js";

test("configured Agents receive a fresh linked worktree per run", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "atm-worktree-"));
  const repository = join(temporaryRoot, "repository");
  const worktreeRoot = join(temporaryRoot, "worktrees");
  await mkdir(repository);
  try {
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.email", "atm@example.invalid"]);
    await git(repository, ["config", "user.name", "ATM Test"]);
    await writeFile(join(repository, "committed.txt"), "committed\n", "utf8");
    await git(repository, ["add", "committed.txt"]);
    await git(repository, ["commit", "-m", "test: seed repository"]);
    await writeFile(join(repository, "local-only.txt"), "local\n", "utf8");

    const allocator = new GitWorktreeAllocator("environment", {
      baseRef: "main",
      branchPrefix: "atm/",
      repository,
      requiredAgentKeys: ["coder"],
      root: worktreeRoot,
    });
    assert.deepEqual(await allocator.prepare("planner", "planner-run"), {
      branch: null,
      path: repository,
    });

    const first = await allocator.prepare("coder", "run-1");
    assert.notEqual(first, null);
    assert.equal(
      await readFile(join(first!.path, "committed.txt"), "utf8"),
      "committed\n",
    );
    await assert.rejects(readFile(join(first!.path, "local-only.txt"), "utf8"));
    assert.equal(
      await git(first!.path, ["branch", "--show-current"]),
      first!.branch,
    );

    const persisted: ActiveAgentRecord = {
      agentId: "agent",
      agentVersion: "1",
      archived: false,
      attempt: 1,
      branch: first!.branch,
      failureSummary: "",
      finishedAt: null,
      harnessId: "harness",
      id: "active",
      lastHeartbeat: "2026-08-20T00:00:00.000Z",
      outcome: "",
      parentRunId: null,
      restartOfRunId: null,
      retryKey: "run-1",
      runId: "run-1",
      startedAt: "2026-08-20T00:00:00.000Z",
      status: "running",
      taskId: "task",
      version: "1",
      worktreePath: first!.path,
    };
    await allocator.verify("coder", persisted);
    await assert.rejects(
      allocator.verify("coder", { ...persisted, branch: "atm/other" }),
      /does not match/u,
    );

    const second = await allocator.prepare("coder", "run-2");
    assert.notEqual(second, null);
    assert.notEqual(second!.path, first!.path);
    assert.notEqual(second!.branch, first!.branch);
    await assert.rejects(
      allocator.prepare("coder", "run-1"),
      /already exists/u,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

function git(
  workingDirectory: string,
  arguments_: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...arguments_],
      { cwd: workingDirectory, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message, { cause: error }));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}
