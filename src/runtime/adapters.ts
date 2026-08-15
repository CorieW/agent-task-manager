/** Defines pluggable trusted model, tool-isolation, runner, and process-lifecycle boundaries. */
import type { JsonObject } from "../domain/json.js";
import type { RunContext } from "./contracts.js";

export interface ModelTransportSession {
  close(): Promise<void>;
  readonly opaqueHandle: unknown;
  readonly receipt: {
    readonly adapterId: string;
    readonly credentialExposedToTools: false;
    readonly digest: string;
    readonly model: string;
    readonly reasoning: string;
    readonly runId: string;
    readonly separatedFromToolProcesses: true;
  };
}

export interface ModelTransportAdapter {
  readonly id: string;
  prepare(input: {
    readonly model: string;
    readonly reasoning: string;
    readonly runId: string;
    readonly signal: AbortSignal;
  }): Promise<ModelTransportSession>;
}

export interface ToolIsolationPolicy {
  readonly allowedEnvironmentNames: readonly string[];
  readonly allowedReadRoots: readonly string[];
  readonly allowedWriteRoots: readonly string[];
  readonly network: {
    readonly allowedOrigins: readonly string[];
    readonly mode: "allowlist" | "none";
  };
  readonly runId: string;
}

export interface ToolIsolationSession {
  close(): Promise<void>;
  readonly opaqueHandle: unknown;
  readonly receipt: {
    readonly adapterId: string;
    readonly environmentDigest: string;
    readonly filesystemPolicyDigest: string;
    readonly networkPolicyDigest: string;
    readonly policyDigest: string;
    readonly processTreeEnforced: true;
    readonly runId: string;
  };
}

export interface ToolIsolationAdapter {
  readonly id: string;
  prepare(
    policy: ToolIsolationPolicy,
    signal: AbortSignal,
  ): Promise<ToolIsolationSession>;
}

export interface AgentRunnerIdentity {
  readonly executableDigest: string;
  readonly executableVersion: string;
  readonly id: string;
  readonly supportedProfiles: readonly string[];
}

export interface AgentProcessCompletion {
  readonly exitCode: number | null;
  readonly toolViolation: string | null;
}

export interface AgentProcessOutput {
  readonly channel: "stderr" | "stdout";
  readonly data: string | Uint8Array;
}

export interface SupervisedAgentProcess {
  cleanup(): Promise<void>;
  killTree(): Promise<void>;
  output(): AsyncIterable<AgentProcessOutput>;
  terminateTree(): Promise<void>;
  wait(): Promise<AgentProcessCompletion>;
}

export interface AgentRunnerAdapter {
  readonly id: string;
  identity(): Promise<AgentRunnerIdentity>;
  start(input: {
    readonly context: RunContext;
    readonly controlPlaneHandle: unknown;
    readonly outputSchema: JsonObject;
    readonly outputLimitBytes: number;
    readonly toolIsolationHandle: unknown;
    readonly signal: AbortSignal;
  }): Promise<SupervisedAgentProcess>;
}

export class RuntimeAdapterRegistry<T extends { readonly id: string }> {
  readonly #values = new Map<string, T>();
  public register(value: T): void {
    if (value.id === "") throw new TypeError("Runtime adapter ID is required");
    if (this.#values.has(value.id))
      throw new Error(`Runtime adapter is already registered: ${value.id}`);
    this.#values.set(value.id, value);
  }
  public get(id: string): T {
    const value = this.#values.get(id);
    if (value === undefined)
      throw new Error(`Runtime adapter is unavailable: ${id}`);
    return value;
  }
  public list(): readonly string[] {
    return [...this.#values.keys()].sort();
  }
}
