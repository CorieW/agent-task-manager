/** Parses and validates v3 provider environment configuration. */
import { isAbsolute, relative, resolve } from "node:path";

import type { JsonObject, JsonValue } from "../domain/json.js";
import { TABLE_KINDS, type ProviderEnvironment } from "../domain/provider.js";

/** Git worktree isolation policy enforced for selected Agent definition keys. */
export interface WorktreeConfig {
  readonly baseRef: string;
  readonly branchPrefix: string;
  readonly repository: string;
  readonly requiredAgentKeys: readonly string[];
  readonly root: string;
}

/** Validated v3 environment configuration and its original JSON value. */
export interface EnvironmentConfig {
  readonly environmentId: string;
  readonly provider: ProviderEnvironment;
  readonly raw: JsonObject;
  readonly schema: "agent-task-manager-environment-v3";
  readonly worktree: WorktreeConfig | null;
}
/** Aggregates all problems found while parsing environment configuration. */
export class EnvironmentConfigError extends TypeError {
  public constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
  }
}

/** Strictly parses v3 environment JSON, rejecting unknown or missing fields. */
export function parseEnvironmentConfig(value: JsonValue): EnvironmentConfig {
  const issues: string[] = [];
  const root = object(value, "root", issues);
  rejectUnknown(
    root,
    ["schema", "environmentId", "provider", "worktree"],
    "root",
    issues,
  );
  if (root.schema !== "agent-task-manager-environment-v3")
    issues.push("schema must equal agent-task-manager-environment-v3");
  const environmentId = string(root.environmentId, "environmentId", issues);
  const worktree = parseWorktree(root.worktree, issues);
  const provider = object(root.provider, "provider", issues);
  rejectUnknown(
    provider,
    ["type", "connection", "bootstrapParent", "tables"],
    "provider",
    issues,
  );
  const type = string(provider.type, "provider.type", issues);
  const connection = object(provider.connection, "provider.connection", issues);
  const parent = nullableString(
    provider.bootstrapParent,
    "provider.bootstrapParent",
    issues,
  );
  const tableObject = object(provider.tables, "provider.tables", issues);
  rejectUnknown(tableObject, TABLE_KINDS, "provider.tables", issues);
  const tables = Object.fromEntries(
    TABLE_KINDS.map((kind) => [
      kind,
      nullableString(tableObject[kind], `provider.tables.${kind}`, issues),
    ]),
  ) as Record<(typeof TABLE_KINDS)[number], string | null>;
  if (issues.length > 0) throw new EnvironmentConfigError(issues);
  return {
    environmentId,
    provider: { bootstrapParent: parent, connection, tables, type },
    raw: root,
    schema: "agent-task-manager-environment-v3",
    worktree,
  };
}

function parseWorktree(
  value: JsonValue | undefined,
  issues: string[],
): WorktreeConfig | null {
  if (value === null) return null;
  const worktree = object(value, "worktree", issues);
  rejectUnknown(
    worktree,
    ["baseRef", "branchPrefix", "repository", "requiredAgentKeys", "root"],
    "worktree",
    issues,
  );
  const baseRef = string(worktree.baseRef, "worktree.baseRef", issues);
  const branchPrefix = string(
    worktree.branchPrefix,
    "worktree.branchPrefix",
    issues,
  );
  const repository = absolutePath(
    worktree.repository,
    "worktree.repository",
    issues,
  );
  const root = absolutePath(worktree.root, "worktree.root", issues);
  const requiredAgentKeys = stringSet(
    worktree.requiredAgentKeys,
    "worktree.requiredAgentKeys",
    issues,
  );
  if (baseRef.startsWith("-"))
    issues.push("worktree.baseRef must not start with '-'");
  if (!branchPrefix.endsWith("/") || branchPrefix.startsWith("-"))
    issues.push(
      "worktree.branchPrefix must be a non-option prefix ending in '/'",
    );
  if (repository !== "" && root !== "" && pathsOverlap(repository, root))
    issues.push("worktree.root and worktree.repository must not overlap");
  return { baseRef, branchPrefix, repository, requiredAgentKeys, root };
}

function object(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  return value;
}
function string(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string`);
    return "";
  }
  return value;
}
function nullableString(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): string | null {
  if (value === null) return null;
  return string(value, path, issues);
}
function absolutePath(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): string {
  const result = string(value, path, issues);
  if (result !== "" && !isAbsolute(result))
    issues.push(`${path} must be absolute`);
  return result;
}
function stringSet(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): readonly string[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be a string array`);
    return [];
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    const item = string(entry, `${path}[${index}]`, issues);
    if (item !== "") result.push(item.normalize("NFC"));
  }
  if (new Set(result).size !== result.length)
    issues.push(`${path} must not contain duplicates`);
  return result;
}
function pathsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string): boolean => {
    const value = relative(resolve(parent), resolve(child));
    return value === "" || (!value.startsWith("..") && !isAbsolute(value));
  };
  return contains(left, right) || contains(right, left);
}
function rejectUnknown(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value))
    if (!keys.has(key)) issues.push(`${path}.${key} is not allowed`);
}
