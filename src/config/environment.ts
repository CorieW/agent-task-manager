/** Parses the closed environment definition that supplies trusted provider, runtime-adapter, and external-effect configuration. */
import type { JsonObject, JsonValue } from "../domain/json.js";
import { TABLE_KINDS, type ProviderEnvironment } from "../domain/provider.js";
import {
  EXTERNAL_EFFECT_KINDS,
  type ExternalEffectKind,
} from "../effects/typed-effect-handlers.js";

/** Validated configuration for environment. */
export interface EnvironmentConfig {
  /** Runtime adapter identifiers selected by the environment. */
  readonly adapters: RuntimeAdapterConfig | null;
  /** Stable identifier for environment. */
  readonly environmentId: string;
  /** External-effect handler configuration. */
  readonly effects: ExternalEffectEnvironmentConfig;
  /** Provider type, connection, and table configuration. */
  readonly provider: ProviderEnvironment;
  /** Validated source object retained for safe environment patching. */
  readonly raw: JsonObject;
  /** Runtime isolation and process limits. */
  readonly runtime: RuntimeEnvironmentConfig | null;
  /** Schema discriminator for the serialized representation. */
  readonly schema: "agent-task-manager-environment-v1";
}

/** Validated configuration for external effect environment. */
export interface ExternalEffectEnvironmentConfig {
  /** Handler identifier selected for each external-effect intent. */
  readonly handlers: Readonly<Partial<Record<ExternalEffectKind, string>>>;
  /** Handler-specific settings keyed by handler identifier. */
  readonly settings: Readonly<Record<string, JsonObject>>;
}

/** Validated configuration for runtime adapter. */
export interface RuntimeAdapterConfig {
  /** Adapter used to start agent processes. */
  readonly agentRunner: string;
  /** Adapter used to invoke model providers. */
  readonly modelTransport: string;
  /** Adapter used to publish external results. */
  readonly publication: string | null;
  /** Adapter used to enforce child-process isolation. */
  readonly sandbox: string;
}

/** Validated configuration for runtime environment. */
export interface RuntimeEnvironmentConfig {
  /** Environment-variable names exposed to child processes. */
  readonly allowedEnvironmentNames: readonly string[];
  /** Network origins child processes may access. */
  readonly allowedNetworkOrigins: readonly string[];
  /** Filesystem roots child processes may read. */
  readonly allowedReadRoots: readonly string[];
  /** Filesystem roots child processes may modify. */
  readonly allowedWriteRoots: readonly string[];
  /** Concurrency strategy used by the runtime. */
  readonly concurrencyMode: "single-host";
  /** Maximum captured child-process output in bytes. */
  readonly outputLimitBytes: number;
  /** Post kill reap duration in milliseconds. */
  readonly postKillReapMilliseconds: number;
  /** Workspace root exposed to runtime adapters. */
  readonly root: string;
  /** Termination grace duration in milliseconds. */
  readonly terminationGraceMilliseconds: number;
}
/** Validated configuration for runtime ready environment. */
export interface RuntimeReadyEnvironmentConfig extends EnvironmentConfig {
  /** Runtime adapter identifiers selected by the environment. */
  readonly adapters: RuntimeAdapterConfig;
  /** Runtime configuration proven compatible with real adapters. */
  readonly runtime: RuntimeEnvironmentConfig;
}

/** Error raised when environment config validation fails. */
export class EnvironmentConfigError extends TypeError {
  /** Creates an error containing every environment validation issue. */
  public constructor(
    /** Validation issues; empty when validation succeeds. */ public readonly issues: readonly string[],
  ) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
  }
}

/** Reports whether a value is a non-array object. */
function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Returns an optional string field after validating its type. */
function optionalString(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string or null`);
    return null;
  }
  return value;
}

/** Requires a non-empty string field value. */
function requiredString(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be a non-empty string`);
    return null;
  }
  return value;
}

/** Requires a positive safe integer field value. */
function positiveInteger(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    issues.push(`${path} must be a positive integer`);
    return null;
  }
  return value;
}

/** Adds validation issues for fields outside the allowed key set. */
function rejectUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  /** Allowed field names used to detect unknown configuration. */
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) issues.push(`${path}.${key} is not allowed`);
  }
}

