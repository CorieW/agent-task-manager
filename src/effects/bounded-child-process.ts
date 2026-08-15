// Runs one broker-owned process with shared output, deadline, cancellation, and tree teardown.
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface BoundedChildProcessResult { readonly exitCode: number; readonly stderr: Uint8Array; readonly stdout: Uint8Array; }
export interface BoundedChildProcessInput {
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly deadlineAt: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly outputLimitBytes: number;
  readonly signal: AbortSignal;
}

export async function runBoundedChildProcess(input: BoundedChildProcessInput): Promise<BoundedChildProcessResult> {
  if (input.signal.aborted || input.deadlineAt <= Date.now()) throw new Error("Broker process was cancelled before launch");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.executablePath, [...input.arguments], { cwd: input.cwd, detached: process.platform !== "win32", env: input.environment, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let settled = false;
    const settleError = async (error: Error): Promise<void> => { if (settled) return; settled = true; clear(); await killProcessTree(child.pid); reject(error); };
    const append = (target: Buffer[], chunk: Buffer): void => { if (settled) return; bytes += chunk.byteLength; if (bytes > input.outputLimitBytes) void settleError(new Error("Broker process output exceeded its limit")); else target.push(chunk); };
    const onAbort = (): void => { void settleError(new Error("Broker process was cancelled")); };
    const timer = setTimeout(() => { void settleError(new Error("Broker process exceeded its deadline")); }, Math.max(1, input.deadlineAt - Date.now()));
    const clear = (): void => { clearTimeout(timer); input.signal.removeEventListener("abort", onAbort); };
    input.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk)); child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => { void settleError(error); });
    child.once("close", (code) => { if (settled) return; settled = true; clear(); resolvePromise({ exitCode: code ?? -1, stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) }); });
  });
}

async function killProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform !== "win32") { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } return; }
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || systemRoot === "") { try { process.kill(pid, "SIGKILL"); } catch {} return; }
  await new Promise<void>((resolvePromise) => {
    const killer = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { env: { SystemRoot: systemRoot }, shell: false, stdio: "ignore", windowsHide: true });
    killer.once("error", () => resolvePromise()); killer.once("close", () => resolvePromise());
  });
}
