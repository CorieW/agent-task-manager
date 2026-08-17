/** Runs one broker-owned process with shared output, deadline, cancellation, and tree teardown. */
import { spawn } from "node:child_process";
import {
  EffectCancellationAcknowledgedError,
  EffectTerminationUnconfirmedError,
} from "./contracts.js";
import { join } from "node:path";

/** Outcome returned by bounded child process. */
export interface BoundedChildProcessResult {
  /** Process exit code returned by the child. */
  readonly exitCode: number;
  /** Captured standard-error bytes. */
  readonly stderr: Uint8Array;
  /** Captured standard-output bytes. */
  readonly stdout: Uint8Array;
}

/** Inputs accepted by bounded child process. */
export interface BoundedChildProcessInput {
  /** Ordered the arguments used by this contract. */
  readonly arguments: readonly string[];
  /** Working directory for the operation. */
  readonly cwd: string;
  /** Canonical timestamp for deadline. */
  readonly deadlineAt: number;
  /** Environment variables exposed to the operation. */
  readonly environment: Readonly<Record<string, string>>;
  /** Absolute path of the executable to launch. */
  readonly executablePath: string;
  /** Output limit in bytes. */
  readonly outputLimitBytes: number;
  /** Cancellation signal for the operation. */
  readonly signal: AbortSignal;
}

/** Runs one child process with bounded output, deadline cancellation, and tree teardown. */
export async function runBoundedChildProcess(
  input: BoundedChildProcessInput,
): Promise<BoundedChildProcessResult> {
  if (input.signal.aborted || input.deadlineAt <= Date.now())
    throw new Error("Broker process was cancelled before launch");
  return new Promise((resolvePromise, reject) => {
    /** Stores child used by run bounded child process. */
    const child = spawn(input.executablePath, [...input.arguments], {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: input.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    /** Collects bounded stdout chunks. */
    const stdout: Buffer[] = [];
    /** Collects bounded stderr chunks. */
    const stderr: Buffer[] = [];
    /** Combined output size accumulated in bytes. */
    let bytes = 0;
    /** Prevents competing process events from settling the result twice. */
    let settled = false;
    /** Settles the process failure path once and removes all listeners. */
    const settleError = async (
      error: Error,
      cancellation = false,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      clear();
      try {
        await killProcessTree(child.pid);
        reject(
          cancellation
            ? new EffectCancellationAcknowledgedError(error.message, {
                cause: error,
              })
            : error,
        );
      } catch (teardownError) {
        reject(
          new EffectTerminationUnconfirmedError(
            [error, teardownError],
            "Broker process failed and process-tree teardown also failed",
            { cause: error },
          ),
        );
      }
    };
    /** Local callback implementing append for the run bounded child process operation. */
    const append = (target: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > input.outputLimitBytes)
        void settleError(new Error("Broker process output exceeded its limit"));
      else target.push(chunk);
    };
    /** Stores on abort used by run bounded child process. */
    const onAbort = (): void => {
      void settleError(new Error("Broker process was cancelled"), true);
    };
    /** Timeout handle cleared during cleanup. */
    const timer = setTimeout(
      () => {
        void settleError(new Error("Broker process exceeded its deadline"));
      },
      Math.max(1, input.deadlineAt - Date.now()),
    );
    /** Local callback implementing clear for the run bounded child process operation. */
    const clear = (): void => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => {
      void settleError(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clear();
      resolvePromise({
        exitCode: code ?? -1,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    });
  });
}

/** Terminates the identified process and its descendants. */
async function killProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  /** Stores system root used by kill process tree. */
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || systemRoot === "") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited; there is no remaining tree to kill.
    }
    return;
  }
  await new Promise<void>((resolvePromise) => {
    /** Stores killer used by kill process tree. */
    const killer = spawn(
      join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      {
        env: { SystemRoot: systemRoot },
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    killer.once("error", () => resolvePromise());
    killer.once("close", () => resolvePromise());
  });
}
