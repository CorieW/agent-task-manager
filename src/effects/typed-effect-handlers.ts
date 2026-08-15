// Converts closed provider-defined effect payloads into trusted adapter calls.
import type { JsonObject, JsonValue } from "../domain/json.js";
import type { ExternalEffectControl, ExternalEffectHandler, ExternalEffectObservation, ExternalEffectRequest } from "./contracts.js";

export const EXTERNAL_EFFECT_KINDS = [
  "browser.run", "child_agent.wave", "command.run", "git.branch", "git.commit", "git.observe",
  "git.push", "publication.draft_pr", "workspace.provision", "workspace.release",
] as const;
export type ExternalEffectKind = typeof EXTERNAL_EFFECT_KINDS[number];

export interface WorkspaceProvisionPayload { readonly mode: "mirror" | "worktree"; readonly repositoryId: string; readonly sourceRevision: string; readonly workspaceKey: string; }
export interface WorkspaceReleasePayload { readonly repositoryId: string; readonly workspaceKey: string; }
export interface GitObservePayload { readonly repositoryId: string; readonly revision: string; readonly workspaceKey: string; }
export interface GitBranchPayload { readonly branch: string; readonly expectedHead: string; readonly repositoryId: string; readonly workspaceKey: string; }
export interface GitCommitPayload { readonly expectedHead: string; readonly message: string; readonly paths: readonly string[]; readonly repositoryId: string; readonly workspaceKey: string; }
export interface GitPushPayload { readonly branch: string; readonly expectedLocalHead: string; readonly expectedRemoteHead: string | null; readonly remote: string; readonly repositoryId: string; readonly workspaceKey: string; }
export interface DraftPrPayload { readonly baseBranch: string; readonly body: string; readonly expectedHead: string; readonly headBranch: string; readonly publicationTarget: string; readonly repositoryId: string; readonly title: string; }
export interface CommandRunPayload { readonly arguments: readonly string[]; readonly commandKey: string; readonly repositoryId: string; readonly workspaceKey: string; }
export interface BrowserRunPayload { readonly environmentKey: string; readonly repositoryId: string; readonly scenarioResource: string; readonly workspaceKey: string; }
export interface ChildAgentNode { readonly contextDigest: string; readonly contextResource: string; readonly contextVersion: string; readonly definitionId: string; readonly dependsOn: readonly string[]; readonly nodeKey: string; }
export interface ChildAgentWavePayload { readonly maxConcurrency: number; readonly nodes: readonly ChildAgentNode[]; }

export interface ReconcilableEffectAdapter<T> {
  readonly id: string;
  readonly version: string;
  apply(input: { readonly control: ExternalEffectControl; readonly effectId: string; readonly payload: T }): Promise<ExternalEffectObservation>;
  reconcile(input: { readonly control: ExternalEffectControl; readonly effectId: string; readonly payload: T }): Promise<ExternalEffectObservation>;
}

export function createWorkspaceProvisionHandler(adapter: ReconcilableEffectAdapter<WorkspaceProvisionPayload>): ExternalEffectHandler { return handler("workspace.provision", adapter, parseWorkspaceProvision); }
export function createWorkspaceReleaseHandler(adapter: ReconcilableEffectAdapter<WorkspaceReleasePayload>): ExternalEffectHandler { return handler("workspace.release", adapter, parseWorkspaceRelease); }
export function createGitObserveHandler(adapter: ReconcilableEffectAdapter<GitObservePayload>): ExternalEffectHandler { return handler("git.observe", adapter, parseGitObserve); }
export function createGitBranchHandler(adapter: ReconcilableEffectAdapter<GitBranchPayload>): ExternalEffectHandler { return handler("git.branch", adapter, parseGitBranch); }
export function createGitCommitHandler(adapter: ReconcilableEffectAdapter<GitCommitPayload>): ExternalEffectHandler { return handler("git.commit", adapter, parseGitCommit); }
export function createGitPushHandler(adapter: ReconcilableEffectAdapter<GitPushPayload>): ExternalEffectHandler { return handler("git.push", adapter, parseGitPush); }
export function createDraftPrHandler(adapter: ReconcilableEffectAdapter<DraftPrPayload>): ExternalEffectHandler { return handler("publication.draft_pr", adapter, parseDraftPr); }
export function createCommandRunHandler(adapter: ReconcilableEffectAdapter<CommandRunPayload>): ExternalEffectHandler { return handler("command.run", adapter, parseCommandRun); }
export function createBrowserRunHandler(adapter: ReconcilableEffectAdapter<BrowserRunPayload>): ExternalEffectHandler { return handler("browser.run", adapter, parseBrowserRun); }
export function createChildAgentWaveHandler(adapter: ReconcilableEffectAdapter<ChildAgentWavePayload>): ExternalEffectHandler { return handler("child_agent.wave", adapter, parseChildAgentWave); }

