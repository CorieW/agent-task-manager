// Resolves exact runtime adapters from environment-only configuration.
import type { EnvironmentConfig } from "../config/environment.js";
import { assertRuntimeReady } from "../config/environment.js";
import type { AgentRunnerAdapter, ModelTransportAdapter, ToolIsolationAdapter } from "./adapters.js";
import { RuntimeAdapterRegistry } from "./adapters.js";

export interface ResolvedRuntimeEnvironment {
  readonly modelTransport: ModelTransportAdapter;
  readonly outputLimitBytes: number;
  readonly root: string;
  readonly runner: AgentRunnerAdapter;
  readonly terminationGraceMilliseconds: number;
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
  if (adapters === null || runtime === null) throw new Error("Runtime configuration did not survive readiness validation");
  return {
    modelTransport: input.modelTransports.get(adapters.modelTransport),
    outputLimitBytes: runtime.outputLimitBytes,
    root: runtime.root,
    runner: input.runners.get(adapters.agentRunner),
    terminationGraceMilliseconds: runtime.terminationGraceMilliseconds,
    toolIsolation: input.toolIsolations.get(adapters.sandbox),
  };
}
