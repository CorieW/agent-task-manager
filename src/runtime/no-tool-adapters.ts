// Provides a concrete safe runtime stack for context-only agents with no tool authority.
import { digestJson } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type {
  AgentProcessCompletion, AgentProcessOutput, AgentRunnerAdapter, AgentRunnerIdentity, ModelTransportAdapter,
  ModelTransportSession, SupervisedAgentProcess, ToolIsolationAdapter, ToolIsolationPolicy, ToolIsolationSession,
} from "./adapters.js";
import type { RunContext } from "./contracts.js";

const MODEL_HANDLE = Symbol("no-tool-model-handle");
const ISOLATION_HANDLE = Symbol("no-tool-isolation-handle");

export interface NoToolModelClient {
  stream(input: {
    readonly context: RunContext;
    readonly model: string;
    readonly outputLimitBytes: number;
    readonly outputSchema: JsonObject;
    readonly reasoning: string;
    readonly signal: AbortSignal;
  }): AsyncIterable<string | Uint8Array>;
}

interface NoToolModelHandle {
  readonly [MODEL_HANDLE]: true;
  readonly client: NoToolModelClient;
  readonly controller: AbortController;
  readonly model: string;
  readonly reasoning: string;
  readonly runId: string;
}
interface NoToolIsolationHandle { readonly [ISOLATION_HANDLE]: true; readonly runId: string; }

export class NoToolModelTransportAdapter implements ModelTransportAdapter {
  public constructor(public readonly id: string, private readonly client: NoToolModelClient, private readonly clientDigest: string) {
    requireId(id, "Model transport adapter ID");
    requireDigest(clientDigest, "Model client digest");
  }
  public async prepare(input: { readonly model: string; readonly reasoning: string; readonly runId: string; readonly signal: AbortSignal }): Promise<ModelTransportSession> {
    input.signal.throwIfAborted();
    const controller = new AbortController();
    const abort = (): void => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    const handle: NoToolModelHandle = { [MODEL_HANDLE]: true, client: this.client, controller, model: input.model, reasoning: input.reasoning, runId: input.runId };
    let closed = false;
    return {
      async close() { if (closed) return; closed = true; input.signal.removeEventListener("abort", abort); controller.abort(new Error("Model session closed")); },
      opaqueHandle: handle,
      receipt: {
        adapterId: this.id, credentialExposedToTools: false,
        digest: digestJson(toJsonValue({ adapterId: this.id, clientDigest: this.clientDigest, model: input.model, reasoning: input.reasoning, runId: input.runId })),
        model: input.model, reasoning: input.reasoning, runId: input.runId, separatedFromToolProcesses: true,
      },
    };
  }
}

export class NoToolIsolationAdapter implements ToolIsolationAdapter {
  public constructor(public readonly id: string) { requireId(id, "Tool isolation adapter ID"); }
  public async prepare(policy: ToolIsolationPolicy, signal: AbortSignal): Promise<ToolIsolationSession> {
    signal.throwIfAborted();
    if (policy.allowedEnvironmentNames.length !== 0 || policy.allowedReadRoots.length !== 0 || policy.allowedWriteRoots.length !== 0 || policy.network.mode !== "none" || policy.network.allowedOrigins.length !== 0) {
      throw new Error("The no-tool isolation adapter accepts no filesystem, environment, or network authority");
    }
    const policyDigest = digestJson(toJsonValue(policy));
    const handle: NoToolIsolationHandle = { [ISOLATION_HANDLE]: true, runId: policy.runId };
    return {
      async close() {}, opaqueHandle: handle,
      receipt: {
        adapterId: this.id,
        environmentDigest: digestJson(toJsonValue({ allowedEnvironmentNames: policy.allowedEnvironmentNames })),
        filesystemPolicyDigest: digestJson(toJsonValue({ allowedReadRoots: policy.allowedReadRoots, allowedWriteRoots: policy.allowedWriteRoots })),
        networkPolicyDigest: digestJson(toJsonValue(policy.network)), policyDigest, processTreeEnforced: true, runId: policy.runId,
      },
    };
  }
}

