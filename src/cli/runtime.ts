/** Environment and provider construction for CLI invocations. */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseEnvironmentConfig,
  type EnvironmentConfig,
} from "../config/environment.js";
import { createCommandBrokerExecutor } from "../core/command-proxy.js";
import { toJsonValue } from "../domain/json.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import {
  assertAgentTaskProvider,
  parseAgentTaskProviderModule,
  type AgentTaskProviderModule,
} from "../provider/provider-module.js";
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
  /** Absolute configuration path used to resolve local provider modules. */
  const absolutePath = resolve(path);
  /** Strict configuration parsed before module-specifier normalization. */
  const configuration = parseEnvironmentConfig(
    toJsonValue(JSON.parse(await readFile(absolutePath, "utf8")) as unknown),
  );
  return {
    ...configuration,
    provider: {
      ...configuration.provider,
      module: resolveProviderModuleSpecifier(
        configuration.provider.module,
        absolutePath,
      ),
    },
  };
}

/** Loads and validates the configured provider-module descriptor. */
export async function providerModuleFor(
  configuration: EnvironmentConfig,
): Promise<AgentTaskProviderModule> {
  /** Dynamic namespace loaded only from trusted host configuration. */
  const namespace: unknown = await import(configuration.provider.module);
  return parseAgentTaskProviderModule(namespace, configuration.provider.module);
}

/** Creates the provider selected by the environment configuration. */
export async function providerFor(
  configuration: EnvironmentConfig,
  env: NodeJS.ProcessEnv,
): Promise<AgentTaskProvider> {
  /** Validated provider factory loaded from the configured module. */
  const module = await providerModuleFor(configuration);
  /** Provider instance created with opaque settings and trusted host context. */
  const provider: unknown = await module.create({
    environmentId: configuration.environmentId,
    environmentVariables: { ...env },
    options: structuredClone(configuration.provider.options),
  });
  assertAgentTaskProvider(provider, module.type);
  return provider;
}

/** Resolves filesystem modules relative to the environment configuration. */
function resolveProviderModuleSpecifier(
  specifier: string,
  environmentPath: string,
): string {
  if (specifier.startsWith("file:")) return specifier;
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (specifier.startsWith("."))
    return pathToFileURL(resolve(dirname(environmentPath), specifier)).href;
  try {
    /** Resolver rooted beside the environment file for locally installed adapters. */
    const localRequire = createRequire(environmentPath);
    return pathToFileURL(localRequire.resolve(specifier)).href;
  } catch {
    // Preserve bare specifiers so package self-references and global peers resolve.
    return specifier;
  }
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
