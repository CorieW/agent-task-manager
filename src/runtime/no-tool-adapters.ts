/** A concrete safe runtime stack for context-only agents with no tool authority. */
import { digestJson, isSha256Digest } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type {
  AgentProcessCompletion,
  AgentProcessOutput,
  AgentRunnerAdapter,
  AgentRunnerIdentity,
  ModelTransportAdapter,
  ModelTransportSession,
  SupervisedAgentProcess,
  ToolIsolationAdapter,
  ToolIsolationPolicy,
  ToolIsolationSession,
} from "./adapters.js";
import type { RunContext } from "./contracts.js";

/** Brands trusted no-tool model handles. */
const MODEL_HANDLE = Symbol("no-tool-model-handle");

/** Prepared no-tool isolation handle. */
const ISOLATION_HANDLE = Symbol("no-tool-isolation-handle");

/** No tool model client boundary. */
export interface NoToolModelClient {
  /** Streams model output for one bounded run. */
  stream(input: {
    /** Context dependency consumed by no tool model client. */
    readonly context: RunContext;
    /** Model dependency consumed by no tool model client. */
    readonly model: string;
    /** Output limit in bytes. */
    readonly outputLimitBytes: number;
    /** Version tag for the no tool model client representation. */
    readonly outputSchema: JsonObject;
    /** Reasoning dependency consumed by no tool model client. */
    readonly reasoning: string;
    /** Cancellation signal for the operation. */
    readonly signal: AbortSignal;
  }): AsyncIterable<string | Uint8Array>;
}

/** Provider-neutral no tool model handle contract. */
interface NoToolModelHandle {
  /** Brands this object as a validated no-tool model handle. */
  readonly [MODEL_HANDLE]: true;
  /** Service client used to cross the external boundary. */
  readonly client: NoToolModelClient;
  /** Controller dependency consumed by no tool model handle. */
  readonly controller: AbortController;
  /** Model dependency consumed by no tool model handle. */
  readonly model: string;
  /** Reasoning dependency consumed by no tool model handle. */
  readonly reasoning: string;
  /** Stable identifier for run id. */
  readonly runId: string;
}

/** Provider-neutral no tool isolation handle contract. */
interface NoToolIsolationHandle {
  /** Brands this object as a validated no-tool isolation handle. */
  readonly [ISOLATION_HANDLE]: true;
  /** Stable identifier for run id. */
  readonly runId: string;
}

/** Implements no tool model transport adapter and its boundary checks. */
export class NoToolModelTransportAdapter implements ModelTransportAdapter {
  /** Creates no tool model transport adapter with its required collaborators. */
  public constructor(
    /** Stable identifier for no tool model transport adapter. */ public readonly id: string,
    /** Service client used to cross the external boundary. */ private readonly client: NoToolModelClient,
    /** SHA-256 digest of canonical client. */ private readonly clientDigest: string,
  ) {
    requireId(id, "Model transport adapter ID");
    requireDigest(clientDigest, "Model client digest");
  }
  /** Prepares an isolated no-tool model session. */
  public async prepare(input: {
    /** Model dependency consumed by prepare. */
    readonly model: string;
    /** Reasoning dependency consumed by prepare. */
    readonly reasoning: string;
    /** Stable identifier for run id. */
    readonly runId: string;
    /** Cancellation signal for the operation. */
    readonly signal: AbortSignal;
  }): Promise<ModelTransportSession> {
    input.signal.throwIfAborted();
    /** Result of `AbortController`, retained for the prepare operation. */
    const controller = new AbortController();
    /** Local callback implementing abort for the prepare operation. */
    const abort = (): void => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    /** Handle snapshot used consistently during the prepare operation. */
    const handle: NoToolModelHandle = {
      [MODEL_HANDLE]: true,
      client: this.client,
      controller,
      model: input.model,
      reasoning: input.reasoning,
      runId: input.runId,
    };
    /** Mutable flag tracking closed during the prepare operation. */
    let closed = false;
    return {
      /** Releases resources owned by prepare. */
      async close() {
        if (closed) return;
        closed = true;
        input.signal.removeEventListener("abort", abort);
        controller.abort(new Error("Model session closed"));
      },
      opaqueHandle: handle,
      receipt: {
        adapterId: this.id,
        credentialExposedToTools: false,
        digest: digestJson(
          toJsonValue({
            adapterId: this.id,
            clientDigest: this.clientDigest,
            model: input.model,
            reasoning: input.reasoning,
            runId: input.runId,
          }),
        ),
        model: input.model,
        reasoning: input.reasoning,
        runId: input.runId,
        separatedFromToolProcesses: true,
      },
    };
  }
}