export class NoToolAgentRunnerAdapter implements AgentRunnerAdapter {
  readonly #identity: AgentRunnerIdentity;
  public constructor(public readonly id: string, executableDigest: string, executableVersion: string) {
    requireId(id, "Agent runner adapter ID"); requireDigest(executableDigest, "Agent runner executable digest"); requireId(executableVersion, "Agent runner executable version");
    this.#identity = { executableDigest, executableVersion, id, supportedProfiles: ["no-tools"] };
  }
  public async identity(): Promise<AgentRunnerIdentity> { return structuredClone(this.#identity); }
  public async start(input: {
    readonly context: RunContext; readonly controlPlaneHandle: unknown; readonly outputSchema: JsonObject;
    readonly outputLimitBytes: number; readonly signal: AbortSignal; readonly toolIsolationHandle: unknown;
  }): Promise<SupervisedAgentProcess> {
    input.signal.throwIfAborted();
    const model = modelHandle(input.controlPlaneHandle);
    const isolation = isolationHandle(input.toolIsolationHandle);
    if (model.runId !== input.context.runId || isolation.runId !== input.context.runId) throw new Error("No-tool runtime handles belong to another run");
    return new NoToolAgentProcess(model, input.context, input.outputSchema, input.outputLimitBytes, input.signal);
  }
}

class NoToolAgentProcess implements SupervisedAgentProcess {
  readonly #controller = new AbortController();
  readonly #completion: Promise<AgentProcessCompletion>;
  readonly #resolveCompletion: (value: AgentProcessCompletion) => void;
  readonly #source: AsyncIterable<string | Uint8Array>;
  readonly #upstreamSignal: AbortSignal;
  readonly #abort: () => void;
  #outputStarted = false;
  #settled = false;
  public constructor(handle: NoToolModelHandle, context: RunContext, outputSchema: JsonObject, outputLimitBytes: number, signal: AbortSignal) {
    let resolveCompletion!: (value: AgentProcessCompletion) => void;
    this.#completion = new Promise((resolve) => { resolveCompletion = resolve; });
    this.#resolveCompletion = resolveCompletion;
    this.#source = handle.client.stream({ context, model: handle.model, outputLimitBytes, outputSchema, reasoning: handle.reasoning, signal: this.#controller.signal });
    this.#upstreamSignal = signal;
    this.#abort = () => this.#controller.abort(signal.reason);
    signal.addEventListener("abort", this.#abort, { once: true });
  }
  public async cleanup(): Promise<void> { this.#upstreamSignal.removeEventListener("abort", this.#abort); this.#controller.abort(new Error("No-tool process cleaned")); this.#finish(null); }
  public async killTree(): Promise<void> { this.#controller.abort(new Error("No-tool process killed")); this.#finish(null); }
  public async *output(): AsyncIterable<AgentProcessOutput> {
    if (this.#outputStarted) throw new Error("No-tool process output may be consumed only once");
    this.#outputStarted = true;
    try {
      for await (const data of this.#source) yield { channel: "stdout", data };
      this.#finish(0);
    } catch {
      this.#finish(this.#controller.signal.aborted ? null : 1);
    }
  }
  public async terminateTree(): Promise<void> { this.#controller.abort(new Error("No-tool process terminated")); this.#finish(null); }
  public async wait(): Promise<AgentProcessCompletion> { return this.#completion; }
  #finish(exitCode: number | null): void { if (this.#settled) return; this.#settled = true; this.#resolveCompletion({ exitCode, toolViolation: null }); }
}

function modelHandle(value: unknown): NoToolModelHandle {
  if (value === null || typeof value !== "object" || (value as Partial<NoToolModelHandle>)[MODEL_HANDLE] !== true) throw new Error("No-tool model handle is invalid");
  return value as NoToolModelHandle;
}
function isolationHandle(value: unknown): NoToolIsolationHandle {
  if (value === null || typeof value !== "object" || (value as Partial<NoToolIsolationHandle>)[ISOLATION_HANDLE] !== true) throw new Error("No-tool isolation handle is invalid");
  return value as NoToolIsolationHandle;
}
function requireId(value: string, label: string): void { if (value === "") throw new TypeError(`${label} is required`); }
function requireDigest(value: string, label: string): void { if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 digest`); }
