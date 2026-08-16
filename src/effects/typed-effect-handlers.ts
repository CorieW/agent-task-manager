/** Converts closed provider-defined effect payloads into trusted adapter calls. */
import type { JsonObject, JsonValue } from "../domain/json.js";
import type {
  ExternalEffectControl,
  ExternalEffectHandler,
  ExternalEffectObservation,
  ExternalEffectRequest,
} from "./contracts.js";

/** Stores external effect kinds used by the current operation. */
export const EXTERNAL_EFFECT_KINDS = [
  "browser.run",
  "child_agent.wave",
  "command.run",
  "git.branch",
  "git.commit",
  "git.observe",
  "git.push",
  "publication.draft_pr",
  "workspace.provision",
  "workspace.release",
] as const;
/** Defines the external effect kind data shape. */
export type ExternalEffectKind = (typeof EXTERNAL_EFFECT_KINDS)[number];

/** Defines the data and behavior required by workspace provision payload. */
export interface WorkspaceProvisionPayload {
  /** Provides mode to workspace provision payload. */
  readonly mode: "mirror" | "worktree";
  /** Identifies repository. */
  readonly repositoryId: string;
  /** Provides source revision to workspace provision payload. */
  readonly sourceRevision: string;
  /** Identifies workspace. */
  readonly workspaceKey: string;
}
/** Defines the data and behavior required by workspace release payload. */
export interface WorkspaceReleasePayload {
  /** Identifies repository. */
  readonly repositoryId: string;
  /** Identifies workspace. */
  readonly workspaceKey: string;
}
/** Defines the data and behavior required by git observe payload. */
export interface GitObservePayload {
  /** Identifies repository. */
  readonly repositoryId: string;
  /** Provides revision to git observe payload. */
  readonly revision: string;
  /** Identifies workspace. */
  readonly workspaceKey: string;
}
/** Defines the data and behavior required by git branch payload. */
export interface GitBranchPayload {
  /** Provides branch to git branch payload. */
  readonly branch: string;
  /** Provides expected head to git branch payload. */
  readonly expectedHead: string;
  /** Identifies repository. */
  readonly repositoryId: string;
  /** Identifies workspace. */
  readonly workspaceKey: string;
}
/** Defines the data and behavior required by git commit payload. */
export interface GitCommitPayload {
  /** Provides expected head to git commit payload. */
  readonly expectedHead: string;
  /** Provides message to git commit payload. */
  readonly message: string;
  /** Lists the paths accepted by this contract. */
  readonly paths: readonly string[];
  /** Identifies repository. */
  readonly repositoryId: string;
  /** Identifies workspace. */
  readonly workspaceKey: string;
}
/** Defines the data and behavior required by git push payload. */
export interface GitPushPayload {
  /** Provides branch to git push payload. */
  readonly branch: string;
  /** Provides expected local head to git push payload. */
  readonly expectedLocalHead: string;
  /** Provides expected remote head to git push payload. */
  readonly expectedRemoteHead: string | null;
  /** Provides remote to git push payload. */
  readonly remote: string;
  /** Identifies repository. */
  readonly repositoryId: string;
  /** Identifies workspace. */
  readonly workspaceKey: string;
}
/** Defines the data and behavior required by draft pr payload. */
export interface DraftPrPayload {
  /** Provides base branch to draft pr payload. */
  readonly baseBranch: string;
  /** Provides body to draft pr payload. */
  readonly body: string;
  /** Provides expected head to draft pr payload. */
  readonly expectedHead: string;
  /** Provides head branch to draft pr payload. */
  readonly headBranch: string;
  /** Provides publication target to draft pr payload. */
  readonly publicationTarget: string;
  /** Identifies repository. */
  readonly repositoryId: string;
  /** Provides title to draft pr payload. */
  readonly title: string;
}
/** Defines the data and behavior required by command run payload. */
export interface CommandRunPayload {
  /** Lists the arguments accepted by this contract. */
  readonly arguments: readonly string[];
  /** Identifies command. */
  readonly commandKey: string;
  /** Identifies repository. */
  readonly repositoryId: string;
  /** Identifies workspace. */
  readonly workspaceKey: string;
}
/** Defines the data and behavior required by browser run payload. */
export interface BrowserRunPayload {
  /** Identifies environment. */
  readonly environmentKey: string;
  /** Identifies repository. */
  readonly repositoryId: string;
  /** Provides scenario resource to browser run payload. */
  readonly scenarioResource: string;
  /** Identifies workspace. */
  readonly workspaceKey: string;
}
/** Defines the data and behavior required by child agent node. */
export interface ChildAgentNode {
  /** Stores the SHA-256 digest of context. */
  readonly contextDigest: string;
  /** Provides context resource to child agent node. */
  readonly contextResource: string;
  /** Records the context version used for compatibility checks. */
  readonly contextVersion: string;
  /** Identifies definition. */
  readonly definitionId: string;
  /** Lists the depends on accepted by this contract. */
  readonly dependsOn: readonly string[];
  /** Identifies node. */
  readonly nodeKey: string;
}
/** Defines the data and behavior required by child agent wave payload. */
export interface ChildAgentWavePayload {
  /** Bounds the max concurrency accepted by this contract. */
  readonly maxConcurrency: number;
  /** Lists the nodes accepted by this contract. */
  readonly nodes: readonly ChildAgentNode[];
}

