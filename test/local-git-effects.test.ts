/** Verifies trusted Git configuration, hook denial, and deterministic worktree commands. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LocalGitEffects,
  sha256,
  type GitCommandExecutor,
  type WorkspaceOwnershipRecord,
  type WorkspaceOwnershipStore,
} from "../src/index.js";

test("binds every Git call to empty hooks, closed config, and configured roots", async () => {
  /** Provides the isolated filesystem root used by the scenario. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-git-"));
  /** Records process-tree termination callbacks. */
  const hooks = join(root, "hooks");
  /** Provides the temporary Git repository exercised by the test. */
  const repository = join(root, "repo");
  /** Provides the effect or dispatch runtime exercised by the scenario. */
  const runtime = join(root, "runtime");
  /** Selects the platform command used by the process test. */
  const executable = join(root, "git.exe");
  await Promise.all([
    mkdir(hooks),
    mkdir(repository),
    mkdir(runtime),
    writeFile(executable, "pinned"),
  ]);
  /** Records commands submitted to the fake executor. */
  const calls: {
    /** Records the exact Git arguments submitted by the adapter. */
    args: readonly string[];
    /** Records the repository root bound to the Git invocation. */
    cwd: string;
    /** Records the closed environment supplied to the Git process. */
    environment: Readonly<Record<string, string>>;
  }[] = [];
  /** Simulates command execution and records each invocation. */
  const executor: GitCommandExecutor = {
    /** Records each Git command and returns a successful result. */
    async run(input) {
      calls.push(input);
      if (input.args.includes("--version"))
        return { exitCode: 0, stderr: "", stdout: "git version test" };
      return { exitCode: 1, stderr: "absent", stdout: "" };
    },
  };
  /** Collects active workspace owners after reconciliation. */
  const owners = new Map<string, WorkspaceOwnershipRecord>();
  /** Captures the persisted workspace ownership record. */
  const ownership: WorkspaceOwnershipStore = {
    /** Returns the fixed workspace ownership claim. */
    async claim(input) {
      /** Captures the scalar value returned by the fake adapter. */
      const value: WorkspaceOwnershipRecord = {
        ...input,
        releaseEffectId: null,
        schema: "workspace-ownership-v1",
        state: "active",
      };
      owners.set(input.workspaceKey, value);
      return value;
    },
    /** Returns the requested test value. */
    async get(key) {
      return owners.get(key) ?? null;
    },
    /** Releases the simulated workspace ownership. */
    async release(input) {
      /** Tracks the mutable simulated clock or current record state. */
      const current = owners.get(input.workspaceKey);
      if (current === undefined) throw new Error("Missing test owner");
      /** Captures the scalar value returned by the fake adapter. */
      const value: WorkspaceOwnershipRecord = {
        ...current,
        releaseEffectId: input.releaseEffectId,
        state: "released",
      };
      owners.set(input.workspaceKey, value);
      return value;
    },
  };
  /** Runs the child-agent wave through the effect broker. */
  const effects = await LocalGitEffects.create(
    {
      executable: {
        path: executable,
        sha256: sha256("pinned"),
        version: "git version test",
      },
      hooksDirectory: hooks,
      identity: { email: "agent@example.invalid", name: "Agent Task Manager" },
      repositories: [{ id: "repo", remotes: ["origin"], root: repository }],
      runtimeRoot: runtime,
    },
    { executor, ownership },
  );
  /** Captures observed state used as the assertion oracle. */
  const observed = await effects.workspaceProvisionAdapter().reconcile({
    control: {
      deadlineAt: Date.now() + 1000,
      signal: new AbortController().signal,
    },
    effectId: "a".repeat(64),
    payload: {
      mode: "worktree",
      repositoryId: "repo",
      sourceRevision: "b".repeat(40),
      workspaceKey: "task-1",
    },
  });
  assert.equal(observed.state, "not_applied");
  assert.equal(
    calls.every((call) => call.args.includes(`core.hooksPath=${hooks}`)),
    true,
  );
  assert.equal(
    calls.every(
      (call) =>
        call.environment.GIT_CONFIG_NOSYSTEM === "1" &&
        call.environment.GIT_OPTIONAL_LOCKS === "0",
    ),
    true,
  );
});
