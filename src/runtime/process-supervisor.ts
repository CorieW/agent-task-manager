// Streams bounded output and guarantees terminate, kill, reap, and cleanup attempts.
import { sha256 } from "../core/digest.js";
import type { AgentProcessCompletion, AgentProcessOutput, SupervisedAgentProcess } from "./adapters.js";

export type ProcessSupervisionCode = "cleanup_failed" | "output_limit" | "output_stream_failed" | "process_wait_failed" | "reap_timeout";

export class ProcessSupervisionError extends Error {
  public constructor(public readonly code: ProcessSupervisionCode, message: string, options?: ErrorOptions) { super(message, options); }
}

export interface ProcessTelemetry {
  readonly durationMilliseconds: number;
  readonly exitCode: number | null;
  readonly hardKilled: boolean;
  readonly schema: "process-telemetry-v2";
  readonly stderrBytes: number;
  readonly stderrDigest: string;
  readonly stdoutBytes: number;
  readonly stdoutDigest: string;
  readonly terminated: boolean;
  readonly timedOut: boolean;
  readonly toolViolation: string | null;
}

export interface SupervisedCompletion {
  readonly completion: AgentProcessCompletion;
  readonly stderr: string;
  readonly stdout: string;
  readonly telemetry: ProcessTelemetry;
}

export async function superviseProcess(input: {
  readonly deadlineAt: number;
  readonly graceMilliseconds: number;
  readonly now?: () => number;
  readonly outputLimitBytes: number;
  readonly postKillReapMilliseconds: number;
  readonly process: SupervisedAgentProcess;
}): Promise<SupervisedCompletion> {
  if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= Date.now()) throw new RangeError("Process deadline must be in the future");
  assertNonNegative(input.graceMilliseconds, "Process grace period");
  assertPositive(input.outputLimitBytes, "Process output limit");
  assertPositive(input.postKillReapMilliseconds, "Process reap deadline");
  const now = input.now ?? Date.now;
  const started = now();
  const output = collectOutput(input.process.output(), input.outputLimitBytes);
  const wait = settle(input.process.wait());
  const outputSettled = settle(output.done);
  let completion: AgentProcessCompletion | null = null;
  let terminated = false;
  let hardKilled = false;
  let timedOut = false;
  let primaryError: unknown;
  try {
    const first = await firstEvent(wait, outputSettled, remaining(input.deadlineAt));
    if (first.kind === "deadline") {
      timedOut = true;
      ({ completion, hardKilled, terminated } = await stopAndReap(input, wait));
    } else if (first.kind === "wait") {
      if (!first.value.ok) {
        try { await forceStop(input); }
        catch (stopError) { throw new AggregateError([first.value.error, stopError], "Agent wait failed and teardown could not be verified", { cause: first.value.error }); }
        throw new ProcessSupervisionError("process_wait_failed", "Agent process wait failed", { cause: first.value.error });
      }
      completion = first.value.value;
    } else if (!first.value.ok) {
      try { ({ completion, hardKilled, terminated } = await stopAndReap(input, wait)); }
      catch (stopError) { throw new AggregateError([first.value.error, stopError], "Agent output failed and the process could not be reaped", { cause: first.value.error }); }
      throw first.value.error;
    } else {
      const waited = await settleBefore(wait, remaining(input.deadlineAt));
      if (waited === null) { timedOut = true; ({ completion, hardKilled, terminated } = await stopAndReap(input, wait)); }
      else if (!waited.ok) {
        try { await forceStop(input); }
        catch (stopError) { throw new AggregateError([waited.error, stopError], "Agent wait failed and teardown could not be verified", { cause: waited.error }); }
        throw new ProcessSupervisionError("process_wait_failed", "Agent process wait failed", { cause: waited.error });
      }
      else completion = waited.value;
    }
    const drained = await settleBefore(outputSettled, input.postKillReapMilliseconds);
    if (drained === null) throw new ProcessSupervisionError("output_stream_failed", "Agent process output did not close after reap");
    if (!drained.ok) {
      throw drained.error;
    }
    if (completion === null) throw new ProcessSupervisionError("reap_timeout", "Agent process did not produce a completion");
    const stdout = Buffer.concat(output.stdout).toString("utf8");
    const stderr = Buffer.concat(output.stderr).toString("utf8");
    return {
      completion, stderr, stdout,
      telemetry: {
        durationMilliseconds: Math.max(0, now() - started), exitCode: completion.exitCode, hardKilled,
        schema: "process-telemetry-v2", stderrBytes: output.stderrBytes, stderrDigest: sha256(stderr), stdoutBytes: output.stdoutBytes,
        stdoutDigest: sha256(stdout), terminated, timedOut, toolViolation: completion.toolViolation,
      },
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      const cleaned = await settleBefore(settle(input.process.cleanup()), input.postKillReapMilliseconds);
      if (cleaned === null || !cleaned.ok) throw cleaned === null ? new Error("cleanup timed out") : cleaned.error;
    }
    catch (cleanupError) {
      if (primaryError === undefined) throw new ProcessSupervisionError("cleanup_failed", "Agent process cleanup failed", { cause: cleanupError });
      throw new AggregateError([primaryError, cleanupError], "Agent process failed and cleanup also failed", { cause: primaryError });
    }
  }
}

