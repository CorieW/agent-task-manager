import type { JsonObject, JsonValue } from "../domain/json.js";
import { TABLE_KINDS, type ProviderEnvironment } from "../domain/provider.js";

export interface EnvironmentConfig {
  readonly adapters: RuntimeAdapterConfig | null;
  readonly environmentId: string;
  readonly provider: ProviderEnvironment;
  readonly raw: JsonObject;
  readonly runtime: RuntimeEnvironmentConfig | null;
  readonly schema: "agent-task-manager-environment-v1";
}

export interface RuntimeAdapterConfig {
  readonly agentRunner: string;
  readonly modelTransport: string;
  readonly publication: string | null;
  readonly sandbox: string;
}

export interface RuntimeEnvironmentConfig {
  readonly allowedEnvironmentNames: readonly string[];
  readonly allowedNetworkOrigins: readonly string[];
  readonly allowedReadRoots: readonly string[];
  readonly allowedWriteRoots: readonly string[];
  readonly concurrencyMode: "single-host";
  readonly outputLimitBytes: number;
  readonly postKillReapMilliseconds: number;
  readonly root: string;
  readonly terminationGraceMilliseconds: number;
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

function positiveInteger(value: JsonValue | undefined, path: string, issues: string[]): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    issues.push(`${path} must be a positive integer`);
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

  const adapters = parseRuntimeAdapterConfig(value.adapters, issues);
  const runtime = parseRuntimeEnvironmentConfig(value.runtime, issues);

  if (issues.length > 0 || environmentId === null || type === null) {
    throw new EnvironmentConfigError(issues);
  }

  return {
    adapters,
    environmentId,
    provider: {
      bootstrapParent,
      connection: isObject(connection) ? connection : {},
      tables,
      type,
    },
    raw: value,
    runtime,
    schema: "agent-task-manager-environment-v1",
  };
}

function parseRuntimeAdapterConfig(value: JsonValue | undefined, issues: string[]): RuntimeAdapterConfig | null {
  if (value !== undefined && !isObject(value)) { issues.push("adapters must be an object"); return null; }
  if (!isObject(value)) return null;
  rejectUnknownKeys(value, ["agentRunner", "modelTransport", "publication", "sandbox"], "adapters", issues);
  const agentRunner = requiredString(value.agentRunner, "adapters.agentRunner", issues);
  const modelTransport = requiredString(value.modelTransport, "adapters.modelTransport", issues);
  const sandbox = requiredString(value.sandbox, "adapters.sandbox", issues);
  const publication = optionalString(value.publication, "adapters.publication", issues);
  return agentRunner === null || modelTransport === null || sandbox === null ? null : { agentRunner, modelTransport, publication, sandbox };
}

function parseRuntimeEnvironmentConfig(value: JsonValue | undefined, issues: string[]): RuntimeEnvironmentConfig | null {
  if (value !== undefined && !isObject(value)) { issues.push("runtime must be an object"); return null; }
  if (!isObject(value)) return null;
  const keys = ["allowedEnvironmentNames", "allowedNetworkOrigins", "allowedReadRoots", "allowedWriteRoots", "concurrencyMode", "outputLimitBytes", "postKillReapMilliseconds", "root", "terminationGraceMilliseconds"];
  rejectUnknownKeys(value, keys, "runtime", issues);
  const root = requiredString(value.root, "runtime.root", issues);
  const outputLimitBytes = positiveInteger(value.outputLimitBytes, "runtime.outputLimitBytes", issues);
  const postKillReapMilliseconds = positiveInteger(value.postKillReapMilliseconds, "runtime.postKillReapMilliseconds", issues);
  const terminationGraceMilliseconds = positiveInteger(value.terminationGraceMilliseconds, "runtime.terminationGraceMilliseconds", issues);
  const allowedEnvironmentNames = stringArray(value.allowedEnvironmentNames, "runtime.allowedEnvironmentNames", issues);
  const allowedNetworkOrigins = stringArray(value.allowedNetworkOrigins, "runtime.allowedNetworkOrigins", issues);
  const allowedReadRoots = stringArray(value.allowedReadRoots, "runtime.allowedReadRoots", issues);
  const allowedWriteRoots = stringArray(value.allowedWriteRoots, "runtime.allowedWriteRoots", issues);
  if (value.concurrencyMode !== "single-host") issues.push("runtime.concurrencyMode must equal single-host");
  if (root === null || outputLimitBytes === null || postKillReapMilliseconds === null || terminationGraceMilliseconds === null || value.concurrencyMode !== "single-host") return null;
  return { allowedEnvironmentNames, allowedNetworkOrigins, allowedReadRoots, allowedWriteRoots, concurrencyMode: "single-host", outputLimitBytes, postKillReapMilliseconds, root, terminationGraceMilliseconds };
}

function stringArray(value: JsonValue | undefined, path: string, issues: string[]): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) { issues.push(`${path} must contain non-empty strings`); return []; }
  const result = value as string[];
  if (new Set(result).size !== result.length) issues.push(`${path} must not contain duplicates`);
  return [...result];
}

export function assertRuntimeReady(config: EnvironmentConfig): void {
  const missing = TABLE_KINDS.filter((kind) => config.provider.tables[kind] === null);
  if (missing.length > 0) {
    throw new EnvironmentConfigError([
      `runtime requires configured table identifiers: ${missing.join(", ")}`,
    ]);
  }
  const runtimeIssues: string[] = [];
  if (config.adapters === null) runtimeIssues.push("runtime requires adapters.agentRunner, adapters.modelTransport, and adapters.sandbox");
  if (config.runtime === null) runtimeIssues.push("runtime requires a closed runtime definition");
  if (runtimeIssues.length > 0) throw new EnvironmentConfigError(runtimeIssues);
}
