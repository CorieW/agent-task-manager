/** Defines pluggable trusted model, tool-isolation, runner, and process-lifecycle boundaries. */
import type { JsonObject } from "../domain/json.js";
import type { RunContext } from "./contracts.js";

/** Defines the data and behavior required by model transport session. */
export interface ModelTransportSession {
  /** Releases resources owned by model transport session. */
  close(): Promise<void>;
  /** Provides opaque handle to model transport session. */
  readonly opaqueHandle: unknown;
  /** Provides receipt to model transport session. */
  readonly receipt: {
    /** Identifies adapter. */
    readonly adapterId: string;
    /** Provides credential exposed to tools to model transport session. */
    readonly credentialExposedToTools: false;
    /** Provides digest to model transport session. */
    readonly digest: string;
    /** Provides model to model transport session. */
    readonly model: string;
    /** Provides reasoning to model transport session. */
    readonly reasoning: string;
    /** Identifies run. */
    readonly runId: string;
    /** Indicates whether separated from tool processes. */
    readonly separatedFromToolProcesses: true;
  };
}

/** Defines the data and behavior required by model transport adapter. */
export interface ModelTransportAdapter {
  /** Provides id to model transport adapter. */
  readonly id: string;
  /** Prepares a model control-plane session. */
  prepare(input: {
    /** Provides model to model transport adapter. */
    readonly model: string;
    /** Provides reasoning to model transport adapter. */
    readonly reasoning: string;
    /** Identifies run. */
    readonly runId: string;
    /** Provides signal to model transport adapter. */
    readonly signal: AbortSignal;
  }): Promise<ModelTransportSession>;
}

/** Defines the data and behavior required by tool isolation policy. */
export interface ToolIsolationPolicy {
  /** Lists environment variable names exposed to tool processes. */
  readonly allowedEnvironmentNames: readonly string[];
  /** Lists filesystem roots that tool processes may read. */
  readonly allowedReadRoots: readonly string[];
  /** Lists filesystem roots that tool processes may write. */
  readonly allowedWriteRoots: readonly string[];
  /** Lists the network accepted by this contract. */
  readonly network: {
    /** Lists network origins tool processes may access. */
    readonly allowedOrigins: readonly string[];
    /** Provides mode to tool isolation policy. */
    readonly mode: "allowlist" | "none";
  };
  /** Identifies run. */
  readonly runId: string;
}

/** Defines the data and behavior required by tool isolation session. */
export interface ToolIsolationSession {
  /** Releases resources owned by tool isolation session. */
  close(): Promise<void>;
  /** Provides opaque handle to tool isolation session. */
  readonly opaqueHandle: unknown;
  /** Provides receipt to tool isolation session. */
  readonly receipt: {
    /** Identifies adapter. */
    readonly adapterId: string;
    /** Stores the SHA-256 digest of environment. */
    readonly environmentDigest: string;
    /** Stores the SHA-256 digest of filesystem policy. */
    readonly filesystemPolicyDigest: string;
    /** Stores the SHA-256 digest of network policy. */
    readonly networkPolicyDigest: string;
    /** Stores the SHA-256 digest of policy. */
    readonly policyDigest: string;
    /** Indicates whether process tree enforced. */
    readonly processTreeEnforced: true;
    /** Identifies run. */
    readonly runId: string;
  };
}

/** Defines the data and behavior required by tool isolation adapter. */
export interface ToolIsolationAdapter {
  /** Provides id to tool isolation adapter. */
  readonly id: string;
  /** Prepares a tool-process isolation session. */
  prepare(
    policy: ToolIsolationPolicy,
    signal: AbortSignal,
  ): Promise<ToolIsolationSession>;
}

/** Defines the data and behavior required by agent runner identity. */
export interface AgentRunnerIdentity {
  /** Stores the SHA-256 digest of executable. */
  readonly executableDigest: string;
  /** Records the executable version used for compatibility checks. */
  readonly executableVersion: string;
  /** Provides id to agent runner identity. */
  readonly id: string;
  /** Lists the supported profiles accepted by this contract. */
  readonly supportedProfiles: readonly string[];
}

/** Defines the data and behavior required by agent process completion. */
export interface AgentProcessCompletion {
  /** Provides exit code to agent process completion. */
  readonly exitCode: number | null;
  /** Provides tool violation to agent process completion. */
  readonly toolViolation: string | null;
}

/** Defines the data and behavior required by agent process output. */
export interface AgentProcessOutput {
  /** Provides channel to agent process output. */
  readonly channel: "stderr" | "stdout";
  /** Provides data to agent process output. */
  readonly data: string | Uint8Array;
}

/** Defines the data and behavior required by supervised agent process. */
export interface SupervisedAgentProcess {
  /** Releases resources owned by supervised agent process. */
  cleanup(): Promise<void>;
  /** Forcibly terminates the complete child-process tree. */
  killTree(): Promise<void>;
  /** Streams bounded stdout and stderr events from supervised agent process. */
  output(): AsyncIterable<AgentProcessOutput>;
  /** Requests graceful termination of the complete child-process tree. */
  terminateTree(): Promise<void>;
  /** Waits for supervised agent process to reach a terminal state. */
  wait(): Promise<AgentProcessCompletion>;
}

/** Defines the data and behavior required by agent runner adapter. */
export interface AgentRunnerAdapter {
  /** Provides id to agent runner adapter. */
  readonly id: string;
  /** Returns the runner identity used for receipt verification. */
  identity(): Promise<AgentRunnerIdentity>;
  /** Starts a supervised agent process with prepared control and isolation handles. */
  start(input: {
    /** Provides context to agent runner adapter. */
    readonly context: RunContext;
    /** Provides control plane handle to agent runner adapter. */
    readonly controlPlaneHandle: unknown;
    /** Version tag for the agent runner adapter representation. */
    readonly outputSchema: JsonObject;
    /** Sets output limit in bytes. */
    readonly outputLimitBytes: number;
    /** Provides tool isolation handle to agent runner adapter. */
    readonly toolIsolationHandle: unknown;
    /** Provides signal to agent runner adapter. */
    readonly signal: AbortSignal;
  }): Promise<SupervisedAgentProcess>;
}

/** Implements runtime adapter registry and its boundary checks. */
export class RuntimeAdapterRegistry<
  T extends {
    /** Provides id to runtime adapter registry. */ readonly id: string;
  },
> {
  /** Provides values to runtime adapter registry. */
  readonly #values = new Map<string, T>();
  /** Registers one uniquely identified adapter. */
  public register(value: T): void {
    if (value.id === "") throw new TypeError("Runtime adapter ID is required");
    if (this.#values.has(value.id))
      throw new Error(`Runtime adapter is already registered: ${value.id}`);
    this.#values.set(value.id, value);
  }
  /** Returns the adapter registered under an exact identifier. */
  public get(id: string): T {
    /** Contains the registered adapter selected by identifier. */
    const value = this.#values.get(id);
    if (value === undefined)
      throw new Error(`Runtime adapter is unavailable: ${id}`);
    return value;
  }
  /** Lists registered adapter identifiers in deterministic order. */
  public list(): readonly string[] {
    return [...this.#values.keys()].sort();
  }
}
