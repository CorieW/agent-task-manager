/** Parses and validates provider environment configuration. */
import type { JsonObject, JsonValue } from "../domain/json.js";
import { TABLE_KINDS, type ProviderEnvironment } from "../domain/provider.js";

/** Validated v1 environment configuration and its original JSON value. */
export interface EnvironmentConfig {
  /** Stable identity used to isolate one managed environment. */
  readonly environmentId: string;
  /** Provider implementation that owns persistence for this invocation. */
  readonly provider: ProviderEnvironment;
  /** Untrusted environment or provider payload before strict parsing. */
  readonly raw: JsonObject;
  /** Versioned schema identifier for the serialized object. */
  readonly schema: "agent-task-manager-environment-v1";
}

/** Aggregates all problems found while parsing environment configuration. */
export class EnvironmentConfigError extends TypeError {
  /** Creates an aggregate error from all configuration issues. */
  public constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
  }
}

/** Strictly parses v1 environment JSON, rejecting unknown or missing fields. */
export function parseEnvironmentConfig(value: JsonValue): EnvironmentConfig {
  /** Validation issues accumulated without failing the remaining checks. */
  const issues: string[] = [];
  /** Root object at the untrusted JSON boundary. */
  const root = configObject(value, "root", issues);
  rejectUnknownConfigKeys(
    root,
    ["schema", "environmentId", "provider"],
    "root",
    issues,
  );
  if (root.schema !== "agent-task-manager-environment-v1")
    issues.push("schema must equal agent-task-manager-environment-v1");
  /** Stable identity used to isolate one managed environment. */
  const environmentId = configString(
    root.environmentId,
    "environmentId",
    issues,
  );
  /** Unvalidated provider settings object. */
  const provider = configObject(root.provider, "provider", issues);
  rejectUnknownConfigKeys(
    provider,
    ["type", "connection", "bootstrapParent", "tables"],
    "provider",
    issues,
  );
  /** Provider implementation discriminator. */
  const type = configString(provider.type, "provider.type", issues);
  /** Provider connection settings retained as strict JSON. */
  const connection = configObject(
    provider.connection,
    "provider.connection",
    issues,
  );
  /** Optional Notion page under which managed databases may be created. */
  const parent = nullableConfigString(
    provider.bootstrapParent,
    "provider.bootstrapParent",
    issues,
  );
  /** Untyped table mapping before strict ID validation. */
  const tableObject = configObject(provider.tables, "provider.tables", issues);
  rejectUnknownConfigKeys(tableObject, TABLE_KINDS, "provider.tables", issues);
  /** Configured Notion data-source IDs keyed by managed table. */
  const tables = Object.fromEntries(
    TABLE_KINDS.map((kind) => [
      kind,
      nullableConfigString(
        tableObject[kind],
        `provider.tables.${kind}`,
        issues,
      ),
    ]),
  ) as Record<(typeof TABLE_KINDS)[number], string | null>;
  if (issues.length > 0) throw new EnvironmentConfigError(issues);
  return {
    environmentId,
    provider: { bootstrapParent: parent, connection, tables, type },
    raw: root,
    schema: "agent-task-manager-environment-v1",
  };
}

/** Requires and returns a plain object at an untyped boundary. */
function configObject(
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

/** Requires a non-empty configuration string. */
function configString(
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

/** Parses an optional nullable configuration string. */
function nullableConfigString(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): string | null {
  if (value === null) return null;
  return configString(value, path, issues);
}

/** Rejects object keys outside the boundary's explicit allowlist. */
function rejectUnknownConfigKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  /** Allowlisted keys accepted by the current boundary. */
  const keys = new Set(allowed);
  for (const key of Object.keys(value))
    if (!keys.has(key)) issues.push(`${path}.${key} is not allowed`);
}
