// Verifies trusted Git configuration, hook denial, and deterministic worktree commands.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalGitEffects, sha256, type GitCommandExecutor, type WorkspaceOwnershipRecord, type WorkspaceOwnershipStore } from "../src/index.js";

test("binds every Git call to empty hooks, closed config, and configured roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-git-"));
  const hooks = join(root, "hooks"); const repository = join(root, "repo"); const runtime = join(root, "runtime"); const executable = join(root, "git.exe");
  await Promise.all([mkdir(hooks), mkdir(repository), mkdir(runtime), writeFile(executable, "pinned")]);
  const calls: { args: readonly string[]; cwd: string; environment: Readonly<Record<string, string>> }[] = [];
  const executor: GitCommandExecutor = { async run(input) { calls.push(input); if (input.args.includes("--version")) return { exitCode: 0, stderr: "", stdout: "git version test" }; return { exitCode: 1, stderr: "absent", stdout: "" }; } };
  const owners = new Map<string, WorkspaceOwnershipRecord>();
  const ownership: WorkspaceOwnershipStore = {
    async claim(input) { const value: WorkspaceOwnershipRecord = { ...input, releaseEffectId: null, schema: "workspace-ownership-v1", state: "active" }; owners.set(input.workspaceKey, value); return value; },
    async get(key) { return owners.get(key) ?? null; },
    async release(input) { const current = owners.get(input.workspaceKey); if (current === undefined) throw new Error("Missing test owner"); const value: WorkspaceOwnershipRecord = { ...current, releaseEffectId: input.releaseEffectId, state: "released" }; owners.set(input.workspaceKey, value); return value; },
  };
  const effects = await LocalGitEffects.create({
    executable: { path: executable, sha256: sha256("pinned"), version: "git version test" }, hooksDirectory: hooks,
    identity: { email: "agent@example.invalid", name: "Agent Task Manager" }, repositories: [{ id: "repo", remotes: ["origin"], root: repository }], runtimeRoot: runtime,
  }, { executor, ownership });
  const observed = await effects.workspaceProvisionAdapter().reconcile({ control: { deadlineAt: Date.now() + 1000, signal: new AbortController().signal }, effectId: "a".repeat(64), payload: { mode: "worktree", repositoryId: "repo", sourceRevision: "b".repeat(40), workspaceKey: "task-1" } });
  assert.equal(observed.state, "not_applied");
  assert.equal(calls.every((call) => call.args.includes(`core.hooksPath=${hooks}`)), true);
  assert.equal(calls.every((call) => call.environment.GIT_CONFIG_NOSYSTEM === "1" && call.environment.GIT_OPTIONAL_LOCKS === "0"), true);
});
