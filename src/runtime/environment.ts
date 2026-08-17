/** Resolves exact adapters and compiles tool authority only from trusted environment configuration. */
import { isAbsolute, parse, relative, resolve } from "node:path";

import type {
  EnvironmentConfig,
  RuntimeEnvironmentConfig,
} from "../config/environment.js";
import { assertRuntimeReady } from "../config/environment.js";
import type { CapabilityGrant } from "../core/capability-compiler.js";
import { digestJson } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type {
  AgentRunnerAdapter,
  ModelTransportAdapter,
  ToolIsolationAdapter,
  ToolIsolationPolicy,
} from "./adapters.js";
import type { RuntimeAdapterRegistry } from "./adapters.js";

/** Trusted dependencies available to resolved runtime. */
export interface ResolvedRuntimeEnvironment {
  /** Validated configuration owned by the effect implementation. */
  readonly config: RuntimeEnvironmentConfig;
  /** SHA-256 digest binding the canonical content. */
  readonly digest: string;
  /** Provides model transport to resolved runtime environment. */
  readonly modelTransport: ModelTransportAdapter;
  /** Runner used to execute the requested workload. */
  readonly runner: AgentRunnerAdapter;
  /** Provides tool isolation to resolved runtime environment. */
  readonly toolIsolation: ToolIsolationAdapter;
}

/** Resolves runtime environment from trusted configuration. */
export function resolveRuntimeEnvironment(input: {
  /** Validated configuration owned by the effect implementation. */
  readonly config: EnvironmentConfig;
  /** Provides model transports to resolve runtime environment. */
  readonly modelTransports: RuntimeAdapterRegistry<ModelTransportAdapter>;
  /** Provides runners to resolve runtime environment. */
  readonly runners: RuntimeAdapterRegistry<AgentRunnerAdapter>;
  /** Provides tool isolations to resolve runtime environment. */
  readonly toolIsolations: RuntimeAdapterRegistry<ToolIsolationAdapter>;
}): ResolvedRuntimeEnvironment {
  assertRuntimeReady(input.config);
  /** Adapter registry selected by the environment configuration. */
  const adapters = input.config.adapters;
  /** Untrusted runtime configuration awaiting normalization. */
  const runtime = input.config.runtime;
  /** Validated runtime configuration supplied to all resolved adapters. */
  const normalized = normalizeRuntimeConfig(runtime);
  return {
    config: normalized,
    digest: digestJson(
      toJsonValue({
        adapters,
        environmentId: input.config.environmentId,
        runtime: normalized,
      }),
    ),
    modelTransport: input.modelTransports.get(adapters.modelTransport),
    runner: input.runners.get(adapters.agentRunner),
    toolIsolation: input.toolIsolations.get(adapters.sandbox),
  };
}

/** Compiles tool isolation policy into its trusted runtime form. */
export function compileToolIsolationPolicy(input: {
  /** Provides grant to compile tool isolation policy. */
  readonly grant: CapabilityGrant;
  /** Stable identifier for run id. */
  readonly runId: string;
  /** Provides runtime to compile tool isolation policy. */
  readonly runtime: ResolvedRuntimeEnvironment;
}): ToolIsolationPolicy {
  if (input.runId === "") throw new TypeError("Runtime run ID is required");
  /** Seen capabilities values used to reject duplicates. */
  const capabilities = new Set(input.grant.capabilities);
  /** Indicates whether read repository. */
  const mayReadRepository =
    capabilities.has("repository.read") || capabilities.has("repository.write");
  /** Indicates whether write repository. */
  const mayWriteRepository = capabilities.has("repository.write");
  /** Indicates whether use network. */
  const mayUseNetwork = capabilities.has("network.access");
  /** Indicates whether read environment. */
  const mayReadEnvironment = capabilities.has("environment.read");
  return {
    allowedEnvironmentNames: mayReadEnvironment
      ? input.runtime.config.allowedEnvironmentNames
      : [],
    allowedReadRoots: mayReadRepository
      ? input.runtime.config.allowedReadRoots
      : [],
    allowedWriteRoots: mayWriteRepository
      ? input.runtime.config.allowedWriteRoots
      : [],
    network:
      mayUseNetwork && input.runtime.config.allowedNetworkOrigins.length > 0
        ? {
            allowedOrigins: input.runtime.config.allowedNetworkOrigins,
            mode: "allowlist",
          }
        : { allowedOrigins: [], mode: "none" },
    runId: input.runId,
  };
}

/** Normalizes the value into its canonical boundary representation. */
function normalizeRuntimeConfig(
  config: RuntimeEnvironmentConfig,
): RuntimeEnvironmentConfig {
  /** Stores root used by normalize runtime config. */
  const root = canonicalRoot(config.root, "runtime.root");
  /** Canonical, duplicate-free filesystem read roots. */
  const allowedReadRoots = normalizedUnique(
    config.allowedReadRoots.map((value) =>
      canonicalRoot(value, "runtime.allowedReadRoots"),
    ),
  );
  /** Canonical, duplicate-free filesystem write roots. */
  const allowedWriteRoots = normalizedUnique(
    config.allowedWriteRoots.map((value) =>
      canonicalRoot(value, "runtime.allowedWriteRoots"),
    ),
  );
  for (const candidate of allowedWriteRoots)
    if (!contains(root, candidate))
      throw new Error(
        `Runtime write root must be contained by runtime.root: ${candidate}`,
      );
  /** Stores secret name used by normalize runtime config. */
  const secretName = /(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu;
  for (const name of config.allowedEnvironmentNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || secretName.test(name))
      throw new Error(`Runtime environment name is unsafe: ${name}`);
  }
  /** Duplicate-free environment-variable allowlist. */
  const allowedEnvironmentNames = normalizedUnique(
    config.allowedEnvironmentNames,
  );
  /** Canonical, duplicate-free network-origin allowlist. */
  const allowedNetworkOrigins = normalizedUnique(
    config.allowedNetworkOrigins.map(normalizeOrigin),
  );
  return {
    ...config,
    allowedEnvironmentNames,
    allowedNetworkOrigins,
    allowedReadRoots,
    allowedWriteRoots,
    root,
  };
}

/** Resolves an absolute path while rejecting filesystem roots. */
function canonicalRoot(value: string, label: string): string {
  if (!isAbsolute(value))
    throw new TypeError(`${label} must be absolute: ${value}`);
  /** Validated result returned by canonical root. */
  const result = resolve(value);
  if (result === parse(result).root)
    throw new Error(`${label} cannot be a filesystem root`);
  return result;
}

/** Returns whether one canonical path contains another. */
function contains(parent: string, child: string): boolean {
  /** Parsed candidate awaiting contains validation. */
  const found = relative(parent, child);
  return (
    found === "" ||
    (found !== ".." &&
      !found.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(found))
  );
}

/** Normalizes the value into its canonical boundary representation. */
function normalizeOrigin(value: string): string {
  /** Stores url used by normalize origin. */
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new TypeError(`Runtime network origin is invalid: ${value}`);
  return url.origin;
}

/** Returns unique strings in deterministic order. */
function normalizedUnique(values: readonly string[]): readonly string[] {
  /** Deterministically ordered values returned to downstream adapters. */
  const normalized = [...values].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  /** Platform-aware comparison keys used only for duplicate detection. */
  const keys = normalized.map((value) =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value,
  );
  if (new Set(keys).size !== keys.length)
    throw new Error(
      "Runtime boundary values must be unique after normalization",
    );
  return normalized;
}
