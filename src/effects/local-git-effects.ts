// Implements hook-safe, environment-bound local Git and isolated workspace effects.
import { lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

import { sha256 } from "../core/digest.js";
import type { ExternalEffectControl, ExternalEffectObservation } from "./contracts.js";
import { createEffectObservation } from "./observations.js";
import { runBoundedChildProcess } from "./bounded-child-process.js";
import type { WorkspaceOwnershipStore } from "./workspace-ownership-store.js";
import type { GitBranchPayload, GitCommitPayload, GitObservePayload, GitPushPayload, ReconcilableEffectAdapter, WorkspaceProvisionPayload, WorkspaceReleasePayload } from "./typed-effect-handlers.js";

export interface LocalRepositoryConfig {
  readonly id: string;
  readonly remotes: readonly string[];
  readonly root: string;
}
export interface LocalGitIdentity { readonly email: string; readonly name: string; }
export interface GitExecutableConfig { readonly path: string; readonly sha256: string; readonly version: string; }
export interface LocalGitEffectConfig {
  readonly executable: GitExecutableConfig;
  readonly hooksDirectory: string;
  readonly identity: LocalGitIdentity;
  readonly repositories: readonly LocalRepositoryConfig[];
  readonly runtimeRoot: string;
}
export interface GitCommandResult { readonly exitCode: number; readonly stderr: string; readonly stdout: string; }
export interface GitCommandExecutor {
  run(input: { readonly args: readonly string[]; readonly cwd: string; readonly deadlineAt: number; readonly environment: Readonly<Record<string, string>>; readonly signal: AbortSignal }): Promise<GitCommandResult>;
}
export interface GitCredentialBroker { environment(repositoryId: string, remote: string): Promise<Readonly<Record<string, string>>>; }

export class NodeGitCommandExecutor implements GitCommandExecutor {
  public constructor(private readonly executable: string, private readonly timeoutMilliseconds = 120_000, private readonly outputLimitBytes = 2_000_000) {}
  public async run(input: { readonly args: readonly string[]; readonly cwd: string; readonly deadlineAt: number; readonly environment: Readonly<Record<string, string>>; readonly signal: AbortSignal }): Promise<GitCommandResult> {
    const result = await runBoundedChildProcess({ arguments: input.args, cwd: input.cwd, deadlineAt: Math.min(input.deadlineAt, Date.now() + this.timeoutMilliseconds), environment: input.environment, executablePath: this.executable, outputLimitBytes: this.outputLimitBytes, signal: input.signal });
    return { exitCode: result.exitCode, stderr: Buffer.from(result.stderr).toString("utf8"), stdout: Buffer.from(result.stdout).toString("utf8") };
  }
}

export class LocalGitEffects {
  readonly #effectControl = new AsyncLocalStorage<ExternalEffectControl>();
  readonly #repositories: ReadonlyMap<string, LocalRepositoryConfig>;
  readonly #runtimeRoot: string;
  readonly #workspacesRoot: string;

  private constructor(
    private readonly config: LocalGitEffectConfig,
    private readonly executor: GitCommandExecutor,
    private readonly credentials: GitCredentialBroker,
    private readonly ownership: WorkspaceOwnershipStore,
  ) {
    this.#runtimeRoot = canonicalRoot(config.runtimeRoot, "runtimeRoot");
    this.#workspacesRoot = join(this.#runtimeRoot, "workspaces");
    this.#repositories = new Map(config.repositories.map((repository) => [repository.id, { ...repository, root: canonicalRoot(repository.root, `repository ${repository.id}`) }]));
  }

  public static async create(config: LocalGitEffectConfig, options: { readonly credentials?: GitCredentialBroker; readonly executor?: GitCommandExecutor; readonly ownership: WorkspaceOwnershipStore }): Promise<LocalGitEffects> {
    validateConfig(config);
    const executor = options.executor ?? new NodeGitCommandExecutor(config.executable.path);
    const instance = new LocalGitEffects(config, executor, options.credentials ?? { async environment() { return {}; } }, options.ownership);
    await instance.verifyBoundary();
    return instance;
  }

  public workspaceProvisionAdapter(): ReconcilableEffectAdapter<WorkspaceProvisionPayload> { return this.adapter("local-git-workspace", (input) => this.applyWorkspace(input.effectId, input.payload), (input) => this.reconcileWorkspace(input.effectId, input.payload)); }
  public workspaceReleaseAdapter(): ReconcilableEffectAdapter<WorkspaceReleasePayload> { return this.adapter("local-git-workspace", (input) => this.applyRelease(input.effectId, input.payload), (input) => this.reconcileRelease(input.effectId, input.payload)); }
  public gitObserveAdapter(): ReconcilableEffectAdapter<GitObservePayload> { return this.adapter("local-git", (input) => this.observeRevision(input.payload), (input) => this.observeRevision(input.payload)); }
  public gitBranchAdapter(): ReconcilableEffectAdapter<GitBranchPayload> { return this.adapter("local-git", (input) => this.applyBranch(input.payload), (input) => this.reconcileBranch(input.payload)); }
  public gitCommitAdapter(): ReconcilableEffectAdapter<GitCommitPayload> { return this.adapter("local-git", (input) => this.applyCommit(input.payload), (input) => this.reconcileCommit(input.payload)); }
  public gitPushAdapter(): ReconcilableEffectAdapter<GitPushPayload> { return this.adapter("local-git", (input) => this.applyPush(input.payload), (input) => this.reconcilePush(input.payload)); }
  public async locate(workspaceKey: string, repositoryId: string): Promise<string> { const destination = this.workspacePath(workspaceKey); await this.assertWorkspaceRepository(destination, repositoryId); return destination; }

  private adapter<T>(id: string, apply: (input: { readonly control: ExternalEffectControl; readonly effectId: string; readonly payload: T }) => Promise<ExternalEffectObservation>, reconcile: (input: { readonly control: ExternalEffectControl; readonly effectId: string; readonly payload: T }) => Promise<ExternalEffectObservation>): ReconcilableEffectAdapter<T> {
    return { id, version: "1", apply: (input) => this.#effectControl.run(input.control, () => apply(input)), reconcile: (input) => this.#effectControl.run(input.control, () => reconcile(input)) };
  }

  private async verifyBoundary(): Promise<void> {
    const executablePath = await ordinaryRealPath(this.config.executable.path, "Git executable");
    if (sha256(await readFile(executablePath)) !== this.config.executable.sha256) throw new Error("Git executable digest does not match configuration");
    await emptyOrdinaryDirectory(this.config.hooksDirectory, "Git hooks directory");
    await mkdir(this.#workspacesRoot, { recursive: true });
    await ordinaryRealPath(this.#workspacesRoot, "Git workspaces root");
    for (const repository of this.#repositories.values()) await ordinaryRealPath(repository.root, `Repository ${repository.id}`);
    const version = await this.git(this.#runtimeRoot, ["--version"]);
    if (version.stdout.trim() !== this.config.executable.version) throw new Error("Git executable version does not match configuration");
  }

  private async reconcileWorkspace(effectId: string, payload: WorkspaceProvisionPayload): Promise<ExternalEffectObservation> {
    const destination = this.workspacePath(payload.workspaceKey);
    const owned = await this.verifyOwner(payload.repositoryId, payload.workspaceKey, payload.mode, effectId);
    if (!await exists(destination)) return owned || await this.registeredWorktree(this.repository(payload.repositoryId), destination) ? notApplied({ destinationKey: payload.workspaceKey, partial: true }) : notApplied({ destinationKey: payload.workspaceKey });
    const repository = this.repository(payload.repositoryId);
    const head = await this.gitOutput(destination, ["rev-parse", "HEAD"], true);
    if (head === null) return owned ? notApplied({ destinationKey: payload.workspaceKey, partial: true }) : indeterminate({ destinationKey: payload.workspaceKey, reason: "not_git_workspace" });
    const owner = await this.workspaceRepository(destination);
    if (owner?.id !== repository.id || owner.mode !== payload.mode) return indeterminate({ destinationKey: payload.workspaceKey, reason: "workspace_identity_mismatch" });
    const actual = head.trim();
    return actual === payload.sourceRevision
      ? applied({ head: actual, mode: payload.mode, repositoryId: payload.repositoryId, workspaceKey: payload.workspaceKey }, { destination: destination })
      : indeterminate({ actualHead: actual, destinationKey: payload.workspaceKey, expectedHead: payload.sourceRevision });
  }

  private async applyWorkspace(effectId: string, payload: WorkspaceProvisionPayload): Promise<ExternalEffectObservation> {
    const prior = await this.reconcileWorkspace(effectId, payload); if (prior.state !== "not_applied") return prior;
    const repository = this.repository(payload.repositoryId); const destination = this.workspacePath(payload.workspaceKey);
    await mkdir(this.#workspacesRoot, { recursive: true });
    await this.ownership.claim({ mode: payload.mode, provisionEffectId: effectId, repositoryId: payload.repositoryId, workspaceKey: payload.workspaceKey });
    if (await this.registeredWorktree(repository, destination)) { await this.git(repository.root, ["worktree", "remove", "--force", destination]); await this.gitRequired(repository.root, ["worktree", "prune", "--expire", "now"]); }
    if (await exists(destination)) await rm(destination, { force: true, recursive: true });
    const args = payload.mode === "worktree"
      ? ["worktree", "add", "--detach", destination, payload.sourceRevision]
      : ["clone", "--no-checkout", "--no-hardlinks", repository.root, destination];
    await this.gitRequired(repository.root, args);
    if (payload.mode === "mirror") await this.gitRequired(destination, ["checkout", "--detach", payload.sourceRevision]);
    return this.reconcileWorkspace(effectId, payload);
  }

  private async reconcileRelease(effectId: string, payload: WorkspaceReleasePayload): Promise<ExternalEffectObservation> {
    const destination = this.workspacePath(payload.workspaceKey);
    const registered = await this.registeredWorktree(this.repository(payload.repositoryId), destination); const owned = await this.verifyOwner(payload.repositoryId, payload.workspaceKey);
    if (!await exists(destination) && !registered && !owned) return applied({ repositoryId: payload.repositoryId, workspaceKey: payload.workspaceKey }, { absent: true });
    if (!owned) return indeterminate({ destinationKey: payload.workspaceKey, reason: "ownership_unverified" });
    if (!await exists(destination)) return notApplied({ destinationKey: payload.workspaceKey, staleRegistration: registered });
    await this.assertWorkspaceRepository(destination, payload.repositoryId);
    return notApplied({ destinationKey: payload.workspaceKey });
  }
  private async applyRelease(effectId: string, payload: WorkspaceReleasePayload): Promise<ExternalEffectObservation> {
    const destination = this.workspacePath(payload.workspaceKey);
    if (!await this.verifyOwner(payload.repositoryId, payload.workspaceKey)) return indeterminate({ destinationKey: payload.workspaceKey, reason: "ownership_unverified" });
    const repository = this.repository(payload.repositoryId); const owner = await exists(destination) ? await this.workspaceRepository(destination) : null;
    if (owner?.mode === "worktree" || await this.registeredWorktree(repository, destination)) { await this.git(repository.root, ["worktree", "remove", "--force", destination]); await this.gitRequired(repository.root, ["worktree", "prune", "--expire", "now"]); }
    if (await exists(destination)) await rm(destination, { force: true, recursive: true });
    await this.ownership.release({ releaseEffectId: effectId, repositoryId: payload.repositoryId, workspaceKey: payload.workspaceKey });
    return this.reconcileRelease(effectId, payload);
  }

  private async observeRevision(payload: GitObservePayload): Promise<ExternalEffectObservation> {
    this.repository(payload.repositoryId); const workspace = this.workspacePath(payload.workspaceKey); await this.assertWorkspaceRepository(workspace, payload.repositoryId);
    const resolved = await this.gitOutput(workspace, ["rev-parse", `${payload.revision}^{commit}`], true);
    return resolved === null ? notApplied({ revision: payload.revision }) : applied({ commit: resolved.trim(), repositoryId: payload.repositoryId }, { exists: true });
  }

  private async reconcileBranch(payload: GitBranchPayload): Promise<ExternalEffectObservation> {
    this.repository(payload.repositoryId); const workspace = this.workspacePath(payload.workspaceKey); await this.assertWorkspaceRepository(workspace, payload.repositoryId);
    const value = await this.gitOutput(workspace, ["show-ref", "--verify", "--hash", `refs/heads/${payload.branch}`], true);
    if (value === null) return notApplied({ branch: payload.branch });
    return value.trim() === payload.expectedHead ? applied({ branch: payload.branch, head: value.trim() }, { verified: true }) : indeterminate({ actualHead: value.trim(), branch: payload.branch, expectedHead: payload.expectedHead });
  }
  private async applyBranch(payload: GitBranchPayload): Promise<ExternalEffectObservation> {
    const prior = await this.reconcileBranch(payload); if (prior.state !== "not_applied") return prior;
    const workspace = this.workspacePath(payload.workspaceKey); await this.assertWorkspaceRepository(workspace, payload.repositoryId); await this.gitRequired(workspace, ["update-ref", `refs/heads/${payload.branch}`, payload.expectedHead, "0".repeat(40)]); return this.reconcileBranch(payload);
  }

  private async reconcileCommit(payload: GitCommitPayload): Promise<ExternalEffectObservation> {
    this.repository(payload.repositoryId); const workspace = this.workspacePath(payload.workspaceKey); await this.assertWorkspaceRepository(workspace, payload.repositoryId);
    const head = (await this.gitRequired(workspace, ["rev-parse", "HEAD"])).stdout.trim();
    if (head === payload.expectedHead) return notApplied({ head });
    const parent = (await this.gitRequired(workspace, ["rev-parse", `${head}^`])).stdout.trim();
    const message = (await this.gitRequired(workspace, ["show", "-s", "--format=%B", head])).stdout.trimEnd();
    const paths = lines((await this.gitRequired(workspace, ["diff-tree", "--no-commit-id", "--name-only", "-r", head])).stdout);
    return parent === payload.expectedHead && message === payload.message.trimEnd() && sameStrings(paths, payload.paths)
      ? applied({ commit: head, parent }, { paths })
      : indeterminate({ actualHead: head, expectedHead: payload.expectedHead, reason: "unexpected_commit" });
  }
  private async applyCommit(payload: GitCommitPayload): Promise<ExternalEffectObservation> {
    const prior = await this.reconcileCommit(payload); if (prior.state !== "not_applied") return prior;
    const workspace = this.workspacePath(payload.workspaceKey); await this.assertWorkspaceRepository(workspace, payload.repositoryId);
    const changed = await this.changedPaths(workspace); if (!sameStrings(changed, payload.paths)) return indeterminate({ actualPaths: changed, expectedPaths: payload.paths as string[], reason: "changed_path_mismatch" });
    await this.gitRequired(workspace, ["add", "--", ...payload.paths]);
    await this.gitRequired(workspace, ["-c", `user.name=${this.config.identity.name}`, "-c", `user.email=${this.config.identity.email}`, "-c", "commit.gpgSign=false", "commit", "--no-verify", "-m", payload.message]);
    return this.reconcileCommit(payload);
  }

  private async reconcilePush(payload: GitPushPayload): Promise<ExternalEffectObservation> {
    const repository = this.repository(payload.repositoryId); if (!repository.remotes.includes(payload.remote)) throw new Error(`Git remote is not authorized: ${payload.remote}`);
    const workspace = this.workspacePath(payload.workspaceKey); await this.assertWorkspaceRepository(workspace, payload.repositoryId); const local = (await this.gitRequired(workspace, ["rev-parse", "HEAD"])).stdout.trim();
    if (local !== payload.expectedLocalHead) return indeterminate({ actualLocalHead: local, expectedLocalHead: payload.expectedLocalHead });
    const remote = await this.remoteHead(workspace, payload);
    if (remote === payload.expectedLocalHead) return applied({ branch: payload.branch, head: remote, remote: payload.remote }, { verified: true });
    if (remote === payload.expectedRemoteHead) return notApplied({ remoteHead: remote });
    return indeterminate({ actualRemoteHead: remote, expectedRemoteHead: payload.expectedRemoteHead });
  }
  private async applyPush(payload: GitPushPayload): Promise<ExternalEffectObservation> {
    const prior = await this.reconcilePush(payload); if (prior.state !== "not_applied") return prior;
    const workspace = this.workspacePath(payload.workspaceKey); const credentialEnvironment = await this.credentials.environment(payload.repositoryId, payload.remote);
    validateCredentialEnvironment(credentialEnvironment);
    const lease = payload.expectedRemoteHead ?? "";
    await this.gitRequired(workspace, ["push", `--force-with-lease=refs/heads/${payload.branch}:${lease}`, payload.remote, `${payload.expectedLocalHead}:refs/heads/${payload.branch}`], credentialEnvironment);
    return this.reconcilePush(payload);
  }

  private async remoteHead(workspace: string, payload: GitPushPayload): Promise<string | null> {
    const credentials = await this.credentials.environment(payload.repositoryId, payload.remote); validateCredentialEnvironment(credentials);
    const result = await this.git(workspace, ["ls-remote", "--heads", payload.remote, `refs/heads/${payload.branch}`], credentials);
    if (result.exitCode !== 0) throw new Error("Git remote observation failed");
    const first = result.stdout.trim().split(/\s+/u)[0]; return first === undefined || first === "" ? null : first;
  }

  private async changedPaths(workspace: string): Promise<readonly string[]> {
    const tracked = lines((await this.gitRequired(workspace, ["diff", "--name-only", "HEAD"])).stdout);
    const untracked = lines((await this.gitRequired(workspace, ["ls-files", "--others", "--exclude-standard"])).stdout);
    return [...new Set([...tracked, ...untracked])].sort();
  }
  private async workspaceRepository(destination: string): Promise<{ readonly id: string; readonly mode: WorkspaceProvisionPayload["mode"]; readonly repository: LocalRepositoryConfig } | null> {
    const common = await this.gitOutput(destination, ["rev-parse", "--git-common-dir"], true);
    if (common === null) return null;
    const commonPath = resolve(destination, common.trim());
    const worktree = [...this.#repositories.values()].find((candidate) => samePath(commonPath, join(candidate.root, ".git")));
    if (worktree !== undefined) return { id: worktree.id, mode: "worktree", repository: worktree };
    if (!samePath(commonPath, join(destination, ".git"))) return null;
    const origin = await this.gitOutput(destination, ["remote", "get-url", "origin"], true);
    if (origin === null) return null;
    const mirror = [...this.#repositories.values()].find((candidate) => samePath(origin.trim(), candidate.root));
    return mirror === undefined ? null : { id: mirror.id, mode: "mirror", repository: mirror };
  }
  private async assertWorkspaceRepository(destination: string, repositoryId: string): Promise<void> { const owner = await this.workspaceRepository(destination); if (owner?.id !== repositoryId) throw new Error(`Workspace does not belong to repository ${repositoryId}`); }
  private async verifyOwner(repositoryId: string, workspaceKey: string, mode?: WorkspaceProvisionPayload["mode"], provisionEffectId?: string): Promise<boolean> { const owner = await this.ownership.get(workspaceKey); return owner?.state === "active" && owner.repositoryId === repositoryId && (mode === undefined || owner.mode === mode) && (provisionEffectId === undefined || owner.provisionEffectId === provisionEffectId); }
  private async registeredWorktree(repository: LocalRepositoryConfig, destination: string): Promise<boolean> { const output = await this.gitOutput(repository.root, ["worktree", "list", "--porcelain"], true); return output !== null && output.split(/\r?\n/u).some((line) => line.startsWith("worktree ") && samePath(line.slice(9), destination)); }
  private repository(id: string): LocalRepositoryConfig { const found = this.#repositories.get(id); if (found === undefined) throw new Error(`Repository is not configured: ${id}`); return found; }
  private workspacePath(key: string): string { const destination = join(this.#workspacesRoot, sha256(key)); if (!contains(this.#workspacesRoot, destination)) throw new Error("Workspace escaped its configured root"); return destination; }
  private async gitOutput(cwd: string, args: readonly string[], allowFailure = false): Promise<string | null> { const result = await this.git(cwd, args); if (result.exitCode !== 0) { if (allowFailure) return null; throw new Error("Git command failed"); } return result.stdout; }
  private async gitRequired(cwd: string, args: readonly string[], extraEnvironment: Readonly<Record<string, string>> = {}): Promise<GitCommandResult> { const result = await this.git(cwd, args, extraEnvironment); if (result.exitCode !== 0) throw new Error(`Git command failed with exit code ${result.exitCode}`); return result; }
  private async git(cwd: string, args: readonly string[], extraEnvironment: Readonly<Record<string, string>> = {}): Promise<GitCommandResult> {
    const environment: Record<string, string> = {
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
      HOME: this.#runtimeRoot, LANG: "C", LC_ALL: "C", PATH: parse(this.config.executable.path).dir,
      ...extraEnvironment,
    };
    const safeArgs = ["-c", `core.hooksPath=${this.config.hooksDirectory}`, "-c", "core.fsmonitor=false", "-c", "credential.helper=", ...args];
    const control = this.#effectControl.getStore() ?? { deadlineAt: Date.now() + 120_000, signal: new AbortController().signal };
    if (control.signal.aborted || control.deadlineAt <= Date.now()) throw new Error("Git effect was cancelled");
    return this.executor.run({ args: safeArgs, cwd, deadlineAt: control.deadlineAt, environment, signal: control.signal });
  }
}

function validateConfig(config: LocalGitEffectConfig): void {
  canonicalRoot(config.runtimeRoot, "runtimeRoot"); canonicalRoot(config.hooksDirectory, "hooksDirectory");
  if (!isAbsolute(config.executable.path) || !/^[a-f0-9]{64}$/u.test(config.executable.sha256) || config.executable.version === "") throw new TypeError("Pinned Git executable configuration is invalid");
  if (config.identity.name === "" || config.identity.email === "" || /[\r\n]/u.test(config.identity.name + config.identity.email)) throw new TypeError("Git identity is invalid");
  if (config.repositories.length === 0 || new Set(config.repositories.map((repository) => repository.id)).size !== config.repositories.length) throw new TypeError("Configured repositories must be non-empty and unique");
  for (const repository of config.repositories) { if (repository.id === "" || repository.remotes.some((remote) => remote === "") || new Set(repository.remotes).size !== repository.remotes.length) throw new TypeError("Repository configuration is invalid"); canonicalRoot(repository.root, `repository ${repository.id}`); }
}
function validateCredentialEnvironment(value: Readonly<Record<string, string>>): void { const reserved = /^(?:GIT_CONFIG.*|GIT_DIR|GIT_EXEC_PATH|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_OPTIONAL_LOCKS|GIT_SSH|GIT_SSH_COMMAND|GIT_TERMINAL_PROMPT|GIT_WORK_TREE|HOME|LANG|LC_ALL|PATH)$/iu; for (const [name, secret] of Object.entries(value)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || reserved.test(name) || secret === "" || /[\r\n\0]/u.test(secret)) throw new TypeError("Git credential environment is invalid"); }
function canonicalRoot(value: string, label: string): string { if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`); const result = resolve(value); if (result === parse(result).root) throw new TypeError(`${label} cannot be a filesystem root`); return result; }
async function ordinaryRealPath(value: string, label: string): Promise<string> { const info = await lstat(value); if (info.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link`); return realpath(value); }
async function emptyOrdinaryDirectory(value: string, label: string): Promise<void> { const info = await stat(value); if (!info.isDirectory()) throw new Error(`${label} must be a directory`); await ordinaryRealPath(value, label); if ((await readdir(value)).length !== 0) throw new Error(`${label} must be empty`); }
async function exists(value: string): Promise<boolean> { try { await lstat(value); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function contains(parent: string, child: string): boolean { const found = relative(parent, child); return found === "" || found !== ".." && !found.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(found); }
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right); }
function lines(value: string): readonly string[] { return value.split(/\r?\n/u).filter((line) => line !== "").sort(); }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return [...left].sort().join("\0") === [...right].sort().join("\0"); }
function applied(externalIdentity: Record<string, string>, evidence: Record<string, unknown>): ExternalEffectObservation { return createEffectObservation("applied", evidence, externalIdentity); }
function notApplied(evidence: Record<string, unknown>): ExternalEffectObservation { return createEffectObservation("not_applied", evidence); }
function indeterminate(evidence: Record<string, unknown>): ExternalEffectObservation { return createEffectObservation("indeterminate", evidence); }
