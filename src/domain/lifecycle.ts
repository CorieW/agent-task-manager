/** Strict Agent-owned lifecycle command configuration. */
import { isAbsolute } from "node:path";

/** One trusted, shell-free command run at an Agent lifecycle boundary. */
export interface LifecycleCommandConfig {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly inheritEnvironment: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly workingDirectory: string | null;
}

/** Preparation and cleanup commands declared by one Agent definition. */
export interface AgentLifecycleConfig {
  readonly afterAgent: readonly LifecycleCommandConfig[];
  readonly beforeAgent: readonly LifecycleCommandConfig[];
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
  const lifecycle = object(value, "lifecycleCommands");
  rejectUnknown(lifecycle, ["afterAgent", "beforeAgent", "workingDirectory"]);
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

function commandArray(value: unknown, path: string): LifecycleCommandConfig[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const command = object(entry, itemPath);
    rejectUnknown(command, [
      "arguments",
      "environment",
      "executable",
      "inheritEnvironment",
      "timeoutMilliseconds",
      "workingDirectory",
    ]);
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

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new TypeError(`${path} must be a non-empty string`);
  return value.normalize("NFC");
}

function nullableTemplate(value: unknown, path: string): string | null {
  if (value === null) return null;
  return template(text(value, path), path);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((entry, index) => text(entry, `${path}[${index}]`));
}

function environmentMap(
  value: unknown,
  path: string,
): Readonly<Record<string, string>> {
  const entries = object(value, path);
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => {
      assertEnvironmentName(key, `${path}.${key}`);
      return [key, template(text(entry, `${path}.${key}`), `${path}.${key}`)];
    }),
  );
}

function environmentNames(value: unknown, path: string): string[] {
  const names = stringArray(value, path);
  for (const name of names) assertEnvironmentName(name, path);
  if (new Set(names).size !== names.length)
    throw new TypeError(`${path} must not contain duplicates`);
  return names;
}

function assertEnvironmentName(value: string, path: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    throw new TypeError(
      `${path} contains an invalid environment variable name`,
    );
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${path} must be a positive integer`);
  return value;
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

function template(value: string, path: string): string {
  const placeholders = [...value.matchAll(/\{\{([A-Za-z]+)\}\}/gu)];
  for (const match of placeholders)
    if (!TEMPLATE_FIELDS.has(match[1]!))
      throw new TypeError(`${path} uses unsupported placeholder: ${match[0]}`);
  const remainder = value.replaceAll(/\{\{[A-Za-z]+\}\}/gu, "");
  if (remainder.includes("{{") || remainder.includes("}}"))
    throw new TypeError(`${path} contains a malformed placeholder`);
  return value;
}

function assertAbsoluteTemplate(value: string | null, path: string): void {
  if (
    value !== null &&
    !isAbsolute(value.replaceAll(/\{\{[A-Za-z]+\}\}/gu, "value"))
  )
    throw new TypeError(`${path} must render as an absolute path`);
}

function rejectUnknown(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const supported = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !supported.has(key));
  if (unknown.length !== 0)
    throw new TypeError(
      `Lifecycle configuration contains unsupported fields: ${unknown.join(", ")}`,
    );
}
