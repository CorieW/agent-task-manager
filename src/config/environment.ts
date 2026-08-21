/** Parses and validates v3 provider and lifecycle-command configuration. */
import { isAbsolute } from "node:path";

import type { JsonObject, JsonValue } from "../domain/json.js";
import { TABLE_KINDS, type ProviderEnvironment } from "../domain/provider.js";

/** One trusted, shell-free command run at an Agent lifecycle boundary. */
export interface LifecycleCommandConfig {
  readonly agentKeys: readonly string[] | null;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly inheritEnvironment: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly workingDirectory: string | null;
}

/** Commands and execution directories configured outside Agent control. */
export interface LifecycleCommandsConfig {
  readonly afterAgent: readonly LifecycleCommandConfig[];
  readonly beforeAgent: readonly LifecycleCommandConfig[];
  readonly workingDirectories: Readonly<Record<string, string>>;
}

/** Validated v3 environment configuration and its original JSON value. */
export interface EnvironmentConfig {
  readonly environmentId: string;
  readonly lifecycleCommands: LifecycleCommandsConfig;
  readonly provider: ProviderEnvironment;
  readonly raw: JsonObject;
  readonly schema: "agent-task-manager-environment-v3";
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
    ["schema", "environmentId", "lifecycleCommands", "provider"],
    "root",
    issues,
  );
  if (root.schema !== "agent-task-manager-environment-v3")
    issues.push("schema must equal agent-task-manager-environment-v3");
  const environmentId = string(root.environmentId, "environmentId", issues);
  const lifecycleCommands = parseLifecycleCommands(
    root.lifecycleCommands,
    issues,
  );
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
    lifecycleCommands,
    provider: { bootstrapParent: parent, connection, tables, type },
    raw: root,
    schema: "agent-task-manager-environment-v3",
  };
}

function parseLifecycleCommands(
  value: JsonValue | undefined,
  issues: string[],
): LifecycleCommandsConfig {
  const lifecycle = object(value, "lifecycleCommands", issues);
  rejectUnknown(
    lifecycle,
    ["afterAgent", "beforeAgent", "workingDirectories"],
    "lifecycleCommands",
    issues,
  );
  const workingDirectoryValues = object(
    lifecycle.workingDirectories,
    "lifecycleCommands.workingDirectories",
    issues,
  );
  const workingDirectories = Object.fromEntries(
    Object.entries(workingDirectoryValues).map(([key, entry]) => {
      const path = templateString(
        entry,
        `lifecycleCommands.workingDirectories.${key}`,
        issues,
      );
      if (
        /\{\{(?:failureSummary|outcome|status|workingDirectory)\}\}/u.test(path)
      )
        issues.push(
          `lifecycleCommands.workingDirectories.${key} may use only stable start-context placeholders`,
        );
      if (!isAbsolute(path.replaceAll(/\{\{[A-Za-z]+\}\}/gu, "value")))
        issues.push(
          `lifecycleCommands.workingDirectories.${key} must render as an absolute path`,
        );
      return [
        nonEmptyKey(key, "lifecycleCommands.workingDirectories", issues),
        path,
      ];
    }),
  );
  return {
    afterAgent: commandArray(
      lifecycle.afterAgent,
      "lifecycleCommands.afterAgent",
      issues,
    ),
    beforeAgent: commandArray(
      lifecycle.beforeAgent,
      "lifecycleCommands.beforeAgent",
      issues,
    ),
    workingDirectories,
  };
}

function commandArray(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): readonly LifecycleCommandConfig[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const command = object(entry, itemPath, issues);
    rejectUnknown(
      command,
      [
        "agentKeys",
        "arguments",
        "environment",
        "executable",
        "inheritEnvironment",
        "timeoutMilliseconds",
        "workingDirectory",
      ],
      itemPath,
      issues,
    );
    const workingDirectory = nullableTemplateString(
      command.workingDirectory,
      `${itemPath}.workingDirectory`,
      issues,
    );
    if (
      workingDirectory !== null &&
      !isAbsolute(workingDirectory.replaceAll(/\{\{[A-Za-z]+\}\}/gu, "value"))
    )
      issues.push(
        `${itemPath}.workingDirectory must render as an absolute path`,
      );
    return {
      agentKeys: nullableStringArray(
        command.agentKeys,
        `${itemPath}.agentKeys`,
        issues,
      ),
      arguments: stringArray(
        command.arguments,
        `${itemPath}.arguments`,
        issues,
      ).map((argument, argumentIndex) =>
        validateTemplate(
          argument,
          `${itemPath}.arguments[${argumentIndex}]`,
          issues,
        ),
      ),
      environment: environmentMap(
        command.environment,
        `${itemPath}.environment`,
        issues,
      ),
      executable: validateTemplate(
        string(command.executable, `${itemPath}.executable`, issues),
        `${itemPath}.executable`,
        issues,
      ),
      inheritEnvironment: environmentNames(
        command.inheritEnvironment,
        `${itemPath}.inheritEnvironment`,
        issues,
      ),
      timeoutMilliseconds: positiveInteger(
        command.timeoutMilliseconds,
        `${itemPath}.timeoutMilliseconds`,
        issues,
      ),
      workingDirectory,
    };
  });
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
function templateString(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): string {
  return validateTemplate(string(value, path, issues), path, issues);
}
function nullableTemplateString(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): string | null {
  if (value === null) return null;
  return templateString(value, path, issues);
}
const TEMPLATE_FIELDS = new Set([
  "agentKey",
  "environmentId",
  "failureSummary",
  "harnessId",
  "outcome",
  "parentRunId",
  "runId",
  "status",
  "taskId",
  "workingDirectory",
]);
function validateTemplate(
  value: string,
  path: string,
  issues: string[],
): string {
  const placeholders = [...value.matchAll(/\{\{([A-Za-z]+)\}\}/gu)];
  for (const match of placeholders)
    if (!TEMPLATE_FIELDS.has(match[1]!))
      issues.push(`${path} uses unsupported placeholder: ${match[0]}`);
  const remainder = value.replaceAll(/\{\{[A-Za-z]+\}\}/gu, "");
  if (remainder.includes("{{") || remainder.includes("}}"))
    issues.push(`${path} contains a malformed placeholder`);
  return value;
}
function stringArray(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): readonly string[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be a string array`);
    return [];
  }
  return value.map((entry, index) =>
    string(entry, `${path}[${index}]`, issues),
  );
}
function nullableStringArray(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): readonly string[] | null {
  if (value === null) return null;
  const values = stringArray(value, path, issues);
  if (new Set(values).size !== values.length)
    issues.push(`${path} must not contain duplicates`);
  return values;
}
function environmentMap(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): Readonly<Record<string, string>> {
  const values = object(value, path, issues);
  return Object.fromEntries(
    Object.entries(values).map(([key, entry]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
        issues.push(`${path}.${key} is not a valid environment variable name`);
      return [key, templateString(entry, `${path}.${key}`, issues)];
    }),
  );
}
function environmentNames(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): readonly string[] {
  const names = stringArray(value, path, issues);
  for (const name of names)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
      issues.push(`${path} contains an invalid environment variable name`);
  if (new Set(names).size !== names.length)
    issues.push(`${path} must not contain duplicates`);
  return names;
}
function positiveInteger(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issues.push(`${path} must be a positive integer`);
    return 1;
  }
  return value;
}
function nonEmptyKey(key: string, path: string, issues: string[]): string {
  if (key.trim() === "") issues.push(`${path} contains an empty Agent key`);
  return key;
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
