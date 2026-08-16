/** Implements hook-safe, environment-bound local Git and isolated workspace effects. */
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

import { sha256 } from "../core/digest.js";
import type {
  ExternalEffectControl,
  ExternalEffectObservation,
} from "./contracts.js";
import { createEffectObservation } from "./observations.js";
import { runBoundedChildProcess } from "./bounded-child-process.js";
import type { WorkspaceOwnershipStore } from "./workspace-ownership-store.js";
import type {
  GitBranchPayload,
  GitCommitPayload,
  GitObservePayload,
  GitPushPayload,
  ReconcilableEffectAdapter,
  WorkspaceProvisionPayload,
  WorkspaceReleasePayload,
} from "./typed-effect-handlers.js";

/** Defines the data and behavior required by local repository config. */
export interface LocalRepositoryConfig {
  /** Provides id to local repository config. */
  readonly id: string;
  /** Lists the remotes accepted by this contract. */
  readonly remotes: readonly string[];
  /** Provides root to local repository config. */
  readonly root: string;
}
/** Defines the data and behavior required by local git identity. */
export interface LocalGitIdentity {
  /** Provides email to local git identity. */
  readonly email: string;
  /** Provides name to local git identity. */
  readonly name: string;
}
/** Defines the data and behavior required by git executable config. */
export interface GitExecutableConfig {
  /** Provides path to git executable config. */
  readonly path: string;
  /** Provides sha256 to git executable config. */
  readonly sha256: string;
  /** Records the version used for compatibility checks. */
  readonly version: string;
}
/** Defines the data and behavior required by local git effect config. */
export interface LocalGitEffectConfig {
  /** Provides executable to local git effect config. */
  readonly executable: GitExecutableConfig;
  /** Provides hooks directory to local git effect config. */
  readonly hooksDirectory: string;
  /** Provides identity to local git effect config. */
  readonly identity: LocalGitIdentity;
  /** Lists the repositories accepted by this contract. */
  readonly repositories: readonly LocalRepositoryConfig[];
  /** Provides runtime root to local git effect config. */
  readonly runtimeRoot: string;
}
/** Defines the data and behavior required by git command result. */
export interface GitCommandResult {
  /** Provides exit code to git command result. */
  readonly exitCode: number;
  /** Provides stderr to git command result. */
  readonly stderr: string;
  /** Provides stdout to git command result. */
  readonly stdout: string;
}
/** Defines the data and behavior required by git command executor. */
export interface GitCommandExecutor {
  /** Runs git command executor within its configured limits. */
  run(input: {
    /** Lists the args accepted by this contract. */
    readonly args: readonly string[];
    /** Provides cwd to git command executor. */
    readonly cwd: string;
    /** Records the canonical timestamp for deadline. */
    readonly deadlineAt: number;
    /** Provides environment to git command executor. */
    readonly environment: Readonly<Record<string, string>>;
    /** Provides signal to git command executor. */
    readonly signal: AbortSignal;
  }): Promise<GitCommandResult>;
}
/** Defines the data and behavior required by git credential broker. */
export interface GitCredentialBroker {
  /** Returns the configured environment or credentials for the requested boundary. */
  environment(
    repositoryId: string,
    remote: string,
  ): Promise<Readonly<Record<string, string>>>;
}

/** Implements node git command executor and its boundary checks. */
export class NodeGitCommandExecutor implements GitCommandExecutor {
  /** Creates node git command executor with its required collaborators. */
  public constructor(
    /** Provides executable to node git command executor. */ private readonly executable: string,
    /** Sets timeout in milliseconds. */ private readonly timeoutMilliseconds = 120_000,
    /** Sets output limit in bytes. */ private readonly outputLimitBytes = 2_000_000,
  ) {}
  /** Runs node git command executor within its configured limits. */
  public async run(input: {
    /** Lists the args accepted by this contract. */
    readonly args: readonly string[];
    /** Provides cwd to run. */
    readonly cwd: string;
    /** Records the canonical timestamp for deadline. */
    readonly deadlineAt: number;
    /** Provides environment to run. */
    readonly environment: Readonly<Record<string, string>>;
    /** Provides signal to run. */
    readonly signal: AbortSignal;
  }): Promise<GitCommandResult> {
    /** Holds the validated result returned by run. */
    const result = await runBoundedChildProcess({
      arguments: input.args,
      cwd: input.cwd,
      deadlineAt: Math.min(
        input.deadlineAt,
        Date.now() + this.timeoutMilliseconds,
      ),
      environment: input.environment,
      executablePath: this.executable,
      outputLimitBytes: this.outputLimitBytes,
      signal: input.signal,
    });
    return {
      exitCode: result.exitCode,
      stderr: Buffer.from(result.stderr).toString("utf8"),
      stdout: Buffer.from(result.stdout).toString("utf8"),
    };
  }
}