function handler<T>(kind: ExternalEffectKind, adapter: ReconcilableEffectAdapter<T>, parse: (payload: JsonObject) => T): ExternalEffectHandler {
  if (adapter.id === "" || adapter.version === "") throw new TypeError(`${kind} adapter identity is required`);
  return {
    id: adapter.id,
    kind,
    version: adapter.version,
    apply: (request: ExternalEffectRequest, control: ExternalEffectControl) => adapter.apply({ control, effectId: request.effectId, payload: parse(request.payload) }),
    reconcile: (request: ExternalEffectRequest, control: ExternalEffectControl) => adapter.reconcile({ control, effectId: request.effectId, payload: parse(request.payload) }),
    validate(payload: JsonObject) { parse(payload); },
  };
}

function parseWorkspaceProvision(value: JsonObject): WorkspaceProvisionPayload {
  exact(value, ["mode", "repositoryId", "sourceRevision", "workspaceKey"]);
  const mode = value.mode; if (mode !== "mirror" && mode !== "worktree") throw new TypeError("workspace.provision mode is invalid");
  return { mode, repositoryId: text(value.repositoryId, "repositoryId"), sourceRevision: revision(value.sourceRevision, "sourceRevision"), workspaceKey: key(value.workspaceKey, "workspaceKey") };
}
function parseWorkspaceRelease(value: JsonObject): WorkspaceReleasePayload { exact(value, ["repositoryId", "workspaceKey"]); return { repositoryId: text(value.repositoryId, "repositoryId"), workspaceKey: key(value.workspaceKey, "workspaceKey") }; }
function parseGitObserve(value: JsonObject): GitObservePayload { exact(value, ["repositoryId", "revision", "workspaceKey"]); return { repositoryId: text(value.repositoryId, "repositoryId"), revision: revision(value.revision, "revision"), workspaceKey: key(value.workspaceKey, "workspaceKey") }; }
function parseGitBranch(value: JsonObject): GitBranchPayload { exact(value, ["branch", "expectedHead", "repositoryId", "workspaceKey"]); return { branch: branch(value.branch), expectedHead: revision(value.expectedHead, "expectedHead"), repositoryId: text(value.repositoryId, "repositoryId"), workspaceKey: key(value.workspaceKey, "workspaceKey") }; }
function parseGitCommit(value: JsonObject): GitCommitPayload {
  exact(value, ["expectedHead", "message", "paths", "repositoryId", "workspaceKey"]);
  const paths = stringList(value.paths, "paths"); if (paths.length === 0) throw new TypeError("git.commit paths cannot be empty");
  paths.forEach((path) => relativePath(path, "git.commit path"));
  return { expectedHead: revision(value.expectedHead, "expectedHead"), message: commitMessage(value.message), paths, repositoryId: text(value.repositoryId, "repositoryId"), workspaceKey: key(value.workspaceKey, "workspaceKey") };
}
function parseGitPush(value: JsonObject): GitPushPayload {
  exact(value, ["branch", "expectedLocalHead", "expectedRemoteHead", "remote", "repositoryId", "workspaceKey"]);
  return { branch: branch(value.branch), expectedLocalHead: revision(value.expectedLocalHead, "expectedLocalHead"), expectedRemoteHead: nullableRevision(value.expectedRemoteHead, "expectedRemoteHead"), remote: key(value.remote, "remote"), repositoryId: text(value.repositoryId, "repositoryId"), workspaceKey: key(value.workspaceKey, "workspaceKey") };
}
function parseDraftPr(value: JsonObject): DraftPrPayload {
  exact(value, ["baseBranch", "body", "expectedHead", "headBranch", "publicationTarget", "repositoryId", "title"]);
  const title = text(value.title, "title"); if (title.length > 200) throw new TypeError("publication.draft_pr title is too long");
  const body = typeof value.body === "string" ? value.body : invalid("body"); if (body.length > 100_000) throw new TypeError("publication.draft_pr body is too long");
  return { baseBranch: branch(value.baseBranch), body, expectedHead: revision(value.expectedHead, "expectedHead"), headBranch: branch(value.headBranch), publicationTarget: key(value.publicationTarget, "publicationTarget"), repositoryId: text(value.repositoryId, "repositoryId"), title };
}
function parseCommandRun(value: JsonObject): CommandRunPayload { exact(value, ["arguments", "commandKey", "repositoryId", "workspaceKey"]); const args = stringList(value.arguments, "arguments"); if (args.length > 100 || args.some((entry) => entry.length > 10_000)) throw new TypeError("command.run arguments exceed their bounds"); return { arguments: args, commandKey: key(value.commandKey, "commandKey"), repositoryId: text(value.repositoryId, "repositoryId"), workspaceKey: key(value.workspaceKey, "workspaceKey") }; }
function parseBrowserRun(value: JsonObject): BrowserRunPayload { exact(value, ["environmentKey", "repositoryId", "scenarioResource", "workspaceKey"]); return { environmentKey: key(value.environmentKey, "environmentKey"), repositoryId: text(value.repositoryId, "repositoryId"), scenarioResource: key(value.scenarioResource, "scenarioResource"), workspaceKey: key(value.workspaceKey, "workspaceKey") }; }
function parseChildAgentWave(value: JsonObject): ChildAgentWavePayload {
  exact(value, ["maxConcurrency", "nodes"]);
  const maxConcurrency = value.maxConcurrency; if (typeof maxConcurrency !== "number" || !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) throw new TypeError("child_agent.wave maxConcurrency is invalid");
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > 1_000) throw new TypeError("child_agent.wave nodes are invalid");
  const nodes = value.nodes.map((entry, index) => {
    const node = object(entry, `nodes[${index}]`); exact(node, ["contextDigest", "contextResource", "contextVersion", "definitionId", "dependsOn", "nodeKey"]);
    return { contextDigest: digest(node.contextDigest, "contextDigest"), contextResource: key(node.contextResource, "contextResource"), contextVersion: text(node.contextVersion, "contextVersion"), definitionId: text(node.definitionId, "definitionId"), dependsOn: stringList(node.dependsOn, "dependsOn").map((item) => key(item, "dependency")), nodeKey: key(node.nodeKey, "nodeKey") };
  });
  const keys = new Set(nodes.map((node) => node.nodeKey)); if (keys.size !== nodes.length) throw new TypeError("child_agent.wave node keys must be unique");
  for (const node of nodes) for (const dependency of node.dependsOn) if (!keys.has(dependency) || dependency === node.nodeKey) throw new TypeError("child_agent.wave dependency is invalid");
  assertAcyclic(nodes);
  return { maxConcurrency, nodes };
}

