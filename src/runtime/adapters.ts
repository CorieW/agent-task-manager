/** Provider-neutral pluggable trusted model, tool-isolation, runner, and process-lifecycle boundaries contract. */
import type { JsonObject } from "../domain/json.js";
import type { RunContext } from "./contracts.js";

/** Provider-neutral model transport session contract. */
export interface ModelTransportSession {
  /** Releases resources owned by model transport session. */
  close(): Promise<void>;
  /** Provides opaque handle to model transport session. */
  readonly opaqueHandle: unknown;
  /** Applied-effect receipt, or null until mutation succeeds. */
  readonly receipt: {
    /** Stable identifier for adapter id. */
    readonly adapterId: string;
    /** Provides credential exposed to tools to model transport session. */
    readonly credentialExposedToTools: false;
    /** SHA-256 digest binding the canonical content. */
    readonly digest: string;
    /** Provides model to model transport session. */
    readonly model: string;
    /** Provides reasoning to model transport session. */
    readonly reasoning: string;
    /** Stable identifier for run id. */
    readonly runId: string;
    /** Indicates whether separated from tool processes. */
    readonly separatedFromToolProcesses: true;
  };
}

/** Model transport adapter boundary. */
export interface ModelTransportAdapter {
  /** Stable identifier for model transport adapter. */
  readonly id: string;
  /** Prepares a model control-plane session. */
  prepare(input: {
    /** Provides model to model transport adapter. */
    readonly model: string;
    /** Provides reasoning to model transport adapter. */
    readonly reasoning: string;
    /** Stable identifier for run id. */
    readonly runId: string;
    /** Cancellation signal for the operation. */
    readonly signal: AbortSignal;
  }): Promise<ModelTransportSession>;
}

/** Provider-neutral tool isolation policy contract. */
export interface ToolIsolationPolicy {
  /** Ordered environment variable names exposed to tool processes. */
  readonly allowedEnvironmentNames: readonly string[];
  /** Ordered filesystem roots that tool processes may read. */
  readonly allowedReadRoots: readonly string[];
  /** Ordered filesystem roots that tool processes may write. */
  readonly allowedWriteRoots: readonly string[];
  /** Ordered the network used by this contract. */
  readonly network: {
    /** Ordered network origins tool processes may access. */
    readonly allowedOrigins: readonly string[];
    /** Selected operating mode. */
    readonly mode: "allowlist" | "none";
  };
  /** Stable identifier for run id. */
  readonly runId: string;
}

/** Provider-neutral tool isolation session contract. */
export interface ToolIsolationSession {
  /** Releases resources owned by tool isolation session. */
  close(): Promise<void>;
  /** Provides opaque handle to tool isolation session. */
  readonly opaqueHandle: unknown;
  /** Applied-effect receipt, or null until mutation succeeds. */
  readonly receipt: {
    /** Stable identifier for adapter id. */
    readonly adapterId: string;
    /** SHA-256 digest of canonical environment. */
    readonly environmentDigest: string;
    /** SHA-256 digest of canonical filesystem policy. */
    readonly filesystemPolicyDigest: string;
    /** SHA-256 digest of canonical network policy. */
    readonly networkPolicyDigest: string;
    /** SHA-256 digest of canonical policy. */
    readonly policyDigest: string;
    /** Indicates whether process tree enforced. */
    readonly processTreeEnforced: true;
    /** Stable identifier for run id. */
    readonly runId: string;
  };
}

/** Tool isolation adapter boundary. */
export interface ToolIsolationAdapter {
  /** Stable identifier for tool isolation adapter. */
  readonly id: string;
  /** Prepares a tool-process isolation session. */
  prepare(
    policy: ToolIsolationPolicy,
    signal: AbortSignal,
  ): Promise<ToolIsolationSession>;
}

/** Canonical agent runner identity representation. */
export interface AgentRunnerIdentity {
  /** SHA-256 digest of canonical executable. */
  readonly executableDigest: string;
  /** Opaque version token for executable. */
  readonly executableVersion: string;
  /** Ordered id accepted by agent runner identity. */
  readonly id: string;
  /** Ordered the supported profiles used by this contract. */
  readonly supportedProfiles: readonly string[];
}

/** Canonical agent process completion representation. */
export interface AgentProcessCompletion {
  /** Process exit code returned by the child. */
  readonly exitCode: number | null;
  /** Provides tool violation to agent process completion. */
  readonly toolViolation: string | null;
}

/** Provider-neutral agent process output contract. */
export interface AgentProcessOutput {
  /** Provides channel to agent process output. */
  readonly channel: "stderr" | "stdout";
  /** Provides data to agent process output. */
  readonly data: string | Uint8Array;
}

/** Provider-neutral supervised agent process contract. */
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

/** Agent runner adapter boundary. */
export interface AgentRunnerAdapter {
  /** Stable identifier for agent runner adapter. */
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
    /** Output limit in bytes. */
    readonly outputLimitBytes: number;
    /** Provides tool isolation handle to agent runner adapter. */
    readonly toolIsolationHandle: unknown;
    /** Cancellation signal for the operation. */
    readonly signal: AbortSignal;
  }): Promise<SupervisedAgentProcess>;
}

/** Implements runtime adapter registry and its boundary checks. */
export class RuntimeAdapterRegistry<
  T extends {
    /** Stable identifier for runtime adapter registry. */ readonly id: string;
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
    /** The registered adapter selected by identifier. */
    const value = this.#values.get(id);
    if (value === undefined)
      throw new Error(`Runtime adapter is unavailable: ${id}`);
    return value;
  }
  /** Returns registered adapter identifiers in deterministic order in deterministic order. */
  public list(): readonly string[] {
    return [...this.#values.keys()].sort();
  }
}
