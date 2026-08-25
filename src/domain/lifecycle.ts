/** Strict Agent-owned lifecycle command configuration. */
import { isAbsolute } from "node:path";

/** One trusted, shell-free command run at an Agent lifecycle boundary. */
export interface LifecycleCommandConfig {
  /** Literal arguments passed to the configured executable. */
  readonly arguments: readonly string[];
  /** Explicit environment variables supplied to the executable. */
  readonly environment: Readonly<Record<string, string>>;
  /** Path or normalized name of the executable to run. */
  readonly executable: string;
  /** Names of host variables explicitly inherited by the lifecycle command. */
  readonly inheritEnvironment: readonly string[];
  /** Maximum execution or request duration in milliseconds. */
  readonly timeoutMilliseconds: number;
  /** Absolute execution directory, or null for the host default. */
  readonly workingDirectory: string | null;
}

/** Preparation and cleanup commands declared by one Agent definition. */
export interface AgentLifecycleConfig {
  /** Cleanup commands run after the Agent reaches a terminal state. */
  readonly afterAgent: readonly LifecycleCommandConfig[];
  /** Preparation commands run before an Agent starts. */
  readonly beforeAgent: readonly LifecycleCommandConfig[];
  /** Absolute execution directory, or null for the host default. */
  readonly workingDirectory: string | null;
}

/** Default for Agents that require no host lifecycle preparation. */
export const EMPTY_AGENT_LIFECYCLE: AgentLifecycleConfig = {
  afterAgent: [],
  beforeAgent: [],
  workingDirectory: null,
};

/** Parses an optional Agent lifecycle object and rejects unsafe shapes. */
export function parseAgentLifecycleConfig(
  value: unknown,
): AgentLifecycleConfig {
  if (value === undefined) return EMPTY_AGENT_LIFECYCLE;
  /** Trusted lifecycle executor and context for the run. */
  const lifecycle = object(value, "lifecycleCommands");
  rejectUnknown(lifecycle, ["afterAgent", "beforeAgent", "workingDirectory"]);
  /** Absolute execution directory, or null for the host default. */
  const workingDirectory = nullableTemplate(
    lifecycle.workingDirectory,
    "lifecycleCommands.workingDirectory",
  );
  if (
    workingDirectory !== null &&
    /\{\{(?:failureSummary|outcome|status|workingDirectory)\}\}/u.test(
      workingDirectory,
    )
  )
    throw new TypeError(
      "lifecycleCommands.workingDirectory may use only stable start-context placeholders",
    );
  assertAbsoluteTemplate(
    workingDirectory,
    "lifecycleCommands.workingDirectory",
  );
  return {
    afterAgent: commandArray(
      lifecycle.afterAgent,
      "lifecycleCommands.afterAgent",
    ),
    beforeAgent: commandArray(
      lifecycle.beforeAgent,
      "lifecycleCommands.beforeAgent",
    ),
    workingDirectory,
  };
}

/** Parses an ordered lifecycle-command array. */
function commandArray(value: unknown, path: string): LifecycleCommandConfig[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((entry, index) => {
    /** Diagnostic path of the lifecycle command being parsed. */
    const itemPath = `${path}[${index}]`;
    /** Canonical command key selected from positional arguments. */
    const command = object(entry, itemPath);
    rejectUnknown(command, [
      "arguments",
      "environment",
      "executable",
      "inheritEnvironment",
      "timeoutMilliseconds",
      "workingDirectory",
    ]);
    /** Absolute execution directory, or null for the host default. */
    const workingDirectory = nullableTemplate(
      command.workingDirectory,
      `${itemPath}.workingDirectory`,
    );
    assertAbsoluteTemplate(workingDirectory, `${itemPath}.workingDirectory`);
    return {
      arguments: stringArray(command.arguments, `${itemPath}.arguments`).map(
        (argument, argumentIndex) =>
          template(argument, `${itemPath}.arguments[${argumentIndex}]`),
      ),
      environment: environmentMap(
        command.environment,
        `${itemPath}.environment`,
      ),
      executable: template(
        text(command.executable, `${itemPath}.executable`),
        `${itemPath}.executable`,
      ),
      inheritEnvironment: environmentNames(
        command.inheritEnvironment,
        `${itemPath}.inheritEnvironment`,
      ),
      timeoutMilliseconds: positiveInteger(
        command.timeoutMilliseconds,
        `${itemPath}.timeoutMilliseconds`,
      ),
      workingDirectory,
    };
  });
}

/** Requires and returns a plain object at an untyped boundary. */
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

/** Requires a JSON string and preserves the empty-string contract. */
function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new TypeError(`${path} must be a non-empty string`);
  return value.normalize("NFC");
}

/** Parses an optional lifecycle path template. */
function nullableTemplate(value: unknown, path: string): string | null {
  if (value === null) return null;
  return template(text(value, path), path);
}

/** Parses a normalized string array at an untyped boundary. */
function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((entry, index) => text(entry, `${path}[${index}]`));
}

/** Parses explicit lifecycle environment variables. */
function environmentMap(
  value: unknown,
  path: string,
): Readonly<Record<string, string>> {
  /** Ordered entries being validated or transformed. */
  const entries = object(value, path);
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => {
      assertEnvironmentName(key, `${path}.${key}`);
      return [key, template(text(entry, `${path}.${key}`), `${path}.${key}`)];
    }),
  );
}

/** Parses and validates inherited environment-variable names. */
function environmentNames(value: unknown, path: string): string[] {
  /** Environment-variable names requested by the lifecycle command. */
  const names = stringArray(value, path);
  for (const name of names) assertEnvironmentName(name, path);
  if (new Set(names).size !== names.length)
    throw new TypeError(`${path} must not contain duplicates`);
  return names;
}

/** Requires a portable environment-variable name. */
function assertEnvironmentName(value: string, path: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    throw new TypeError(
      `${path} contains an invalid environment variable name`,
    );
}

/** Requires a positive safe integer at the configuration boundary. */
function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${path} must be a positive integer`);
  return value;
}

/** Placeholders accepted by lifecycle command templates. */
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

/** Renders and validates a lifecycle placeholder template. */
function template(value: string, path: string): string {
  /** Ordered placeholders used by template. */
  const placeholders = [...value.matchAll(/\{\{([A-Za-z]+)\}\}/gu)];
  for (const match of placeholders)
    if (!TEMPLATE_FIELDS.has(match[1]!))
      throw new TypeError(`${path} uses unsupported placeholder: ${match[0]}`);
  /** Template suffix checked for malformed placeholder delimiters. */
  const remainder = value.replaceAll(/\{\{[A-Za-z]+\}\}/gu, "");
  if (remainder.includes("{{") || remainder.includes("}}"))
    throw new TypeError(`${path} contains a malformed placeholder`);
  return value;
}

/** Requires a path template to remain absolute after placeholder substitution. */
function assertAbsoluteTemplate(value: string | null, path: string): void {
  if (
    value !== null &&
    !isAbsolute(value.replaceAll(/\{\{[A-Za-z]+\}\}/gu, "value"))
  )
    throw new TypeError(`${path} must render as an absolute path`);
}

/** Rejects object keys outside the boundary's explicit allowlist. */
function rejectUnknown(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  /** Distinct values tracked by reject unknown. */
  const supported = new Set(allowed);
  /** Unsupported keys discovered at the strict input boundary. */
  const unknown = Object.keys(value).filter((key) => !supported.has(key));
  if (unknown.length !== 0)
    throw new TypeError(
      `Lifecycle configuration contains unsupported fields: ${unknown.join(", ")}`,
    );
}