function assertAcyclic(nodes: readonly ChildAgentNode[]): void {
  const dependencies = new Map(nodes.map((node) => [node.nodeKey, node.dependsOn]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (node: string): void => { if (visiting.has(node)) throw new TypeError("child_agent.wave dependency graph contains a cycle"); if (visited.has(node)) return; visiting.add(node); for (const dependency of dependencies.get(node) ?? []) visit(dependency); visiting.delete(node); visited.add(node); };
  nodes.forEach((node) => visit(node.nodeKey));
}
function exact(value: JsonObject, keys: readonly string[]): void { if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new TypeError("External-effect payload has unexpected or missing fields"); }
function object(value: JsonValue | undefined, label: string): JsonObject { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`); return value; }
function text(value: JsonValue | undefined, label: string): string { if (typeof value !== "string" || value === "" || value.length > 100_000) throw new TypeError(`${label} must be a bounded non-empty string`); return value; }
function key(value: JsonValue | undefined, label: string): string { const result = text(value, label); if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(result) || result.includes("..")) throw new TypeError(`${label} is invalid`); return result; }
function revision(value: JsonValue | undefined, label: string): string { const result = text(value, label); if (!/^[a-f0-9]{40,64}$/u.test(result)) throw new TypeError(`${label} must be a full immutable revision`); return result; }
function nullableRevision(value: JsonValue | undefined, label: string): string | null { return value === null ? null : revision(value, label); }
function digest(value: JsonValue | undefined, label: string): string { const result = text(value, label); if (!/^[a-f0-9]{64}$/u.test(result)) throw new TypeError(`${label} must be a SHA-256 digest`); return result; }
function branch(value: JsonValue | undefined): string { const result = text(value, "branch"); if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(result) || result.includes("..") || result.endsWith("/") || result.endsWith(".")) throw new TypeError("branch is invalid"); return result; }
function relativePath(value: string, label: string): string { if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.split(/[\\/]/u).includes("..")) throw new TypeError(`${label} must be repository-relative`); return value; }
function stringList(value: JsonValue | undefined, label: string): readonly string[] { if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) throw new TypeError(`${label} must contain non-empty strings`); const result = value as string[]; if (new Set(result).size !== result.length) throw new TypeError(`${label} cannot contain duplicates`); return [...result]; }
function commitMessage(value: JsonValue | undefined): string { const result = text(value, "message"); if (result.length > 10_000 || /[\r\n]/u.test(result.split("\n", 1)[0] ?? "")) throw new TypeError("git.commit message is invalid"); return result; }
function invalid(label: string): never { throw new TypeError(`${label} is invalid`); }