/** Defines the data and behavior required by reconcilable effect adapter. */
export interface ReconcilableEffectAdapter<T> {
  /** Provides id to reconcilable effect adapter. */
  readonly id: string;
  /** Records the version used for compatibility checks. */
  readonly version: string;
  /** Applies the typed payload through the underlying effect implementation. */
  apply(input: {
    /** Provides control to reconcilable effect adapter. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides payload to reconcilable effect adapter. */
    readonly payload: T;
  }): Promise<ExternalEffectObservation>;
  /** Reconciles the typed payload through the underlying effect implementation. */
  reconcile(input: {
    /** Provides control to reconcilable effect adapter. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides payload to reconcilable effect adapter. */
    readonly payload: T;
  }): Promise<ExternalEffectObservation>;
}

/** Creates workspace provision handler after validating its inputs. */
export function createWorkspaceProvisionHandler(
  adapter: ReconcilableEffectAdapter<WorkspaceProvisionPayload>,
): ExternalEffectHandler {
  return handler("workspace.provision", adapter, parseWorkspaceProvision);
}
/** Creates workspace release handler after validating its inputs. */
export function createWorkspaceReleaseHandler(
  adapter: ReconcilableEffectAdapter<WorkspaceReleasePayload>,
): ExternalEffectHandler {
  return handler("workspace.release", adapter, parseWorkspaceRelease);
}
/** Creates git observe handler after validating its inputs. */
export function createGitObserveHandler(
  adapter: ReconcilableEffectAdapter<GitObservePayload>,
): ExternalEffectHandler {
  return handler("git.observe", adapter, parseGitObserve);
}
/** Creates git branch handler after validating its inputs. */
export function createGitBranchHandler(
  adapter: ReconcilableEffectAdapter<GitBranchPayload>,
): ExternalEffectHandler {
  return handler("git.branch", adapter, parseGitBranch);
}
/** Creates git commit handler after validating its inputs. */
export function createGitCommitHandler(
  adapter: ReconcilableEffectAdapter<GitCommitPayload>,
): ExternalEffectHandler {
  return handler("git.commit", adapter, parseGitCommit);
}
/** Creates git push handler after validating its inputs. */
export function createGitPushHandler(
  adapter: ReconcilableEffectAdapter<GitPushPayload>,
): ExternalEffectHandler {
  return handler("git.push", adapter, parseGitPush);
}
/** Creates draft pr handler after validating its inputs. */
export function createDraftPrHandler(
  adapter: ReconcilableEffectAdapter<DraftPrPayload>,
): ExternalEffectHandler {
  return handler("publication.draft_pr", adapter, parseDraftPr);
}
/** Creates command run handler after validating its inputs. */
export function createCommandRunHandler(
  adapter: ReconcilableEffectAdapter<CommandRunPayload>,
): ExternalEffectHandler {
  return handler("command.run", adapter, parseCommandRun);
}
/** Creates browser run handler after validating its inputs. */
export function createBrowserRunHandler(
  adapter: ReconcilableEffectAdapter<BrowserRunPayload>,
): ExternalEffectHandler {
  return handler("browser.run", adapter, parseBrowserRun);
}
/** Creates child agent wave handler after validating its inputs. */
export function createChildAgentWaveHandler(
  adapter: ReconcilableEffectAdapter<ChildAgentWavePayload>,
): ExternalEffectHandler {
  return handler("child_agent.wave", adapter, parseChildAgentWave);
}