/** Implements no tool isolation adapter and its boundary checks. */
export class NoToolIsolationAdapter implements ToolIsolationAdapter {
  /** Creates no tool isolation adapter with its required collaborators. */
  public constructor(
    /** Stable identifier for no tool isolation adapter. */ public readonly id: string,
  ) {
    requireId(id, "Tool isolation adapter ID");
  }
  /** Prepares an isolated no-tool process boundary. */
  public async prepare(
    policy: ToolIsolationPolicy,
    signal: AbortSignal,
  ): Promise<ToolIsolationSession> {
    signal.throwIfAborted();
    if (
      policy.allowedEnvironmentNames.length !== 0 ||
      policy.allowedReadRoots.length !== 0 ||
      policy.allowedWriteRoots.length !== 0 ||
      policy.network.mode !== "none" ||
      policy.network.allowedOrigins.length !== 0
    ) {
      throw new Error(
        "The no-tool isolation adapter accepts no filesystem, environment, or network authority",
      );
    }
    /** Binds prepare to canonical policy content. */
    const policyDigest = digestJson(toJsonValue(policy));
    /** Handle snapshot used consistently during the prepare operation. */
    const handle: NoToolIsolationHandle = {
      [ISOLATION_HANDLE]: true,
      runId: policy.runId,
    };
    return {
      /** Releases resources owned by prepare. */
      async close() {},
      opaqueHandle: handle,
      receipt: {
        adapterId: this.id,
        environmentDigest: digestJson(
          toJsonValue({
            allowedEnvironmentNames: policy.allowedEnvironmentNames,
          }),
        ),
        filesystemPolicyDigest: digestJson(
          toJsonValue({
            allowedReadRoots: policy.allowedReadRoots,
            allowedWriteRoots: policy.allowedWriteRoots,
          }),
        ),
        networkPolicyDigest: digestJson(toJsonValue(policy.network)),
        policyDigest,
        processTreeEnforced: true,
        runId: policy.runId,
      },
    };
  }
}

/** Implements no tool agent runner adapter and its boundary checks. */
export class NoToolAgentRunnerAdapter implements AgentRunnerAdapter {
  /** Stable identifier for no tool agent runner adapter. */
  readonly #identity: AgentRunnerIdentity;
  /** Creates no tool agent runner adapter with its required collaborators. */
  public constructor(
    /** Stable identifier for no tool agent runner adapter. */ public readonly id: string,
    executableDigest: string,
    executableVersion: string,
  ) {
    requireId(id, "Agent runner adapter ID");
    requireDigest(executableDigest, "Agent runner executable digest");
    requireId(executableVersion, "Agent runner executable version");
    this.#identity = {
      executableDigest,
      executableVersion,
      id,
      supportedProfiles: ["no-tools"],
    };
  }
  /** Returns the runner identity used for receipt verification. */
  public async identity(): Promise<AgentRunnerIdentity> {
    return structuredClone(this.#identity);
  }
  /** Starts a bounded no-tool agent process over the prepared handles. */
  public async start(input: {
    /** Context dependency consumed by start. */
    readonly context: RunContext;
    /** Control plane handle dependency consumed by start. */
    readonly controlPlaneHandle: unknown;
    /** Version tag for the start representation. */
    readonly outputSchema: JsonObject;
    /** Output limit in bytes. */
    readonly outputLimitBytes: number;
    /** Cancellation signal for the operation. */
    readonly signal: AbortSignal;
    /** Tool isolation handle dependency consumed by start. */
    readonly toolIsolationHandle: unknown;
  }): Promise<SupervisedAgentProcess> {
    input.signal.throwIfAborted();
    /** Result of `modelHandle`, retained for the start operation. */
    const model = modelHandle(input.controlPlaneHandle);
    /** Validated no-tool isolation session. */
    const isolation = isolationHandle(input.toolIsolationHandle);
    if (
      model.runId !== input.context.runId ||
      isolation.runId !== input.context.runId
    )
      throw new Error("No-tool runtime handles belong to another run");
    return new NoToolAgentProcess(
      model,
      input.context,
      input.outputSchema,
      input.outputLimitBytes,
      input.signal,
    );
  }
}

