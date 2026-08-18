/** Parses the deliberately small v2 environment configuration. */
import type { JsonObject, JsonValue } from "../domain/json.js";
import { TABLE_KINDS, type ProviderEnvironment } from "../domain/provider.js";

export interface EnvironmentConfig {
  readonly environmentId: string;
  readonly provider: ProviderEnvironment;
  readonly raw: JsonObject;
  readonly schema: "agent-task-manager-environment-v2";
}
export class EnvironmentConfigError extends TypeError {
  public constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
  }
}

export function parseEnvironmentConfig(value: JsonValue): EnvironmentConfig {
  const issues: string[] = [];
  const root = object(value, "root", issues);
  rejectUnknown(root, ["schema", "environmentId", "provider"], "root", issues);
  if (root.schema !== "agent-task-manager-environment-v2")
    issues.push("schema must equal agent-task-manager-environment-v2");
  const environmentId = string(root.environmentId, "environmentId", issues);
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
    schema: "agent-task-manager-environment-v2",
  };
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
