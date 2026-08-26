/** Parses and validates provider environment configuration. */
import type { JsonObject, JsonValue } from "../domain/json.js";
import type { ProviderEnvironment } from "../domain/provider.js";

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
  public constructor(
    /** Ordered configuration diagnostics exposed to programmatic callers. */
    public readonly issues: readonly string[],
  ) {
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
  rejectUnknownConfigKeys(provider, ["module", "options"], "provider", issues);
  /** Import specifier for the selected provider implementation. */
  const module = configString(provider.module, "provider.module", issues);
  /** Opaque provider-owned settings retained as strict JSON. */
  const options = configObject(provider.options, "provider.options", issues);
  if (issues.length > 0) throw new EnvironmentConfigError(issues);
  return {
    environmentId,
    provider: { module, options },
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
