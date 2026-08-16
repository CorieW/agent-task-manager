/** Provides FIFO process-local ordering backed by an exclusive same-host lock file. */
import { open, readFile, rm } from "node:fs/promises";

/** Owns one in-process queue and one caller-selected cross-process lock path. */
export class HostFileMutex {
  /** Promise tail ordering callers in the current process. */
  #tail: Promise<void> = Promise.resolve();

  /** Binds the mutex to an exact host-local lock-file path. */
  public constructor(
    /** Exact same-host file used for cross-process exclusion. */
    private readonly lockPath: string,
  ) {}

  /** Runs one operation after acquiring the same-host lock file. */
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    /** Prior queue tail that must settle before this caller acquires the file. */
    const previous = this.#tail;
    /** Releases this caller's position for the next process-local waiter. */
    let releaseQueue!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;

    /** Exclusive owner handle retained until the operation finishes. */
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await this.acquire();
      return await operation();
    } finally {
      if (handle !== undefined) {
        await handle.close();
        await rm(this.lockPath, { force: true });
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
    /** Exclusive handle proving this process owns the lock path. */
    const handle = await open(this.lockPath, "wx", 0o600);
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
      await rm(this.lockPath, { force: true });
      throw error;
    }
  }

  /** Clears only a well-formed owner for a PID proven absent; every other case fails closed. */
  private async clearStaleOwner(): Promise<boolean> {
    /** PID parsed from a well-formed owner record. */
    let pid: number;
    try {
      /** Untrusted owner-file value retained for closed shape validation. */
      const parsed: unknown = JSON.parse(await readFile(this.lockPath, "utf8"));
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
    await rm(this.lockPath, { force: true });
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
