/** Streams bounded output and guarantees terminate, kill, reap, and cleanup attempts. */
import { sha256 } from "../core/digest.js";
import type {
  AgentProcessCompletion,
  AgentProcessOutput,
  SupervisedAgentProcess,
} from "./adapters.js";

/** Enumerates the supported process supervision code variants. */
export type ProcessSupervisionCode =
  | "cleanup_failed"
  | "output_limit"
  | "output_stream_failed"
  | "process_wait_failed"
  | "reap_timeout";

/** Represents a process supervision failure. */
export class ProcessSupervisionError extends Error {
  /** Creates process supervision error with its required collaborators. */
  public constructor(
    /** Provides code to process supervision error. */ public readonly code: ProcessSupervisionCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Defines the data and behavior required by process telemetry. */
export interface ProcessTelemetry {
  /** Records total process supervision time in milliseconds. */
  readonly durationMilliseconds: number;
  /** Provides exit code to process telemetry. */
  readonly exitCode: number | null;
  /** Indicates whether hard killed. */
  readonly hardKilled: boolean;
  /** Version tag for the process telemetry representation. */
  readonly schema: "process-telemetry-v2";
  /** Sets stderr in bytes. */
  readonly stderrBytes: number;
  /** Stores the SHA-256 digest of stderr. */
  readonly stderrDigest: string;
  /** Sets stdout in bytes. */
  readonly stdoutBytes: number;
  /** Stores the SHA-256 digest of stdout. */
  readonly stdoutDigest: string;
  /** Indicates whether terminated. */
  readonly terminated: boolean;
  /** Indicates whether timed out. */
  readonly timedOut: boolean;
  /** Provides tool violation to process telemetry. */
  readonly toolViolation: string | null;
}

/** Defines the data and behavior required by supervised completion. */
export interface SupervisedCompletion {
  /** Provides completion to supervised completion. */
  readonly completion: AgentProcessCompletion;
  /** Provides stderr to supervised completion. */
  readonly stderr: string;
  /** Provides stdout to supervised completion. */
  readonly stdout: string;
  /** Provides telemetry to supervised completion. */
  readonly telemetry: ProcessTelemetry;
}

/** Supervises output, deadlines, termination, reaping, and cleanup for one process. */
export async function superviseProcess(input: {
  /** Records the canonical timestamp for deadline. */
  readonly deadlineAt: number;
  /** Sets grace in milliseconds. */
  readonly graceMilliseconds: number;
  /** Provides now to supervise process. */
  readonly now?: () => number;
  /** Sets output limit in bytes. */
  readonly outputLimitBytes: number;
  /** Sets post kill reap in milliseconds. */
  readonly postKillReapMilliseconds: number;
  /** Provides process to supervise process. */
  readonly process: SupervisedAgentProcess;
}): Promise<SupervisedCompletion> {
  if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= Date.now())
    throw new RangeError("Process deadline must be in the future");
  assertNonNegative(input.graceMilliseconds, "Process grace period");
  assertPositive(input.outputLimitBytes, "Process output limit");
  assertPositive(input.postKillReapMilliseconds, "Process reap deadline");
  /** Stores now used by supervise process. */
  const now = input.now ?? Date.now;
  /** Stores started used by supervise process. */
  const started = now();
  /** Stores output used by supervise process. */
  const output = collectOutput(input.process.output(), input.outputLimitBytes);
  /** Stores wait used by supervise process. */
  const wait = settle(input.process.wait());
  /** Stores output settled used by supervise process. */
  const outputSettled = settle(output.done);
  /** Stores completion used by supervise process. */
  let completion: AgentProcessCompletion;
  /** Stores terminated used by supervise process. */
  let terminated = false;
  /** Stores hard killed used by supervise process. */
  let hardKilled = false;
  /** Stores timed out used by supervise process. */
  let timedOut = false;
  /** Retains the primary failure so cleanup errors can be combined. */
  let primaryError: unknown;
  try {
    /** Stores first used by supervise process. */
    const first = await firstEvent(
      wait,
      outputSettled,
      remaining(input.deadlineAt),
    );
    if (first.kind === "deadline") {
      timedOut = true;
      ({ completion, hardKilled, terminated } = await stopAndReap(input, wait));
    } else if (first.kind === "wait") {
      if (!first.value.ok) {
        try {
          await forceStop(input);
        } catch (stopError) {
          throw new AggregateError(
            [first.value.error, stopError],
            "Agent wait failed and teardown could not be verified",
            { cause: first.value.error },
          );
        }
        throw new ProcessSupervisionError(
          "process_wait_failed",
          "Agent process wait failed",
          { cause: first.value.error },
        );
      }
      completion = first.value.value;
    } else if (!first.value.ok) {
      try {
        ({ completion, hardKilled, terminated } = await stopAndReap(
          input,
          wait,
        ));
      } catch (stopError) {
        throw new AggregateError(
          [first.value.error, stopError],
          "Agent output failed and the process could not be reaped",
          { cause: first.value.error },
        );
      }
      throw first.value.error;
    } else {
      /** Stores waited used by supervise process. */
      const waited = await settleBefore(wait, remaining(input.deadlineAt));
      if (waited === null) {
        timedOut = true;
        ({ completion, hardKilled, terminated } = await stopAndReap(
          input,
          wait,
        ));
      } else if (!waited.ok) {
        try {
          await forceStop(input);
        } catch (stopError) {
          throw new AggregateError(
            [waited.error, stopError],
            "Agent wait failed and teardown could not be verified",
            { cause: waited.error },
          );
        }
        throw new ProcessSupervisionError(
          "process_wait_failed",
          "Agent process wait failed",
          { cause: waited.error },
        );
      } else completion = waited.value;
    }
    /** Stores drained used by supervise process. */
    const drained = await settleBefore(
      outputSettled,
      input.postKillReapMilliseconds,
    );
    if (drained === null)
      throw new ProcessSupervisionError(
        "output_stream_failed",
        "Agent process output did not close after reap",
      );
    if (!drained.ok) {
      throw drained.error;
    }
    /** Collects bounded stdout chunks. */
    const stdout = Buffer.concat(output.stdout).toString("utf8");
    /** Collects bounded stderr chunks. */
    const stderr = Buffer.concat(output.stderr).toString("utf8");
    return {
      completion,
      stderr,
      stdout,
      telemetry: {
        durationMilliseconds: Math.max(0, now() - started),
        exitCode: completion.exitCode,
        hardKilled,
        schema: "process-telemetry-v2",
        stderrBytes: output.stderrBytes,
        stderrDigest: sha256(stderr),
        stdoutBytes: output.stdoutBytes,
        stdoutDigest: sha256(stdout),
        terminated,
        timedOut,
        toolViolation: completion.toolViolation,
      },
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      /** Stores cleaned used by supervise process. */
      const cleaned = await settleBefore(
        settle(input.process.cleanup()),
        input.postKillReapMilliseconds,
      );
      if (cleaned === null || !cleaned.ok)
        throw cleaned === null ? new Error("cleanup timed out") : cleaned.error;
    } catch (cleanupError) {
      if (primaryError === undefined)
        throw new ProcessSupervisionError(
          "cleanup_failed",
          "Agent process cleanup failed",
          { cause: cleanupError },
        );
      throw new AggregateError(
        [primaryError, cleanupError],
        "Agent process failed and cleanup also failed",
        { cause: primaryError },
      );
    }
  }
}

/** Collects bounded stdout and stderr while enforcing the combined byte limit. */
function collectOutput(
  stream: AsyncIterable<AgentProcessOutput>,
  limit: number,
): {
  /** Provides done to collect output. */
  readonly done: Promise<void>;
  /** Provides stderr to collect output. */
  readonly stderr: Buffer[];
  /** Provides stdout to collect output. */
  readonly stdout: Buffer[];
  /** Sets stderr in bytes. */
  stderrBytes: number;
  /** Sets stdout in bytes. */
  stdoutBytes: number;
} {
  /** Tracks mutable state shared by collect output. */
  const state = {
    done: Promise.resolve(),
    stderr: [] as Buffer[],
    stdout: [] as Buffer[],
    stderrBytes: 0,
    stdoutBytes: 0,
  };
  state.done = (async () => {
    try {
      for await (const chunk of stream) {
        if (chunk.channel !== "stdout" && chunk.channel !== "stderr")
          throw new TypeError("Agent output channel is invalid");
        /** Tracks bytes in bytes. */
        const bytes =
          typeof chunk.data === "string"
            ? Buffer.from(chunk.data, "utf8")
            : Buffer.from(chunk.data);
        if (state.stdoutBytes + state.stderrBytes + bytes.length > limit)
          throw new ProcessSupervisionError(
            "output_limit",
            "Agent process exceeded its output limit",
          );
        if (chunk.channel === "stdout") {
          state.stdout.push(bytes);
          state.stdoutBytes += bytes.length;
        } else {
          state.stderr.push(bytes);
          state.stderrBytes += bytes.length;
        }
      }
    } catch (error) {
      if (error instanceof ProcessSupervisionError) throw error;
      throw new ProcessSupervisionError(
        "output_stream_failed",
        "Agent process output stream failed",
        { cause: error },
      );
    }
  })();
  return state;
}

/** Attempts graceful termination, escalates to a hard kill, and waits for process reaping. */
async function stopAndReap(
  input: {
    /** Sets grace in milliseconds. */
    readonly graceMilliseconds: number;
    /** Sets post kill reap in milliseconds. */
    readonly postKillReapMilliseconds: number;
    /** Provides process to stop and reap. */
    readonly process: SupervisedAgentProcess;
  },
  wait: Promise<Settled<AgentProcessCompletion>>,
): Promise<{
  /** Provides completion to stop and reap. */
  completion: AgentProcessCompletion;
  /** Indicates whether hard killed. */
  hardKilled: boolean;
  /** Indicates whether terminated. */
  terminated: boolean;
}> {
  /** Stores terminated used by stop and reap. */
  const terminated =
    (
      await settleBefore(
        settle(input.process.terminateTree()),
        Math.max(1, input.graceMilliseconds),
      )
    )?.ok === true;
  /** Stores hard killed used by stop and reap. */
  let hardKilled = false;
  /** Holds the validated result returned by stop and reap. */
  let result = await settleBefore(wait, input.graceMilliseconds);
  if (result === null || !result.ok) {
    /** Captures the kill result produced by stop and reap. */
    const killResult = await settleBefore(
      settle(input.process.killTree()),
      input.postKillReapMilliseconds,
    );
    hardKilled = killResult !== null && killResult.ok;
    result = await settleBefore(wait, input.postKillReapMilliseconds);
  }
  if (result === null)
    throw new ProcessSupervisionError(
      "reap_timeout",
      "Agent process did not reap after hard kill",
    );
  if (!result.ok)
    throw new ProcessSupervisionError(
      "process_wait_failed",
      "Agent process wait failed",
      { cause: result.error },
    );
  return { completion: result.value, hardKilled, terminated };
}

/** Attempts process termination and reports an unconfirmed kill. */
async function forceStop(input: {
  /** Sets grace in milliseconds. */
  readonly graceMilliseconds: number;
  /** Sets post kill reap in milliseconds. */
  readonly postKillReapMilliseconds: number;
  /** Provides process to force stop. */
  readonly process: SupervisedAgentProcess;
}): Promise<void> {
  await settleBefore(
    settle(input.process.terminateTree()),
    Math.max(1, input.graceMilliseconds),
  );
  /** Stores killed used by force stop. */
  const killed = await settleBefore(
    settle(input.process.killTree()),
    input.postKillReapMilliseconds,
  );
  if (killed === null || !killed.ok)
    throw new ProcessSupervisionError(
      "reap_timeout",
      "Agent process teardown could not be verified",
      { cause: killed === null ? undefined : killed.error },
    );
}

/** Enumerates the supported settled variants. */
type Settled<T> =
  | {
      /** Indicates whether ok. */ readonly ok: true;
      /** Provides value to the current operation. */ readonly value: T;
    }
  | {
      /** Provides error to the current operation. */ readonly error: unknown;
      /** Provides ok to the current operation. */ readonly ok: false;
    };
/** Captures promise fulfillment or rejection as data. */
async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { error, ok: false };
  }
}
/** Returns a promise result only when it settles before the timeout. */
async function settleBefore<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T | null> {
  if (milliseconds === 0) return null;
  /** Tracks the timeout handle so it can be cleared. */
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/** Returns the first process, output, or deadline event. */
async function firstEvent<T>(
  wait: Promise<Settled<T>>,
  output: Promise<Settled<void>>,
  milliseconds: number,
): Promise<
  | {
      /** Discriminates the kind variant. */ readonly kind: "deadline";
    }
  | {
      /** Discriminates the kind variant. */ readonly kind: "output";
      /** Provides value to first event. */ readonly value: Settled<void>;
    }
  | {
      /** Discriminates the kind variant. */ readonly kind: "wait";
      /** Provides value to first event. */ readonly value: Settled<T>;
    }
> {
  /** Tracks the timeout handle so it can be cleared. */
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      wait.then((value) => ({ kind: "wait" as const, value })),
      output.then((value) => ({ kind: "output" as const, value })),
      new Promise<{
        /** Discriminates the kind variant. */ readonly kind: "deadline";
      }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "deadline" }), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/** Rejects input that does not satisfy the positive contract. */
function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${label} must be positive`);
}
/** Rejects values that are not non-negative safe integers. */
function assertNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be non-negative`);
}
/** Returns the remaining deadline budget in milliseconds. */
function remaining(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}
