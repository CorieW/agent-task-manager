import type { JsonObject, JsonValue } from "../domain/json.js";
import { TABLE_KINDS, type ProviderEnvironment } from "../domain/provider.js";

export interface EnvironmentConfig {
  readonly environmentId: string;
  readonly provider: ProviderEnvironment;
  readonly raw: JsonObject;
  readonly schema: "agent-task-manager-environment-v1";
}

export class EnvironmentConfigError extends TypeError {
  public constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
  }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: JsonValue | undefined, path: string, issues: string[]): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string or null`);
    return null;
  }
  return value;
}

function requiredString(value: JsonValue | undefined, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string`);
    return null;
  }
  return value;
}

function rejectUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) issues.push(`${path}.${key} is not allowed`);
  }
}

export function parseEnvironmentConfig(value: JsonValue): EnvironmentConfig {
  const issues: string[] = [];
  if (!isObject(value)) throw new EnvironmentConfigError(["root must be an object"]);
  rejectUnknownKeys(
    value,
    ["adapters", "environmentId", "provider", "repository", "runtime", "schema"],
    "root",
    issues,
  );

  const schema = value.schema;
  if (schema !== "agent-task-manager-environment-v1") {
    issues.push("schema must equal agent-task-manager-environment-v1");
  }

  const environmentId = requiredString(value.environmentId, "environmentId", issues);
  const providerValue = value.provider;
  if (!isObject(providerValue)) {
    issues.push("provider must be an object");
  }

  const provider = isObject(providerValue) ? providerValue : {};
  rejectUnknownKeys(provider, ["bootstrapParent", "connection", "tables", "type"], "provider", issues);
  const type = requiredString(provider.type, "provider.type", issues);
  const bootstrapParent = optionalString(
    provider.bootstrapParent,
    "provider.bootstrapParent",
    issues,
  );

  const connection = provider.connection;
  if (!isObject(connection)) issues.push("provider.connection must be an object");
  const tablesValue = provider.tables;
  if (!isObject(tablesValue)) issues.push("provider.tables must be an object");
  const tableObject = isObject(tablesValue) ? tablesValue : {};
  rejectUnknownKeys(tableObject, TABLE_KINDS, "provider.tables", issues);
  for (const kind of TABLE_KINDS) {
    if (!Object.hasOwn(tableObject, kind)) issues.push(`provider.tables.${kind} is required`);
  }
  const tables = Object.fromEntries(
    TABLE_KINDS.map((kind) => [
      kind,
      optionalString(tableObject[kind], `provider.tables.${kind}`, issues),
    ]),
  ) as Record<(typeof TABLE_KINDS)[number], string | null>;

  if (issues.length > 0 || environmentId === null || type === null) {
    throw new EnvironmentConfigError(issues);
  }

  return {
    environmentId,
    provider: {
      bootstrapParent,
      connection: isObject(connection) ? connection : {},
      tables,
      type,
    },
    raw: value,
    schema: "agent-task-manager-environment-v1",
  };
}

export function assertRuntimeReady(config: EnvironmentConfig): void {
  const missing = TABLE_KINDS.filter((kind) => config.provider.tables[kind] === null);
  if (missing.length > 0) {
    throw new EnvironmentConfigError([
      `runtime requires configured table identifiers: ${missing.join(", ")}`,
    ]);
  }
}