/** Parses and validates the complete provider and runtime environment definition. */
export function parseEnvironmentConfig(value: JsonValue): EnvironmentConfig {
  /** Validation issues collected during this operation. */
  const issues: string[] = [];
  if (!isObject(value))
    throw new EnvironmentConfigError(["root must be an object"]);
  rejectUnknownKeys(
    value,
    [
      "adapters",
      "effects",
      "environmentId",
      "provider",
      "repository",
      "runtime",
      "schema",
    ],
    "root",
    issues,
  );

  /** Schema used during parse environment config. */
  const schema = value.schema;
  if (schema !== "agent-task-manager-environment-v1") {
    issues.push("schema must equal agent-task-manager-environment-v1");
  }

  /** Environment ID used during parse environment config. */
  const environmentId = requiredString(
    value.environmentId,
    "environmentId",
    issues,
  );
  /** Raw provider field before object validation. */
  const providerValue = value.provider;
  if (!isObject(providerValue)) {
    issues.push("provider must be an object");
  }

  /** Provider used during parse environment config. */
  const provider = isObject(providerValue) ? providerValue : {};
  rejectUnknownKeys(
    provider,
    ["bootstrapParent", "connection", "tables", "type"],
    "provider",
    issues,
  );
  /** Type used during parse environment config. */
  const type = requiredString(provider.type, "provider.type", issues);
  /** Bootstrap parent used during parse environment config. */
  const bootstrapParent = optionalString(
    provider.bootstrapParent,
    "provider.bootstrapParent",
    issues,
  );

  /** Connection used during parse environment config. */
  const connection = provider.connection;
  if (!isObject(connection))
    issues.push("provider.connection must be an object");
  /** Raw provider-tables field before object validation. */
  const tablesValue = provider.tables;
  if (!isObject(tablesValue)) issues.push("provider.tables must be an object");
  /** Table object used during parse environment config. */
  const tableObject = isObject(tablesValue) ? tablesValue : {};
  rejectUnknownKeys(tableObject, TABLE_KINDS, "provider.tables", issues);
  for (const kind of TABLE_KINDS) {
    if (!Object.hasOwn(tableObject, kind))
      issues.push(`provider.tables.${kind} is required`);
  }
  /** Tables used during parse environment config. */
  const tables = Object.fromEntries(
    TABLE_KINDS.map((kind) => [
      kind,
      optionalString(tableObject[kind], `provider.tables.${kind}`, issues),
    ]),
  ) as Record<(typeof TABLE_KINDS)[number], string | null>;

  /** Adapters used during parse environment config. */
  const adapters = parseRuntimeAdapterConfig(value.adapters, issues);
  /** Runtime used during parse environment config. */
  const runtime = parseRuntimeEnvironmentConfig(value.runtime, issues);
  /** Effects used during parse environment config. */
  const effects = parseExternalEffectConfig(value.effects, issues);

  if (issues.length > 0 || environmentId === null || type === null) {
    throw new EnvironmentConfigError(issues);
  }

  return {
    adapters,
    effects,
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

/** Parses external-effect handler configuration and rejects unknown fields. */
function parseExternalEffectConfig(
  value: JsonValue | undefined,
  issues: string[],
): ExternalEffectEnvironmentConfig {
  if (value === undefined) return { handlers: {}, settings: {} };
  if (!isObject(value)) {
    issues.push("effects must be an object");
    return { handlers: {}, settings: {} };
  }
  rejectUnknownKeys(value, ["handlers", "settings"], "effects", issues);
  if (!isObject(value.handlers)) {
    issues.push("effects.handlers must be an object");
    return { handlers: {}, settings: {} };
  }
  rejectUnknownKeys(
    value.handlers,
    EXTERNAL_EFFECT_KINDS,
    "effects.handlers",
    issues,
  );
  /** Handlers used during parse external effect config. */
  const handlers: Partial<Record<ExternalEffectKind, string>> = {};
  for (const kind of EXTERNAL_EFFECT_KINDS) {
    /** Configured used during parse external effect config. */
    const configured = value.handlers[kind];
    if (configured !== undefined) {
      /** Non-empty handler identifier selected for this intent. */
      const id = requiredString(configured, `effects.handlers.${kind}`, issues);
      if (id !== null) handlers[kind] = id;
    }
  }
  /** Raw effect-settings field before object validation. */
  const settingsValue = value.settings;
  if (!isObject(settingsValue))
    issues.push("effects.settings must be an object");
  /** Settings used during parse external effect config. */
  const settings: Record<string, JsonObject> = {};
  if (isObject(settingsValue)) {
    for (const [adapterId, adapterSettings] of Object.entries(settingsValue)) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(adapterId) ||
        !isObject(adapterSettings)
      )
        issues.push(
          `effects.settings.${adapterId} must identify one adapter settings object`,
        );
      else settings[adapterId] = adapterSettings;
    }
  }
  return { handlers, settings };
}

/** Parses the selected runtime adapter identifiers. */
function parseRuntimeAdapterConfig(
  value: JsonValue | undefined,
  issues: string[],
): RuntimeAdapterConfig | null {
  if (value !== undefined && !isObject(value)) {
    issues.push("adapters must be an object");
    return null;
  }
  if (!isObject(value)) return null;
  rejectUnknownKeys(
    value,
    ["agentRunner", "modelTransport", "publication", "sandbox"],
    "adapters",
    issues,
  );
  /** Agent runner used during parse runtime adapter config. */
  const agentRunner = requiredString(
    value.agentRunner,
    "adapters.agentRunner",
    issues,
  );
  /** Model transport used during parse runtime adapter config. */
  const modelTransport = requiredString(
    value.modelTransport,
    "adapters.modelTransport",
    issues,
  );
  /** Sandbox used during parse runtime adapter config. */
  const sandbox = requiredString(value.sandbox, "adapters.sandbox", issues);
  /** Publication used during parse runtime adapter config. */
  const publication = optionalString(
    value.publication,
    "adapters.publication",
    issues,
  );
  return agentRunner === null || modelTransport === null || sandbox === null
    ? null
    : { agentRunner, modelTransport, publication, sandbox };
}

