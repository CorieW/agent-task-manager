// Enforces bounded process completion with terminate, grace, hard-kill, and reap.
import { sha256 } from "../core/digest.js";
import type { AgentProcessCompletion, SupervisedAgentProcess } from "./adapters.js";

export interface ProcessTelemetry {
  readonly durationMilliseconds: number;
  readonly exitCode: number | null;
  readonly hardKilled: boolean;
  readonly schema: "process-telemetry-v1";
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
  readonly telemetry: ProcessTelemetry;
}

export async function superviseProcess(input: {
  readonly deadlineMilliseconds: number;
  readonly graceMilliseconds: number;
  readonly now?: () => number;
  readonly outputLimitBytes: number;
  readonly process: SupervisedAgentProcess;
}): Promise<SupervisedCompletion> {
  if (!Number.isSafeInteger(input.deadlineMilliseconds) || input.deadlineMilliseconds < 1) throw new RangeError("Process deadline must be positive");
  if (!Number.isSafeInteger(input.graceMilliseconds) || input.graceMilliseconds < 0) throw new RangeError("Process grace period must be non-negative");
  if (!Number.isSafeInteger(input.outputLimitBytes) || input.outputLimitBytes < 1) throw new RangeError("Process output limit must be positive");
  const now = input.now ?? Date.now;
  const started = now();
  const wait = input.process.wait();
  let completion = await settleBefore(wait, input.deadlineMilliseconds);
  let terminated = false;
  let hardKilled = false;
  if (completion === null) {
    terminated = true;
    await input.process.terminateTree();
    completion = await settleBefore(wait, input.graceMilliseconds);
    if (completion === null) {
      hardKilled = true;
      await input.process.killTree();
      completion = await wait;
    }
  }
  const stdoutBytes = Buffer.byteLength(completion.stdout, "utf8");
  const stderrBytes = Buffer.byteLength(completion.stderr, "utf8");
  if (stdoutBytes + stderrBytes > input.outputLimitBytes) throw new Error("Agent process exceeded its output limit");
  return {
    completion,
    telemetry: {
      durationMilliseconds: Math.max(0, now() - started), exitCode: completion.exitCode, hardKilled,
      schema: "process-telemetry-v1", stderrBytes, stderrDigest: sha256(completion.stderr), stdoutBytes,
      stdoutDigest: sha256(completion.stdout), terminated, timedOut: terminated, toolViolation: completion.toolViolation,
    },
  };
}

async function settleBefore<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  if (milliseconds === 0) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), milliseconds); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
