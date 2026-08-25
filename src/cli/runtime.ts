/** Environment and provider construction for CLI invocations. */
import { readFile } from "node:fs/promises";

import {
  parseEnvironmentConfig,
  type EnvironmentConfig,
} from "../config/environment.js";
import { createCommandBrokerExecutor } from "../core/command-proxy.js";
import { toJsonValue } from "../domain/json.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { NotionProvider } from "../provider/notion/notion-provider.js";
import { NotionHttpTransport } from "../provider/notion/notion-transport.js";
import { optionalString } from "./input.js";

/** Loads and validates the selected environment configuration file. */
export async function loadEnvironment(
  flag: boolean | string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<EnvironmentConfig> {
  /** Configuration path chosen from flag, environment, or default. */
  const path =
    optionalString(flag) ??
    env.AGENT_TASK_MANAGER_ENVIRONMENT ??
    "agent-task-manager.environment.json";
  return parseEnvironmentConfig(
    toJsonValue(JSON.parse(await readFile(path, "utf8")) as unknown),
  );
}

/** Creates the configured provider after resolving its credentials. */
export function providerFor(
  configuration: EnvironmentConfig,
  env: NodeJS.ProcessEnv,
): AgentTaskProvider {
  if (configuration.provider.type !== "notion")
    throw new Error(`Unsupported provider: ${configuration.provider.type}`);
  /** Environment-variable name holding the Notion token. */
  const tokenVariable =
    typeof configuration.provider.connection.tokenEnv === "string"
      ? configuration.provider.connection.tokenEnv
      : "NOTION_TOKEN";
  /** Notion token resolved from the configured environment variable. */
  const token = env[tokenVariable];
  if (token === undefined || token.trim() === "")
    throw new Error(`Missing Notion token in ${tokenVariable}`);
  return new NotionProvider(
    configuration.provider,
    new NotionHttpTransport({ token }),
  );
}

/** Loads the mandatory host-owned sandbox broker used for Agent commands. */
export function commandBrokerExecutor(env: NodeJS.ProcessEnv) {
  /** Absolute executable path for the trusted sandbox broker. */
  const executable = env.AGENT_TASK_MANAGER_COMMAND_BROKER;
  if (executable === undefined || executable.trim() === "")
    throw new Error(
      "AGENT_TASK_MANAGER_COMMAND_BROKER must name an absolute sandbox broker executable",
    );
  /** Optional cap on combined command output. */
  const maxOutputBytes = optionalPositiveInteger(
    env.AGENT_TASK_MANAGER_COMMAND_MAX_OUTPUT_BYTES,
    "AGENT_TASK_MANAGER_COMMAND_MAX_OUTPUT_BYTES",
  );
  /** Optional command execution timeout. */
  const timeoutMilliseconds = optionalPositiveInteger(
    env.AGENT_TASK_MANAGER_COMMAND_TIMEOUT_MS,
    "AGENT_TASK_MANAGER_COMMAND_TIMEOUT_MS",
  );
  /** Optional grace period between termination signals. */
  const terminationGraceMilliseconds = optionalPositiveInteger(
    env.AGENT_TASK_MANAGER_COMMAND_TERMINATION_GRACE_MS,
    "AGENT_TASK_MANAGER_COMMAND_TERMINATION_GRACE_MS",
  );
  return createCommandBrokerExecutor(executable, [], {
    environment: env,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(terminationGraceMilliseconds === undefined
      ? {}
      : { terminationGraceMilliseconds }),
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
  });
}

/** Parses an optional positive integer environment setting. */
function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  /** Numeric representation of the environment setting. */
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}