/** Parses runtime isolation, output, and termination limits. */
function parseRuntimeEnvironmentConfig(
  value: JsonValue | undefined,
  issues: string[],
): RuntimeEnvironmentConfig | null {
  if (value !== undefined && !isObject(value)) {
    issues.push("runtime must be an object");
    return null;
  }
  if (!isObject(value)) return null;
  /** Keys used during parse runtime environment config. */
  const keys = [
    "allowedEnvironmentNames",
    "allowedNetworkOrigins",
    "allowedReadRoots",
    "allowedWriteRoots",
    "concurrencyMode",
    "outputLimitBytes",
    "postKillReapMilliseconds",
    "root",
    "terminationGraceMilliseconds",
  ];
  rejectUnknownKeys(value, keys, "runtime", issues);
  /** Root used during parse runtime environment config. */
  const root = requiredString(value.root, "runtime.root", issues);
  /** Output limit bytes used during parse runtime environment config. */
  const outputLimitBytes = positiveInteger(
    value.outputLimitBytes,
    "runtime.outputLimitBytes",
    issues,
  );
  /** Post kill reap milliseconds used during parse runtime environment config. */
  const postKillReapMilliseconds = positiveInteger(
    value.postKillReapMilliseconds,
    "runtime.postKillReapMilliseconds",
    issues,
  );
  /** Termination grace milliseconds used during parse runtime environment config. */
  const terminationGraceMilliseconds = positiveInteger(
    value.terminationGraceMilliseconds,
    "runtime.terminationGraceMilliseconds",
    issues,
  );
  /** Allowed environment names used during parse runtime environment config. */
  const allowedEnvironmentNames = stringArray(
    value.allowedEnvironmentNames,
    "runtime.allowedEnvironmentNames",
    issues,
  );
  /** Allowed network origins used during parse runtime environment config. */
  const allowedNetworkOrigins = stringArray(
    value.allowedNetworkOrigins,
    "runtime.allowedNetworkOrigins",
    issues,
  );
  /** Allowed read roots used during parse runtime environment config. */
  const allowedReadRoots = stringArray(
    value.allowedReadRoots,
    "runtime.allowedReadRoots",
    issues,
  );
  /** Allowed write roots used during parse runtime environment config. */
  const allowedWriteRoots = stringArray(
    value.allowedWriteRoots,
    "runtime.allowedWriteRoots",
    issues,
  );
  if (value.concurrencyMode !== "single-host")
    issues.push("runtime.concurrencyMode must equal single-host");
  if (
    root === null ||
    outputLimitBytes === null ||
    postKillReapMilliseconds === null ||
    terminationGraceMilliseconds === null ||
    value.concurrencyMode !== "single-host"
  )
    return null;
  return {
    allowedEnvironmentNames,
    allowedNetworkOrigins,
    allowedReadRoots,
    allowedWriteRoots,
    concurrencyMode: "single-host",
    outputLimitBytes,
    postKillReapMilliseconds,
    root,
    terminationGraceMilliseconds,
  };
}

/** Requires an array containing only strings. */
function stringArray(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    issues.push(`${path} must contain non-empty strings`);
    return [];
  }
  /** Result produced by string array. */
  const result = value as string[];
  if (new Set(result).size !== result.length)
    issues.push(`${path} must not contain duplicates`);
  return [...result];
}

/** Rejects configuration that still requires real runtime adapters or effect handlers. */
export function assertRuntimeReady(
  config: EnvironmentConfig,
): asserts config is RuntimeReadyEnvironmentConfig {
  /** Runtime adapter and handler slots still configured as no-tool placeholders. */
  const missing = TABLE_KINDS.filter(
    (kind) => config.provider.tables[kind] === null,
  );
  if (missing.length > 0) {
    throw new EnvironmentConfigError([
      `runtime requires configured table identifiers: ${missing.join(", ")}`,
    ]);
  }
  /** Runtime safety settings that prevent real adapter execution. */
  const runtimeIssues: string[] = [];
  if (config.adapters === null)
    runtimeIssues.push(
      "runtime requires adapters.agentRunner, adapters.modelTransport, and adapters.sandbox",
    );
  if (config.runtime === null)
    runtimeIssues.push("runtime requires a closed runtime definition");
  if (runtimeIssues.length > 0) throw new EnvironmentConfigError(runtimeIssues);
}
