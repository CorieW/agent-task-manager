/** Resolves exact adapters and compiles tool authority only from trusted environment configuration. */
import { isAbsolute, parse, relative, resolve } from "node:path";

import type { EnvironmentConfig, RuntimeEnvironmentConfig } from "../config/environment.js";
import { assertRuntimeReady } from "../config/environment.js";
import type { CapabilityGrant } from "../core/capability-compiler.js";
import { digestJson } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { AgentRunnerAdapter, ModelTransportAdapter, ToolIsolationAdapter, ToolIsolationPolicy } from "./adapters.js";
import { RuntimeAdapterRegistry } from "./adapters.js";

export interface ResolvedRuntimeEnvironment {
  readonly config: RuntimeEnvironmentConfig;
  readonly digest: string;
  readonly modelTransport: ModelTransportAdapter;
  readonly runner: AgentRunnerAdapter;
  readonly toolIsolation: ToolIsolationAdapter;
}

export function resolveRuntimeEnvironment(input: {
  readonly config: EnvironmentConfig;
  readonly modelTransports: RuntimeAdapterRegistry<ModelTransportAdapter>;
  readonly runners: RuntimeAdapterRegistry<AgentRunnerAdapter>;
  readonly toolIsolations: RuntimeAdapterRegistry<ToolIsolationAdapter>;
}): ResolvedRuntimeEnvironment {
  assertRuntimeReady(input.config);
  const adapters = input.config.adapters;
  const runtime = input.config.runtime;
  const normalized = normalizeRuntimeConfig(runtime);
  return {
    config: normalized,
    digest: digestJson(toJsonValue({ adapters, environmentId: input.config.environmentId, runtime: normalized })),
    modelTransport: input.modelTransports.get(adapters.modelTransport),
    runner: input.runners.get(adapters.agentRunner),
    toolIsolation: input.toolIsolations.get(adapters.sandbox),
  };
}

export function compileToolIsolationPolicy(input: {
  readonly grant: CapabilityGrant;
  readonly runId: string;
  readonly runtime: ResolvedRuntimeEnvironment;
}): ToolIsolationPolicy {
  if (input.runId === "") throw new TypeError("Runtime run ID is required");
  const capabilities = new Set(input.grant.capabilities);
  const mayReadRepository = capabilities.has("repository.read") || capabilities.has("repository.write");
  const mayWriteRepository = capabilities.has("repository.write");
  const mayUseNetwork = capabilities.has("network.access");
  const mayReadEnvironment = capabilities.has("environment.read");
  return {
    allowedEnvironmentNames: mayReadEnvironment ? input.runtime.config.allowedEnvironmentNames : [],
    allowedReadRoots: mayReadRepository ? input.runtime.config.allowedReadRoots : [],
    allowedWriteRoots: mayWriteRepository ? input.runtime.config.allowedWriteRoots : [],
    network: mayUseNetwork && input.runtime.config.allowedNetworkOrigins.length > 0
      ? { allowedOrigins: input.runtime.config.allowedNetworkOrigins, mode: "allowlist" }
      : { allowedOrigins: [], mode: "none" },
    runId: input.runId,
  };
}

function normalizeRuntimeConfig(config: RuntimeEnvironmentConfig): RuntimeEnvironmentConfig {
  const root = canonicalRoot(config.root, "runtime.root");
  const allowedReadRoots = normalizedUnique(config.allowedReadRoots.map((value) => canonicalRoot(value, "runtime.allowedReadRoots")));
  const allowedWriteRoots = normalizedUnique(config.allowedWriteRoots.map((value) => canonicalRoot(value, "runtime.allowedWriteRoots")));
  for (const candidate of allowedWriteRoots) if (!contains(root, candidate)) throw new Error(`Runtime write root must be contained by runtime.root: ${candidate}`);
  const secretName = /(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu;
  for (const name of config.allowedEnvironmentNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || secretName.test(name)) throw new Error(`Runtime environment name is unsafe: ${name}`);
  }
  const allowedEnvironmentNames = normalizedUnique(config.allowedEnvironmentNames);
  const allowedNetworkOrigins = normalizedUnique(config.allowedNetworkOrigins.map(normalizeOrigin));
  return { ...config, allowedEnvironmentNames, allowedNetworkOrigins, allowedReadRoots, allowedWriteRoots, root };
}

function canonicalRoot(value: string, label: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute: ${value}`);
  const result = resolve(value);
  if (result === parse(result).root) throw new Error(`${label} cannot be a filesystem root`);
  return result;
}
function contains(parent: string, child: string): boolean {
  const found = relative(parent, child);
  return found === "" || found !== ".." && !found.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(found);
}
function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new TypeError(`Runtime network origin is invalid: ${value}`);
  return url.origin;
}
function normalizedUnique(values: readonly string[]): readonly string[] {
  const normalized = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const keys = normalized.map((value) => process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value);
  if (new Set(keys).size !== keys.length) throw new Error("Runtime boundary values must be unique after normalization");
  return normalized;
}