function collectOutput(stream: AsyncIterable<AgentProcessOutput>, limit: number): { readonly done: Promise<void>; readonly stderr: Buffer[]; readonly stdout: Buffer[]; stderrBytes: number; stdoutBytes: number } {
  const state = { done: Promise.resolve(), stderr: [] as Buffer[], stdout: [] as Buffer[], stderrBytes: 0, stdoutBytes: 0 };
  state.done = (async () => {
    try {
      for await (const chunk of stream) {
        if (chunk.channel !== "stdout" && chunk.channel !== "stderr") throw new TypeError("Agent output channel is invalid");
        const bytes = typeof chunk.data === "string" ? Buffer.from(chunk.data, "utf8") : Buffer.from(chunk.data);
        if (state.stdoutBytes + state.stderrBytes + bytes.length > limit) throw new ProcessSupervisionError("output_limit", "Agent process exceeded its output limit");
        if (chunk.channel === "stdout") { state.stdout.push(bytes); state.stdoutBytes += bytes.length; }
        else { state.stderr.push(bytes); state.stderrBytes += bytes.length; }
      }
    } catch (error) {
      if (error instanceof ProcessSupervisionError) throw error;
      throw new ProcessSupervisionError("output_stream_failed", "Agent process output stream failed", { cause: error });
    }
  })();
  return state;
}

async function stopAndReap(input: { readonly graceMilliseconds: number; readonly postKillReapMilliseconds: number; readonly process: SupervisedAgentProcess }, wait: Promise<Settled<AgentProcessCompletion>>): Promise<{ completion: AgentProcessCompletion; hardKilled: boolean; terminated: boolean }> {
  let terminated = false;
  let hardKilled = false;
  const terminateResult = await settleBefore(settle(input.process.terminateTree()), Math.max(1, input.graceMilliseconds));
  terminated = terminateResult !== null && terminateResult.ok;
  let result = await settleBefore(wait, input.graceMilliseconds);
  if (result === null || !result.ok) {
    const killResult = await settleBefore(settle(input.process.killTree()), input.postKillReapMilliseconds);
    hardKilled = killResult !== null && killResult.ok;
    result = await settleBefore(wait, input.postKillReapMilliseconds);
  }
  if (result === null) throw new ProcessSupervisionError("reap_timeout", "Agent process did not reap after hard kill");
  if (!result.ok) throw new ProcessSupervisionError("process_wait_failed", "Agent process wait failed", { cause: result.error });
  return { completion: result.value, hardKilled, terminated };
}

async function forceStop(input: { readonly graceMilliseconds: number; readonly postKillReapMilliseconds: number; readonly process: SupervisedAgentProcess }): Promise<void> {
  await settleBefore(settle(input.process.terminateTree()), Math.max(1, input.graceMilliseconds));
  const killed = await settleBefore(settle(input.process.killTree()), input.postKillReapMilliseconds);
  if (killed === null || !killed.ok) throw new ProcessSupervisionError("reap_timeout", "Agent process teardown could not be verified", { cause: killed === null ? undefined : killed.error });
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly error: unknown; readonly ok: false };
async function settle<T>(promise: Promise<T>): Promise<Settled<T>> { try { return { ok: true, value: await promise }; } catch (error) { return { error, ok: false }; } }
async function settleBefore<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  if (milliseconds === 0) return null;
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
async function firstEvent<T>(wait: Promise<Settled<T>>, output: Promise<Settled<void>>, milliseconds: number): Promise<
  { readonly kind: "deadline" } | { readonly kind: "output"; readonly value: Settled<void> } | { readonly kind: "wait"; readonly value: Settled<T> }
> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      wait.then((value) => ({ kind: "wait" as const, value })),
      output.then((value) => ({ kind: "output" as const, value })),
      new Promise<{ readonly kind: "deadline" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "deadline" }), milliseconds); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function assertPositive(value: number, label: string): void { if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be positive`); }
function assertNonNegative(value: number, label: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be non-negative`); }
function remaining(deadlineAt: number): number { return Math.max(0, deadlineAt - Date.now()); }