/** Wraps a typed adapter with payload validation and observation checks. */
function handler<T>(
  kind: ExternalEffectKind,
  adapter: ReconcilableEffectAdapter<T>,
  parse: (payload: JsonObject) => T,
): ExternalEffectHandler {
  if (adapter.id === "" || adapter.version === "")
    throw new TypeError(`${kind} adapter identity is required`);
  return {
    id: adapter.id,
    kind,
    version: adapter.version,
    apply: (request: ExternalEffectRequest, control: ExternalEffectControl) =>
      adapter.apply({
        control,
        effectId: request.effectId,
        payload: parse(request.payload),
      }),
    reconcile: (
      request: ExternalEffectRequest,
      control: ExternalEffectControl,
    ) =>
      adapter.reconcile({
        control,
        effectId: request.effectId,
        payload: parse(request.payload),
      }),
    /** Validates the supplied payload against the closed effect schema. */
    validate(payload: JsonObject) {
      parse(payload);
    },
  };
}

/** Parses and validates workspace provision. */
function parseWorkspaceProvision(value: JsonObject): WorkspaceProvisionPayload {
  exact(value, ["mode", "repositoryId", "sourceRevision", "workspaceKey"]);
  /** Stores mode used by parse workspace provision. */
  const mode = value.mode;
  if (mode !== "mirror" && mode !== "worktree")
    throw new TypeError("workspace.provision mode is invalid");
  return {
    mode,
    repositoryId: text(value.repositoryId, "repositoryId"),
    sourceRevision: revision(value.sourceRevision, "sourceRevision"),
    workspaceKey: key(value.workspaceKey, "workspaceKey"),
  };
}
/** Parses and validates workspace release. */
function parseWorkspaceRelease(value: JsonObject): WorkspaceReleasePayload {
  exact(value, ["repositoryId", "workspaceKey"]);
  return {
    repositoryId: text(value.repositoryId, "repositoryId"),
    workspaceKey: key(value.workspaceKey, "workspaceKey"),
  };
}
/** Parses and validates git observe. */
function parseGitObserve(value: JsonObject): GitObservePayload {
  exact(value, ["repositoryId", "revision", "workspaceKey"]);
  return {
    repositoryId: text(value.repositoryId, "repositoryId"),
    revision: revision(value.revision, "revision"),
    workspaceKey: key(value.workspaceKey, "workspaceKey"),
  };
}
/** Parses and validates git branch. */
function parseGitBranch(value: JsonObject): GitBranchPayload {
  exact(value, ["branch", "expectedHead", "repositoryId", "workspaceKey"]);
  return {
    branch: branch(value.branch),
    expectedHead: revision(value.expectedHead, "expectedHead"),
    repositoryId: text(value.repositoryId, "repositoryId"),
    workspaceKey: key(value.workspaceKey, "workspaceKey"),
  };
}
/** Parses and validates git commit. */
function parseGitCommit(value: JsonObject): GitCommitPayload {
  exact(value, [
    "expectedHead",
    "message",
    "paths",
    "repositoryId",
    "workspaceKey",
  ]);
  /** Stores paths used by parse git commit. */
  const paths = stringList(value.paths, "paths");
  if (paths.length === 0)
    throw new TypeError("git.commit paths cannot be empty");
  paths.forEach((path) => relativePath(path, "git.commit path"));
  return {
    expectedHead: revision(value.expectedHead, "expectedHead"),
    message: commitMessage(value.message),
    paths,
    repositoryId: text(value.repositoryId, "repositoryId"),
    workspaceKey: key(value.workspaceKey, "workspaceKey"),
  };
}
/** Parses and validates git push. */
function parseGitPush(value: JsonObject): GitPushPayload {
  exact(value, [
    "branch",
    "expectedLocalHead",
    "expectedRemoteHead",
    "remote",
    "repositoryId",
    "workspaceKey",
  ]);
  return {
    branch: branch(value.branch),
    expectedLocalHead: revision(value.expectedLocalHead, "expectedLocalHead"),
    expectedRemoteHead: nullableRevision(
      value.expectedRemoteHead,
      "expectedRemoteHead",
    ),
    remote: key(value.remote, "remote"),
    repositoryId: text(value.repositoryId, "repositoryId"),
    workspaceKey: key(value.workspaceKey, "workspaceKey"),
  };
}
/** Parses and validates draft pr. */
function parseDraftPr(value: JsonObject): DraftPrPayload {
  exact(value, [
    "baseBranch",
    "body",
    "expectedHead",
    "headBranch",
    "publicationTarget",
    "repositoryId",
    "title",
  ]);
  /** Stores title used by parse draft pr. */
  const title = text(value.title, "title");
  if (title.length > 200)
    throw new TypeError("publication.draft_pr title is too long");
  /** Stores body used by parse draft pr. */
  const body = typeof value.body === "string" ? value.body : invalid("body");
  if (body.length > 100_000)
    throw new TypeError("publication.draft_pr body is too long");
  return {
    baseBranch: branch(value.baseBranch),
    body,
    expectedHead: revision(value.expectedHead, "expectedHead"),
    headBranch: branch(value.headBranch),
    publicationTarget: key(value.publicationTarget, "publicationTarget"),
    repositoryId: text(value.repositoryId, "repositoryId"),
    title,
  };
}
/** Parses and validates command run. */
function parseCommandRun(value: JsonObject): CommandRunPayload {
  exact(value, ["arguments", "commandKey", "repositoryId", "workspaceKey"]);
  /** Stores args used by parse command run. */
  const args = stringList(value.arguments, "arguments");
  if (args.length > 100 || args.some((entry) => entry.length > 10_000))
    throw new TypeError("command.run arguments exceed their bounds");
  return {
    arguments: args,
    commandKey: key(value.commandKey, "commandKey"),
    repositoryId: text(value.repositoryId, "repositoryId"),
    workspaceKey: key(value.workspaceKey, "workspaceKey"),
  };
}
/** Parses and validates browser run. */
function parseBrowserRun(value: JsonObject): BrowserRunPayload {
  exact(value, [
    "environmentKey",
    "repositoryId",
    "scenarioResource",
    "workspaceKey",
  ]);
  return {
    environmentKey: key(value.environmentKey, "environmentKey"),
    repositoryId: text(value.repositoryId, "repositoryId"),
    scenarioResource: key(value.scenarioResource, "scenarioResource"),
    workspaceKey: key(value.workspaceKey, "workspaceKey"),
  };
}
/** Parses and validates child agent wave. */
function parseChildAgentWave(value: JsonObject): ChildAgentWavePayload {
  exact(value, ["maxConcurrency", "nodes"]);
  /** Stores max concurrency used by parse child agent wave. */
  const maxConcurrency = value.maxConcurrency;
  if (
    typeof maxConcurrency !== "number" ||
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > 32
  )
    throw new TypeError("child_agent.wave maxConcurrency is invalid");
  if (
    !Array.isArray(value.nodes) ||
    value.nodes.length === 0 ||
    value.nodes.length > 1_000
  )
    throw new TypeError("child_agent.wave nodes are invalid");
  /** Stores nodes used by parse child agent wave. */
  const nodes = value.nodes.map((entry, index) => {
    /** Stores node used by parse child agent wave. */
    const node = object(entry, `nodes[${index}]`);
    exact(node, [
      "contextDigest",
      "contextResource",
      "contextVersion",
      "definitionId",
      "dependsOn",
      "nodeKey",
    ]);
    return {
      contextDigest: digest(node.contextDigest, "contextDigest"),
      contextResource: key(node.contextResource, "contextResource"),
      contextVersion: text(node.contextVersion, "contextVersion"),
      definitionId: text(node.definitionId, "definitionId"),
      dependsOn: stringList(node.dependsOn, "dependsOn").map((item) =>
        key(item, "dependency"),
      ),
      nodeKey: key(node.nodeKey, "nodeKey"),
    };
  });
  /** Tracks unique keys values. */
  const keys = new Set(nodes.map((node) => node.nodeKey));
  if (keys.size !== nodes.length)
    throw new TypeError("child_agent.wave node keys must be unique");
  for (const node of nodes)
    for (const dependency of node.dependsOn)
      if (!keys.has(dependency) || dependency === node.nodeKey)
        throw new TypeError("child_agent.wave dependency is invalid");
  assertAcyclic(nodes);
  return { maxConcurrency, nodes };
}