/** Implements local git effects and its boundary checks. */
export class LocalGitEffects {
  /** Provides effect control to local git effects. */
  readonly #effectControl = new AsyncLocalStorage<ExternalEffectControl>();
  /** Provides repositories to local git effects. */
  readonly #repositories: ReadonlyMap<string, LocalRepositoryConfig>;
  /** Provides runtime root to local git effects. */
  readonly #runtimeRoot: string;
  /** Provides workspaces root to local git effects. */
  readonly #workspacesRoot: string;

  /** Creates local git effects with its required collaborators. */
  private constructor(
    /** Provides config to local git effects. */ private readonly config: LocalGitEffectConfig,
    /** Provides executor to local git effects. */ private readonly executor: GitCommandExecutor,
    /** Provides credentials to local git effects. */ private readonly credentials: GitCredentialBroker,
    /** Provides ownership to local git effects. */ private readonly ownership: WorkspaceOwnershipStore,
  ) {
    this.#runtimeRoot = canonicalRoot(config.runtimeRoot, "runtimeRoot");
    this.#workspacesRoot = join(this.#runtimeRoot, "workspaces");
    this.#repositories = new Map(
      config.repositories.map((repository) => [
        repository.id,
        {
          ...repository,
          root: canonicalRoot(repository.root, `repository ${repository.id}`),
        },
      ]),
    );
  }

  /** Creates a local Git effect stack from validated host dependencies. */
  public static async create(
    config: LocalGitEffectConfig,
    options: {
      /** Provides credentials to create. */
      readonly credentials?: GitCredentialBroker;
      /** Provides executor to create. */
      readonly executor?: GitCommandExecutor;
      /** Provides ownership to create. */
      readonly ownership: WorkspaceOwnershipStore;
    },
  ): Promise<LocalGitEffects> {
    validateConfig(config);
    /** Stores executor used by create. */
    const executor =
      options.executor ?? new NodeGitCommandExecutor(config.executable.path);
    /** Stores instance used by create. */
    const instance = new LocalGitEffects(
      config,
      executor,
      options.credentials ?? {
        /** Returns the configured environment or credentials for the requested boundary. */
        async environment() {
          return {};
        },
      },
      options.ownership,
    );
    await instance.verifyBoundary();
    return instance;
  }

  /** Returns the typed adapter bound to this local Git effect. */
  public workspaceProvisionAdapter(): ReconcilableEffectAdapter<WorkspaceProvisionPayload> {
    return this.adapter(
      "local-git-workspace",
      (input) => this.applyWorkspace(input.effectId, input.payload),
      (input) => this.reconcileWorkspace(input.effectId, input.payload),
    );
  }
  /** Returns the typed adapter bound to this local Git effect. */
  public workspaceReleaseAdapter(): ReconcilableEffectAdapter<WorkspaceReleasePayload> {
    return this.adapter(
      "local-git-workspace",
      (input) => this.applyRelease(input.effectId, input.payload),
      (input) => this.reconcileRelease(input.effectId, input.payload),
    );
  }
  /** Returns the typed adapter bound to this local Git effect. */
  public gitObserveAdapter(): ReconcilableEffectAdapter<GitObservePayload> {
    return this.adapter(
      "local-git",
      (input) => this.observeRevision(input.payload),
      (input) => this.observeRevision(input.payload),
    );
  }
  /** Returns the typed adapter bound to this local Git effect. */
  public gitBranchAdapter(): ReconcilableEffectAdapter<GitBranchPayload> {
    return this.adapter(
      "local-git",
      (input) => this.applyBranch(input.payload),
      (input) => this.reconcileBranch(input.payload),
    );
  }
  /** Returns the typed adapter bound to this local Git effect. */
  public gitCommitAdapter(): ReconcilableEffectAdapter<GitCommitPayload> {
    return this.adapter(
      "local-git",
      (input) => this.applyCommit(input.payload),
      (input) => this.reconcileCommit(input.payload),
    );
  }
  /** Returns the typed adapter bound to this local Git effect. */
  public gitPushAdapter(): ReconcilableEffectAdapter<GitPushPayload> {
    return this.adapter(
      "local-git",
      (input) => this.applyPush(input.payload),
      (input) => this.reconcilePush(input.payload),
    );
  }
  /** Resolves an authorized workspace path for the repository. */
  public async locate(
    workspaceKey: string,
    repositoryId: string,
  ): Promise<string> {
    /** Resolves the deterministic destination before verifying repository ownership. */
    const destination = this.workspacePath(workspaceKey);
    await this.assertWorkspaceRepository(destination, repositoryId);
    return destination;
  }

  /** Wraps local Git callbacks with broker cancellation and observation validation. */
  private adapter<T>(
    id: string,
    apply: (input: {
      /** Defines the broker-owned cancellation and deadline boundary. */
      readonly control: ExternalEffectControl;
      /** Identifies effect. */
      readonly effectId: string;
      /** Contains the validated payload for this Git effect. */
      readonly payload: T;
    }) => Promise<ExternalEffectObservation>,
    reconcile: (input: {
      /** Defines the broker-owned cancellation and deadline boundary. */
      readonly control: ExternalEffectControl;
      /** Identifies effect. */
      readonly effectId: string;
      /** Contains the validated payload for this Git effect. */
      readonly payload: T;
    }) => Promise<ExternalEffectObservation>,
  ): ReconcilableEffectAdapter<T> {
    return {
      id,
      version: "1",
      apply: (input) =>
        this.#effectControl.run(input.control, () => apply(input)),
      reconcile: (input) =>
        this.#effectControl.run(input.control, () => reconcile(input)),
    };
  }

  /** Verifies boundary against authoritative state. */
  private async verifyBoundary(): Promise<void> {
    /** Stores executable path used by verify boundary. */
    const executablePath = await ordinaryRealPath(
      this.config.executable.path,
      "Git executable",
    );
    if (
      sha256(await readFile(executablePath)) !== this.config.executable.sha256
    )
      throw new Error("Git executable digest does not match configuration");
    await emptyOrdinaryDirectory(
      this.config.hooksDirectory,
      "Git hooks directory",
    );
    await mkdir(this.#workspacesRoot, { recursive: true });
    await ordinaryRealPath(this.#workspacesRoot, "Git workspaces root");
    for (const repository of this.#repositories.values())
      await ordinaryRealPath(repository.root, `Repository ${repository.id}`);
    /** Stores version used by verify boundary. */
    const version = await this.git(this.#runtimeRoot, ["--version"]);
    if (version.stdout.trim() !== this.config.executable.version)
      throw new Error("Git executable version does not match configuration");
  }

  /** Reconciles workspace from observed state without blind replay. */
  private async reconcileWorkspace(
    effectId: string,
    payload: WorkspaceProvisionPayload,
  ): Promise<ExternalEffectObservation> {
    /** Stores destination used by reconcile workspace. */
    const destination = this.workspacePath(payload.workspaceKey);
    /** Stores owned used by reconcile workspace. */
    const owned = await this.verifyOwner(
      payload.repositoryId,
      payload.workspaceKey,
      payload.mode,
      effectId,
    );
    if (!(await exists(destination)))
      return owned ||
        (await this.registeredWorktree(
          this.repository(payload.repositoryId),
          destination,
        ))
        ? notApplied({ destinationKey: payload.workspaceKey, partial: true })
        : notApplied({ destinationKey: payload.workspaceKey });
    /** Stores repository used by reconcile workspace. */
    const repository = this.repository(payload.repositoryId);
    /** Stores head used by reconcile workspace. */
    const head = await this.gitOutput(destination, ["rev-parse", "HEAD"], true);
    if (head === null)
      return owned
        ? notApplied({ destinationKey: payload.workspaceKey, partial: true })
        : indeterminate({
            destinationKey: payload.workspaceKey,
            reason: "not_git_workspace",
          });
    /** Stores owner used by reconcile workspace. */
    const owner = await this.workspaceRepository(destination);
    if (owner?.id !== repository.id || owner.mode !== payload.mode)
      return indeterminate({
        destinationKey: payload.workspaceKey,
        reason: "workspace_identity_mismatch",
      });
    /** Captures the observed actual for comparison. */
    const actual = head.trim();
    return actual === payload.sourceRevision
      ? applied(
          {
            head: actual,
            mode: payload.mode,
            repositoryId: payload.repositoryId,
            workspaceKey: payload.workspaceKey,
          },
          { destination: destination },
        )
      : indeterminate({
          actualHead: actual,
          destinationKey: payload.workspaceKey,
          expectedHead: payload.sourceRevision,
        });
  }

  /** Applies workspace under the caller's authority. */
  private async applyWorkspace(
    effectId: string,
    payload: WorkspaceProvisionPayload,
  ): Promise<ExternalEffectObservation> {
    /** Stores prior used by apply workspace. */
    const prior = await this.reconcileWorkspace(effectId, payload);
    if (prior.state !== "not_applied") return prior;
    /** Stores repository used by apply workspace. */
    const repository = this.repository(payload.repositoryId);
    /** Stores destination used by apply workspace. */
    const destination = this.workspacePath(payload.workspaceKey);
    await mkdir(this.#workspacesRoot, { recursive: true });
    await this.ownership.claim({
      mode: payload.mode,
      provisionEffectId: effectId,
      repositoryId: payload.repositoryId,
      workspaceKey: payload.workspaceKey,
    });
    if (await this.registeredWorktree(repository, destination)) {
      await this.git(repository.root, [
        "worktree",
        "remove",
        "--force",
        destination,
      ]);
      await this.gitRequired(repository.root, [
        "worktree",
        "prune",
        "--expire",
        "now",
      ]);
    }
    if (await exists(destination))
      await rm(destination, { force: true, recursive: true });
    /** Stores args used by apply workspace. */
    const args =
      payload.mode === "worktree"
        ? ["worktree", "add", "--detach", destination, payload.sourceRevision]
        : [
            "clone",
            "--no-checkout",
            "--no-hardlinks",
            repository.root,
            destination,
          ];
    await this.gitRequired(repository.root, args);
    if (payload.mode === "mirror")
      await this.gitRequired(destination, [
        "checkout",
        "--detach",
        payload.sourceRevision,
      ]);
    return this.reconcileWorkspace(effectId, payload);
  }

  /** Reconciles release from observed state without blind replay. */
  private async reconcileRelease(
    effectId: string,
    payload: WorkspaceReleasePayload,
  ): Promise<ExternalEffectObservation> {
    /** Stores destination used by reconcile release. */
    const destination = this.workspacePath(payload.workspaceKey);
    /** Stores registered used by reconcile release. */
    const registered = await this.registeredWorktree(
      this.repository(payload.repositoryId),
      destination,
    );
    /** Stores owned used by reconcile release. */
    const owned = await this.verifyOwner(
      payload.repositoryId,
      payload.workspaceKey,
    );
    if (!(await exists(destination)) && !registered && !owned)
      return applied(
        {
          repositoryId: payload.repositoryId,
          workspaceKey: payload.workspaceKey,
        },
        { absent: true },
      );
    if (!owned)
      return indeterminate({
        destinationKey: payload.workspaceKey,
        reason: "ownership_unverified",
      });
    if (!(await exists(destination)))
      return notApplied({
        destinationKey: payload.workspaceKey,
        staleRegistration: registered,
      });
    await this.assertWorkspaceRepository(destination, payload.repositoryId);
    return notApplied({ destinationKey: payload.workspaceKey });
  }
  /** Applies release under the caller's authority. */
  private async applyRelease(
    effectId: string,
    payload: WorkspaceReleasePayload,
  ): Promise<ExternalEffectObservation> {
    /** Stores destination used by apply release. */
    const destination = this.workspacePath(payload.workspaceKey);
    if (!(await this.verifyOwner(payload.repositoryId, payload.workspaceKey)))
      return indeterminate({
        destinationKey: payload.workspaceKey,
        reason: "ownership_unverified",
      });
    /** Stores repository used by apply release. */
    const repository = this.repository(payload.repositoryId);
    /** Stores owner used by apply release. */
    const owner = (await exists(destination))
      ? await this.workspaceRepository(destination)
      : null;
    if (
      owner?.mode === "worktree" ||
      (await this.registeredWorktree(repository, destination))
    ) {
      await this.git(repository.root, [
        "worktree",
        "remove",
        "--force",
        destination,
      ]);
      await this.gitRequired(repository.root, [
        "worktree",
        "prune",
        "--expire",
        "now",
      ]);
    }
    if (await exists(destination))
      await rm(destination, { force: true, recursive: true });
    await this.ownership.release({
      releaseEffectId: effectId,
      repositoryId: payload.repositoryId,
      workspaceKey: payload.workspaceKey,
    });
    return this.reconcileRelease(effectId, payload);
  }

  /** Reads the current workspace revision without mutation. */
  private async observeRevision(
    payload: GitObservePayload,
  ): Promise<ExternalEffectObservation> {
    this.repository(payload.repositoryId);
    /** Stores workspace used by observe revision. */
    const workspace = this.workspacePath(payload.workspaceKey);
    await this.assertWorkspaceRepository(workspace, payload.repositoryId);
    /** Stores resolved used by observe revision. */
    const resolved = await this.gitOutput(
      workspace,
      ["rev-parse", `${payload.revision}^{commit}`],
      true,
    );
    return resolved === null
      ? notApplied({ revision: payload.revision })
      : applied(
          { commit: resolved.trim(), repositoryId: payload.repositoryId },
          { exists: true },
        );
  }

  /** Reconciles branch from observed state without blind replay. */
  private async reconcileBranch(
    payload: GitBranchPayload,
  ): Promise<ExternalEffectObservation> {
    this.repository(payload.repositoryId);
    /** Stores workspace used by reconcile branch. */
    const workspace = this.workspacePath(payload.workspaceKey);
    await this.assertWorkspaceRepository(workspace, payload.repositoryId);
    /** Contains the branch observed during reconciliation. */
    const value = await this.gitOutput(
      workspace,
      ["show-ref", "--verify", "--hash", `refs/heads/${payload.branch}`],
      true,
    );
    if (value === null) return notApplied({ branch: payload.branch });
    return value.trim() === payload.expectedHead
      ? applied(
          { branch: payload.branch, head: value.trim() },
          { verified: true },
        )
      : indeterminate({
          actualHead: value.trim(),
          branch: payload.branch,
          expectedHead: payload.expectedHead,
        });
  }
  /** Applies branch under the caller's authority. */
  private async applyBranch(
    payload: GitBranchPayload,
  ): Promise<ExternalEffectObservation> {
    /** Stores prior used by apply branch. */
    const prior = await this.reconcileBranch(payload);
    if (prior.state !== "not_applied") return prior;
    /** Stores workspace used by apply branch. */
    const workspace = this.workspacePath(payload.workspaceKey);
    await this.assertWorkspaceRepository(workspace, payload.repositoryId);
    await this.gitRequired(workspace, [
      "update-ref",
      `refs/heads/${payload.branch}`,
      payload.expectedHead,
      "0".repeat(40),
    ]);
    return this.reconcileBranch(payload);
  }

  /** Reconciles commit from observed state without blind replay. */
  private async reconcileCommit(
    payload: GitCommitPayload,
  ): Promise<ExternalEffectObservation> {
    this.repository(payload.repositoryId);
    /** Stores workspace used by reconcile commit. */
    const workspace = this.workspacePath(payload.workspaceKey);
    await this.assertWorkspaceRepository(workspace, payload.repositoryId);
    /** Stores head used by reconcile commit. */
    const head = (
      await this.gitRequired(workspace, ["rev-parse", "HEAD"])
    ).stdout.trim();
    if (head === payload.expectedHead) return notApplied({ head });
    /** Stores parent used by reconcile commit. */
    const parent = (
      await this.gitRequired(workspace, ["rev-parse", `${head}^`])
    ).stdout.trim();
    /** Stores message used by reconcile commit. */
    const message = (
      await this.gitRequired(workspace, ["show", "-s", "--format=%B", head])
    ).stdout.trimEnd();
    /** Stores paths used by reconcile commit. */
    const paths = lines(
      (
        await this.gitRequired(workspace, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          head,
        ])
      ).stdout,
    );
    return parent === payload.expectedHead &&
      message === payload.message.trimEnd() &&
      sameStrings(paths, payload.paths)
      ? applied({ commit: head, parent }, { paths })
      : indeterminate({
          actualHead: head,
          expectedHead: payload.expectedHead,
          reason: "unexpected_commit",
        });
  }
  /** Applies commit under the caller's authority. */
  private async applyCommit(
    payload: GitCommitPayload,
  ): Promise<ExternalEffectObservation> {
    /** Stores prior used by apply commit. */
    const prior = await this.reconcileCommit(payload);
    if (prior.state !== "not_applied") return prior;
    /** Stores workspace used by apply commit. */
    const workspace = this.workspacePath(payload.workspaceKey);
    await this.assertWorkspaceRepository(workspace, payload.repositoryId);
    /** Stores changed used by apply commit. */
    const changed = await this.changedPaths(workspace);
    if (!sameStrings(changed, payload.paths))
      return indeterminate({
        actualPaths: changed,
        expectedPaths: payload.paths as string[],
        reason: "changed_path_mismatch",
      });
    await this.gitRequired(workspace, ["add", "--", ...payload.paths]);
    await this.gitRequired(workspace, [
      "-c",
      `user.name=${this.config.identity.name}`,
      "-c",
      `user.email=${this.config.identity.email}`,
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--no-verify",
      "-m",
      payload.message,
    ]);
    return this.reconcileCommit(payload);
  }

  /** Reconciles push from observed state without blind replay. */
  private async reconcilePush(
    payload: GitPushPayload,
  ): Promise<ExternalEffectObservation> {
    /** Stores repository used by reconcile push. */
    const repository = this.repository(payload.repositoryId);
    if (!repository.remotes.includes(payload.remote))
      throw new Error(`Git remote is not authorized: ${payload.remote}`);
    /** Stores workspace used by reconcile push. */
    const workspace = this.workspacePath(payload.workspaceKey);
    await this.assertWorkspaceRepository(workspace, payload.repositoryId);
    /** Contains the local revision compared with the remote. */
    const local = (
      await this.gitRequired(workspace, ["rev-parse", "HEAD"])
    ).stdout.trim();
    if (local !== payload.expectedLocalHead)
      return indeterminate({
        actualLocalHead: local,
        expectedLocalHead: payload.expectedLocalHead,
      });
    /** Stores remote used by reconcile push. */
    const remote = await this.remoteHead(workspace, payload);
    if (remote === payload.expectedLocalHead)
      return applied(
        { branch: payload.branch, head: remote, remote: payload.remote },
        { verified: true },
      );
    if (remote === payload.expectedRemoteHead)
      return notApplied({ remoteHead: remote });
    return indeterminate({
      actualRemoteHead: remote,
      expectedRemoteHead: payload.expectedRemoteHead,
    });
  }
  /** Applies push under the caller's authority. */
  private async applyPush(
    payload: GitPushPayload,
  ): Promise<ExternalEffectObservation> {
    /** Stores prior used by apply push. */
    const prior = await this.reconcilePush(payload);
    if (prior.state !== "not_applied") return prior;
    /** Stores workspace used by apply push. */
    const workspace = this.workspacePath(payload.workspaceKey);
    /** Stores credential environment used by apply push. */
    const credentialEnvironment = await this.credentials.environment(
      payload.repositoryId,
      payload.remote,
    );
    validateCredentialEnvironment(credentialEnvironment);
    /** Stores lease used by apply push. */
    const lease = payload.expectedRemoteHead ?? "";
    await this.gitRequired(
      workspace,
      [
        "push",
        `--force-with-lease=refs/heads/${payload.branch}:${lease}`,
        payload.remote,
        `${payload.expectedLocalHead}:refs/heads/${payload.branch}`,
      ],
      credentialEnvironment,
    );
    return this.reconcilePush(payload);
  }

  /** Reads the immutable revision currently advertised by the remote branch. */
  private async remoteHead(
    workspace: string,
    payload: GitPushPayload,
  ): Promise<string | null> {
    /** Stores credentials used by remote head. */
    const credentials = await this.credentials.environment(
      payload.repositoryId,
      payload.remote,
    );
    validateCredentialEnvironment(credentials);
    /** Holds the validated result returned by remote head. */
    const result = await this.git(
      workspace,
      ["ls-remote", "--heads", payload.remote, `refs/heads/${payload.branch}`],
      credentials,
    );
    if (result.exitCode !== 0) throw new Error("Git remote observation failed");
    /** Stores first used by remote head. */
    const first = result.stdout.trim().split(/\s+/u)[0];
    return first === undefined || first === "" ? null : first;
  }

  /** Returns tracked and untracked paths changed in the workspace. */
  private async changedPaths(workspace: string): Promise<readonly string[]> {
    /** Stores tracked used by changed paths. */
    const tracked = lines(
      (await this.gitRequired(workspace, ["diff", "--name-only", "HEAD"]))
        .stdout,
    );
    /** Stores untracked used by changed paths. */
    const untracked = lines(
      (
        await this.gitRequired(workspace, [
          "ls-files",
          "--others",
          "--exclude-standard",
        ])
      ).stdout,
    );
    return [...new Set([...tracked, ...untracked])].sort();
  }
  /** Validates workspace ownership, worktree metadata, origin, and mirror identity. */
  private async workspaceRepository(destination: string): Promise<{
    /** Provides id to workspace repository. */
    readonly id: string;
    /** Provides mode to workspace repository. */
    readonly mode: WorkspaceProvisionPayload["mode"];
    /** Provides repository to workspace repository. */
    readonly repository: LocalRepositoryConfig;
  } | null> {
    /** Stores common used by workspace repository. */
    const common = await this.gitOutput(
      destination,
      ["rev-parse", "--git-common-dir"],
      true,
    );
    if (common === null) return null;
    /** Stores common path used by workspace repository. */
    const commonPath = resolve(destination, common.trim());
    /** Stores worktree used by workspace repository. */
    const worktree = [...this.#repositories.values()].find((candidate) =>
      samePath(commonPath, join(candidate.root, ".git")),
    );
    if (worktree !== undefined)
      return { id: worktree.id, mode: "worktree", repository: worktree };
    if (!samePath(commonPath, join(destination, ".git"))) return null;
    /** Stores origin used by workspace repository. */
    const origin = await this.gitOutput(
      destination,
      ["remote", "get-url", "origin"],
      true,
    );
    if (origin === null) return null;
    /** Stores mirror used by workspace repository. */
    const mirror = [...this.#repositories.values()].find((candidate) =>
      samePath(origin.trim(), candidate.root),
    );
    return mirror === undefined
      ? null
      : { id: mirror.id, mode: "mirror", repository: mirror };
  }
  /** Rejects input that does not satisfy the workspace repository contract. */
  private async assertWorkspaceRepository(
    destination: string,
    repositoryId: string,
  ): Promise<void> {
    /** Stores owner used by assert workspace repository. */
    const owner = await this.workspaceRepository(destination);
    if (owner?.id !== repositoryId)
      throw new Error(
        `Workspace does not belong to repository ${repositoryId}`,
      );
  }
  /** Verifies owner against authoritative state. */
  private async verifyOwner(
    repositoryId: string,
    workspaceKey: string,
    mode?: WorkspaceProvisionPayload["mode"],
    provisionEffectId?: string,
  ): Promise<boolean> {
    /** Stores owner used by verify owner. */
    const owner = await this.ownership.get(workspaceKey);
    return (
      owner?.state === "active" &&
      owner.repositoryId === repositoryId &&
      (mode === undefined || owner.mode === mode) &&
      (provisionEffectId === undefined ||
        owner.provisionEffectId === provisionEffectId)
    );
  }
  /** Returns whether Git registers the workspace as a worktree. */
  private async registeredWorktree(
    repository: LocalRepositoryConfig,
    destination: string,
  ): Promise<boolean> {
    /** Stores output used by registered worktree. */
    const output = await this.gitOutput(
      repository.root,
      ["worktree", "list", "--porcelain"],
      true,
    );
    return (
      output !== null &&
      output
        .split(/\r?\n/u)
        .some(
          (line) =>
            line.startsWith("worktree ") &&
            samePath(line.slice(9), destination),
        )
    );
  }
  /** Returns configured repository metadata or throws when absent. */
  private repository(id: string): LocalRepositoryConfig {
    /** Holds the parsed value being validated by repository. */
    const found = this.#repositories.get(id);
    if (found === undefined)
      throw new Error(`Repository is not configured: ${id}`);
    return found;
  }
  /** Resolves and validates the owned workspace path. */
  private workspacePath(key: string): string {
    /** Stores destination used by workspace path. */
    const destination = join(this.#workspacesRoot, sha256(key));
    if (!contains(this.#workspacesRoot, destination))
      throw new Error("Workspace escaped its configured root");
    return destination;
  }
  /** Runs Git and returns trimmed output, optionally tolerating failure. */
  private async gitOutput(
    cwd: string,
    args: readonly string[],
    allowFailure = false,
  ): Promise<string | null> {
    /** Holds the validated result returned by git output. */
    const result = await this.git(cwd, args);
    if (result.exitCode !== 0) {
      if (allowFailure) return null;
      throw new Error("Git command failed");
    }
    return result.stdout;
  }
  /** Runs Git and throws when the command exits unsuccessfully. */
  private async gitRequired(
    cwd: string,
    args: readonly string[],
    extraEnvironment: Readonly<Record<string, string>> = {},
  ): Promise<GitCommandResult> {
    /** Holds the validated result returned by git required. */
    const result = await this.git(cwd, args, extraEnvironment);
    if (result.exitCode !== 0)
      throw new Error(`Git command failed with exit code ${result.exitCode}`);
    return result;
  }
  /** Runs a hook-safe Git command inside the trusted environment boundary. */
  private async git(
    cwd: string,
    args: readonly string[],
    extraEnvironment: Readonly<Record<string, string>> = {},
  ): Promise<GitCommandResult> {
    /** Stores environment used by git. */
    const environment: Record<string, string> = {
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      HOME: this.#runtimeRoot,
      LANG: "C",
      LC_ALL: "C",
      PATH: parse(this.config.executable.path).dir,
      ...extraEnvironment,
    };
    /** Stores safe args used by git. */
    const safeArgs = [
      "-c",
      `core.hooksPath=${this.config.hooksDirectory}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      ...args,
    ];
    /** Stores control used by git. */
    const control = this.#effectControl.getStore() ?? {
      deadlineAt: Date.now() + 120_000,
      signal: new AbortController().signal,
    };
    if (control.signal.aborted || control.deadlineAt <= Date.now())
      throw new Error("Git effect was cancelled");
    return this.executor.run({
      args: safeArgs,
      cwd,
      deadlineAt: control.deadlineAt,
      environment,
      signal: control.signal,
    });
  }
}

/** Rejects invalid config before it crosses the boundary. */
function validateConfig(config: LocalGitEffectConfig): void {
  canonicalRoot(config.runtimeRoot, "runtimeRoot");
  canonicalRoot(config.hooksDirectory, "hooksDirectory");
  if (
    !isAbsolute(config.executable.path) ||
    !/^[a-f0-9]{64}$/u.test(config.executable.sha256) ||
    config.executable.version === ""
  )
    throw new TypeError("Pinned Git executable configuration is invalid");
  if (
    config.identity.name === "" ||
    config.identity.email === "" ||
    /[\r\n]/u.test(config.identity.name + config.identity.email)
  )
    throw new TypeError("Git identity is invalid");
  if (
    config.repositories.length === 0 ||
    new Set(config.repositories.map((repository) => repository.id)).size !==
      config.repositories.length
  )
    throw new TypeError("Configured repositories must be non-empty and unique");
  for (const repository of config.repositories) {
    if (
      repository.id === "" ||
      repository.remotes.some((remote) => remote === "") ||
      new Set(repository.remotes).size !== repository.remotes.length
    )
      throw new TypeError("Repository configuration is invalid");
    canonicalRoot(repository.root, `repository ${repository.id}`);
  }
}
/** Rejects invalid credential environment before it crosses the boundary. */
function validateCredentialEnvironment(
  value: Readonly<Record<string, string>>,
): void {
  /** Stores reserved used by validate credential environment. */
  const reserved =
    /^(?:GIT_CONFIG.*|GIT_DIR|GIT_EXEC_PATH|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_OPTIONAL_LOCKS|GIT_SSH|GIT_SSH_COMMAND|GIT_TERMINAL_PROMPT|GIT_WORK_TREE|HOME|LANG|LC_ALL|PATH)$/iu;
  for (const [name, secret] of Object.entries(value))
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      reserved.test(name) ||
      secret === "" ||
      /[\r\n\0]/u.test(secret)
    )
      throw new TypeError("Git credential environment is invalid");
}
/** Resolves an absolute path while rejecting filesystem roots. */
function canonicalRoot(value: string, label: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
  /** Holds the validated result returned by canonical root. */
  const result = resolve(value);
  if (result === parse(result).root)
    throw new TypeError(`${label} cannot be a filesystem root`);
  return result;
}
/** Resolves a path and rejects symbolic links and non-directories. */
async function ordinaryRealPath(value: string, label: string): Promise<string> {
  /** Stores info used by ordinary real path. */
  const info = await lstat(value);
  if (info.isSymbolicLink())
    throw new Error(`${label} cannot be a symbolic link`);
  return realpath(value);
}
/** Requires an existing ordinary directory to be empty. */
async function emptyOrdinaryDirectory(
  value: string,
  label: string,
): Promise<void> {
  /** Stores info used by empty ordinary directory. */
  const info = await stat(value);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
  await ordinaryRealPath(value, label);
  if ((await readdir(value)).length !== 0)
    throw new Error(`${label} must be empty`);
}
/** Returns whether the filesystem path exists. */
async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Returns whether one canonical path contains another. */
function contains(parent: string, child: string): boolean {
  /** Holds the parsed value being validated by contains. */
  const found = relative(parent, child);
  return (
    found === "" ||
    (found !== ".." &&
      !found.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(found))
  );
}
/** Compares values without making ordering observable. */
function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}
/** Splits command output into trimmed non-empty lines. */
function lines(value: string): readonly string[] {
  return value
    .split(/\r?\n/u)
    .filter((line) => line !== "")
    .sort();
}
/** Compares values without making ordering observable. */
function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}
/** Creates the corresponding canonical external-effect observation. */
function applied(
  externalIdentity: Record<string, string>,
  evidence: Record<string, unknown>,
): ExternalEffectObservation {
  return createEffectObservation("applied", evidence, externalIdentity);
}
/** Creates the corresponding canonical external-effect observation. */
function notApplied(
  evidence: Record<string, unknown>,
): ExternalEffectObservation {
  return createEffectObservation("not_applied", evidence);
}
/** Creates the corresponding canonical external-effect observation. */
function indeterminate(
  evidence: Record<string, unknown>,
): ExternalEffectObservation {
  return createEffectObservation("indeterminate", evidence);
}
