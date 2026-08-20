/** Allocates and verifies isolated Git worktrees for configured Agent runs. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { WorktreeConfig } from "../config/environment.js";
import type { ActiveAgentRecord } from "../domain/records.js";

/** Persisted execution location and branch assigned to one run. */
export interface WorktreeBinding {
  readonly branch: string | null;
  readonly path: string;
}

/** Worktree capabilities consumed by the provider-neutral coordinator. */
export interface RunWorktreeAllocator {
  prepare(agentKey: string, runId: string): Promise<WorktreeBinding | null>;
  verify(agentKey: string, run: ActiveAgentRecord): Promise<void>;
}

/** Host command boundary used for deterministic Git tests. */
export type GitRunner = (
  workingDirectory: string,
  arguments_: readonly string[],
) => Promise<string>;

/** No-op allocator used when an environment has no worktree policy. */
export const NO_WORKTREES: RunWorktreeAllocator = {
  async prepare() {
    return null;
  },
  async verify(_agentKey, run) {
    if (run.branch !== null || run.worktreePath !== null)
      throw new Error("Run has an unexpected worktree binding");
  },
};

/** Creates unique linked worktrees and verifies replayed bindings fail closed. */
export class GitWorktreeAllocator implements RunWorktreeAllocator {
  readonly #requiredAgentKeys: ReadonlySet<string>;
  #roots: Promise<{
    readonly repository: string;
    readonly root: string;
  }> | null = null;

  public constructor(
    private readonly environmentId: string,
    private readonly config: WorktreeConfig,
    private readonly runGit: GitRunner = executeGit,
  ) {
    this.#requiredAgentKeys = new Set(config.requiredAgentKeys);
  }

  /** Creates a fresh branch and worktree for a configured Agent key. */
  public async prepare(
    agentKey: string,
    runId: string,
  ): Promise<WorktreeBinding | null> {
    const roots = await this.roots();
    if (!this.#requiredAgentKeys.has(agentKey))
      return { branch: null, path: roots.repository };
    const binding = this.binding(runId, roots.root);
    if (await exists(binding.path))
      throw new Error(`Worktree path already exists: ${binding.path}`);
    await this.runGit(roots.repository, [
      "worktree",
      "add",
      "-b",
      binding.branch,
      binding.path,
      this.config.baseRef,
    ]);
    await this.verifyBinding(binding, roots.repository);
    return binding;
  }

  /** Revalidates the exact persisted worktree before replay or command use. */
  public async verify(agentKey: string, run: ActiveAgentRecord): Promise<void> {
    if (!this.#requiredAgentKeys.has(agentKey)) {
      const roots = await this.roots();
      if (
        run.branch !== null ||
        run.worktreePath === null ||
        !samePath(run.worktreePath, roots.repository)
      )
        throw new Error(
          "Run repository binding does not match its configuration",
        );
      await this.verifyBinding(
        { branch: null, path: roots.repository },
        roots.repository,
      );
      return;
    }
    if (run.branch === null || run.worktreePath === null)
      throw new Error("Agent requires an isolated worktree");
    const roots = await this.roots();
    const expected = this.binding(run.runId, roots.root);
    if (
      !samePath(run.worktreePath, expected.path) ||
      run.branch !== expected.branch
    )
      throw new Error(
        "Run worktree binding does not match its configured identity",
      );
    await this.verifyBinding(expected, roots.repository);
  }

  private binding(
    runId: string,
    root: string,
  ): WorktreeBinding & { readonly branch: string } {
    const digest = createHash("sha256")
      .update(`${this.environmentId}\0${runId}`, "utf8")
      .digest("hex")
      .slice(0, 12);
    const label =
      runId
        .normalize("NFKD")
        .replace(/[^A-Za-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 32) || "run";
    const name = `${label}-${digest}`;
    return {
      branch: `${this.config.branchPrefix}${name}`,
      path: resolve(root, name),
    };
  }

  private async roots(): Promise<{
    readonly repository: string;
    readonly root: string;
  }> {
    this.#roots ??= this.initializeRoots();
    return this.#roots;
  }

  private async initializeRoots(): Promise<{
    readonly repository: string;
    readonly root: string;
  }> {
    await mkdir(this.config.root, { recursive: true });
    const [repository, root] = await Promise.all([
      realpath(this.config.repository),
      realpath(this.config.root),
    ]);
    if (pathsOverlap(repository, root))
      throw new Error("Worktree root and repository must not overlap");
    const observed = await this.runGit(repository, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (!samePath(resolve(repository, observed), repository))
      throw new Error("Configured repository must be its Git worktree root");
    return { repository, root };
  }

  private async verifyBinding(
    binding: WorktreeBinding,
    repository: string,
  ): Promise<void> {
    if (!(await stat(binding.path)).isDirectory())
      throw new Error(`Worktree is not a directory: ${binding.path}`);
    const [observedRoot, observedBranch, repositoryCommon, worktreeCommon] =
      await Promise.all([
        this.runGit(binding.path, ["rev-parse", "--show-toplevel"]),
        this.runGit(binding.path, ["branch", "--show-current"]),
        this.runGit(repository, ["rev-parse", "--git-common-dir"]),
        this.runGit(binding.path, ["rev-parse", "--git-common-dir"]),
      ]);
    if (!samePath(resolve(binding.path, observedRoot), binding.path))
      throw new Error("Allocated path is not the expected Git worktree root");
    if (binding.branch !== null && observedBranch !== binding.branch)
      throw new Error("Allocated worktree is on an unexpected branch");
    if (
      !samePath(
        resolve(repository, repositoryCommon),
        resolve(binding.path, worktreeCommon),
      )
    )
      throw new Error("Allocated worktree belongs to another repository");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string): boolean => {
    const value = relative(parent, child);
    return value === "" || (!value.startsWith("..") && !isAbsolute(value));
  };
  return contains(left, right) || contains(right, left);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left.trim());
  const normalizedRight = resolve(right.trim());
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function executeGit(
  workingDirectory: string,
  arguments_: readonly string[],
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      [...arguments_],
      {
        cwd: workingDirectory,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(`Git command failed: ${stderr.trim() || error.message}`, {
              cause: error,
            }),
          );
          return;
        }
        resolveOutput(stdout.trim());
      },
    );
  });
}