/** Implements no tool agent process and its boundary checks. */
class NoToolAgentProcess implements SupervisedAgentProcess {
  /** Controller callback used by no tool agent process. */
  readonly #controller = new AbortController();
  /** Completion callback used by no tool agent process. */
  readonly #completion: Promise<AgentProcessCompletion>;
  /** Resolvecompletion callback used by no tool agent process. */
  readonly #resolveCompletion: (value: AgentProcessCompletion) => void;
  /** Source callback used by no tool agent process. */
  readonly #source: AsyncIterable<string | Uint8Array>;
  /** Upstreamsignal callback used by no tool agent process. */
  readonly #upstreamSignal: AbortSignal;
  /** Abort callback used by no tool agent process. */
  readonly #abort: () => void;
  /** Outputstarted dependency consumed by no tool agent process. */
  #outputStarted = false;
  /** Settled dependency consumed by no tool agent process. */
  #settled = false;
  /** Creates no tool agent process with its required collaborators. */
  public constructor(
    handle: NoToolModelHandle,
    context: RunContext,
    outputSchema: JsonObject,
    outputLimitBytes: number,
    signal: AbortSignal,
  ) {
    /** Result of `Promise`, retained for the no tool agent process operation. */
    let resolveCompletion!: (value: AgentProcessCompletion) => void;
    this.#completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    this.#resolveCompletion = resolveCompletion;
    this.#source = handle.client.stream({
      context,
      model: handle.model,
      outputLimitBytes,
      outputSchema,
      reasoning: handle.reasoning,
      signal: this.#controller.signal,
    });
    this.#upstreamSignal = signal;
    this.#abort = () => this.#controller.abort(signal.reason);
    signal.addEventListener("abort", this.#abort, { once: true });
  }
  /** Releases resources owned by no tool agent process. */
  public async cleanup(): Promise<void> {
    this.#upstreamSignal.removeEventListener("abort", this.#abort);
    this.#controller.abort(new Error("No-tool process cleaned"));
    this.#finish(null);
  }
  /** Forcibly terminates the complete child-process tree. */
  public async killTree(): Promise<void> {
    this.#controller.abort(new Error("No-tool process killed"));
    this.#finish(null);
  }
  /** Streams bounded stdout and stderr events from no tool agent process. */
  public async *output(): AsyncIterable<AgentProcessOutput> {
    if (this.#outputStarted)
      throw new Error("No-tool process output may be consumed only once");
    this.#outputStarted = true;
    try {
      for await (const data of this.#source) yield { channel: "stdout", data };
      this.#finish(0);
    } catch {
      this.#finish(this.#controller.signal.aborted ? null : 1);
    }
  }
  /** Requests graceful termination of the complete child-process tree. */
  public async terminateTree(): Promise<void> {
    this.#controller.abort(new Error("No-tool process terminated"));
    this.#finish(null);
  }
  /** Waits for no tool agent process to reach a terminal state. */
  public async wait(): Promise<AgentProcessCompletion> {
    return this.#completion;
  }
  /** Resolves process completion exactly once and detaches cancellation listeners. */
  #finish(exitCode: number | null): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveCompletion({ exitCode, toolViolation: null });
  }
}

/** Validates and returns a no-tool model handle. */
function modelHandle(value: unknown): NoToolModelHandle {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Partial<NoToolModelHandle>)[MODEL_HANDLE] !== true
  )
    throw new Error("No-tool model handle is invalid");
  return value as NoToolModelHandle;
}

/** Validates and returns a no-tool isolation handle. */
function isolationHandle(value: unknown): NoToolIsolationHandle {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Partial<NoToolIsolationHandle>)[ISOLATION_HANDLE] !== true
  )
    throw new Error("No-tool isolation handle is invalid");
  return value as NoToolIsolationHandle;
}

/** Returns id or throws when invalid or absent. */
function requireId(value: string, label: string): void {
  if (value === "") throw new TypeError(`${label} is required`);
}

/** Returns digest or throws when invalid or absent. */
function requireDigest(value: string, label: string): void {
  if (!isSha256Digest(value))
    throw new TypeError(`${label} must be a SHA-256 digest`);
}