/** Rejects input that does not satisfy the acyclic contract. */
function assertAcyclic(nodes: readonly ChildAgentNode[]): void {
  /** Indexes dependencies for deterministic lookup by assert acyclic. */
  const dependencies = new Map(
    nodes.map((node) => [node.nodeKey, node.dependsOn]),
  );
  /** Tracks unique visiting values. */
  const visiting = new Set<string>();
  /** Tracks unique visited values. */
  const visited = new Set<string>();
  /** Stores visit used by assert acyclic. */
  const visit = (node: string): void => {
    if (visiting.has(node))
      throw new TypeError("child_agent.wave dependency graph contains a cycle");
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of dependencies.get(node) ?? []) visit(dependency);
    visiting.delete(node);
    visited.add(node);
  };
  nodes.forEach((node) => visit(node.nodeKey));
}
/** Rejects objects whose keys differ from the expected closed shape. */
function exact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new TypeError(
      "External-effect payload has unexpected or missing fields",
    );
}
/** Validates and returns the required object representation. */
function object(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value;
}
/** Validates and normalizes a bounded text value. */
function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "" || value.length > 100_000)
    throw new TypeError(`${label} must be a bounded non-empty string`);
  return value;
}
/** Validates and returns a bounded provider key. */
function key(value: JsonValue | undefined, label: string): string {
  /** Holds the validated result returned by key. */
  const result = text(value, label);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(result) ||
    result.includes("..")
  )
    throw new TypeError(`${label} is invalid`);
  return result;
}
/** Validates and returns an immutable Git revision. */
function revision(value: JsonValue | undefined, label: string): string {
  /** Holds the validated result returned by revision. */
  const result = text(value, label);
  if (!/^[a-f0-9]{40,64}$/u.test(result))
    throw new TypeError(`${label} must be a full immutable revision`);
  return result;
}
/** Validates and returns an immutable Git revision. */
function nullableRevision(
  value: JsonValue | undefined,
  label: string,
): string | null {
  return value === null ? null : revision(value, label);
}
/** Validates and returns a lowercase SHA-256 digest. */
function digest(value: JsonValue | undefined, label: string): string {
  /** Holds the validated result returned by digest. */
  const result = text(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result))
    throw new TypeError(`${label} must be a SHA-256 digest`);
  return result;
}
/** Validates and returns a safe Git branch name. */
function branch(value: JsonValue | undefined): string {
  /** Holds the validated result returned by branch. */
  const result = text(value, "branch");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(result) ||
    result.includes("..") ||
    result.endsWith("/") ||
    result.endsWith(".")
  )
    throw new TypeError("branch is invalid");
  return result;
}
/** Validates and returns a repository-relative path. */
function relativePath(value: string, label: string): string {
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.split(/[\\/]/u).includes("..")
  )
    throw new TypeError(`${label} must be repository-relative`);
  return value;
}
/** Validates and returns unique non-empty strings. */
function stringList(
  value: JsonValue | undefined,
  label: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  )
    throw new TypeError(`${label} must contain non-empty strings`);
  /** Holds the validated result returned by string list. */
  const result = value as string[];
  if (new Set(result).size !== result.length)
    throw new TypeError(`${label} cannot contain duplicates`);
  return [...result];
}
/** Validates and returns a bounded Git commit message. */
function commitMessage(value: JsonValue | undefined): string {
  /** Holds the validated result returned by commit message. */
  const result = text(value, "message");
  if (result.length > 10_000 || /[\r\n]/u.test(result.split("\n", 1)[0] ?? ""))
    throw new TypeError("git.commit message is invalid");
  return result;
}
/** Throws a typed validation error for the named field. */
function invalid(label: string): never {
  throw new TypeError(`${label} is invalid`);
}
