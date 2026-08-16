/** Serializes one logical execution across cooperating processes on the same host. */
import { open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Reuses one in-process queue for every logical execution identity. */
const mutexes = new Map<string, ExecutionMutex>();

/** Runs an execution while holding its host-local filesystem mutex. */
export async function withSingleHostExecutionLock<T>(
  identity: string,
  operation: () => Promise<T>,
): Promise<T> {
  const mutex = mutexes.get(identity) ?? new ExecutionMutex(identity);
  mutexes.set(identity, mutex);
  try {
    return await mutex.run(operation);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(`Agent execution is already active: ${identity}`, {
        cause: error,
      });
    throw error;
  }
}

/** Owns one in-process queue and one cross-process lock-file identity. */
class ExecutionMutex {
  /** Host-local lock file reserved for this execution identity. */
  readonly #path: string;
  /** Promise tail ordering callers in the current process. */
  #tail: Promise<void> = Promise.resolve();

  /** Creates a bounded lock-file identity under the host temp directory. */
  public constructor(identity: string) {
    this.#path = join(tmpdir(), `agent-task-manager-${identity}.lock`);
  }

  /** Runs one operation after acquiring the same-host lock file. */
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let releaseQueue!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await this.acquire();
      return await operation();
    } finally {
      if (handle !== undefined) {
        await handle.close();
        await rm(this.#path, { force: true });
      }
      releaseQueue();
    }
  }

  /** Acquires the lock, replacing only a file owned by a dead process. */
  private async acquire() {
    try {
      return await this.createLock();
    } catch (error) {
      if (!isAlreadyExists(error) || !(await this.clearStaleOwner()))
        throw error;
      return this.createLock();
    }
  }

  /** Creates and populates the exclusive owner file. */
  private async createLock() {
    const handle = await open(this.#path, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        "utf8",
      );
      return handle;
    } catch (error) {
      await handle.close();
      await rm(this.#path, { force: true });
      throw error;
    }
  }

  /** Removes one lock whose recorded process no longer exists. */
  private async clearStaleOwner(): Promise<boolean> {
    let pid: number;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("pid" in parsed) ||
        typeof parsed.pid !== "number"
      )
        return false;
      pid = parsed.pid;
    } catch {
      return false;
    }
    if (isProcessAlive(pid)) return false;
    await rm(this.#path, { force: true });
    return true;
  }
}

/** Reports whether a filesystem failure means the lock already exists. */
function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** Reports whether the recorded process still owns a live PID. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
