/** Serializes in-process Notion writes and rejects live same-host writers through a shared lock file. */
import { open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Implements single-host mutex. */
export class SingleHostMutex {
  /** Contains path for single-host mutex. */
  readonly #path: string;
  /** Contains tail for single-host mutex. */
  #tail: Promise<void> = Promise.resolve();

  /** Initializes single-host mutex. */
  public constructor(identity: string, root = tmpdir()) {
    this.#path = join(root, `agent-task-manager-${safeName(identity)}.lock`);
  }

  /** Runs one callback under in-process ordering and the same-host lock file. */
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    /** Holds the `previous` intermediate used by `run`. */
    const previous = this.#tail;
    /** Holds the `releaseQueue` intermediate used by `run`. */
    let releaseQueue!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    /** Holds the `handle` intermediate used by `run`. */
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

  /** Acquires acquire. */
  private async acquire() {
    try {
      /** Holds the `handle` intermediate used by `acquire`. */
      const handle = await open(this.#path, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        "utf8",
      );
      return handle;
    } catch (error) {
      if (!isAlreadyExists(error) || !(await this.clearStaleOwner()))
        throw error;
      /** Holds the `handle` intermediate used by `acquire`. */
      const handle = await open(this.#path, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        "utf8",
      );
      return handle;
    }
  }

  /** Clears stale owner. */
  private async clearStaleOwner(): Promise<boolean> {
    /** Holds the `pid` intermediate used by `clearStaleOwner`. */
    let pid: number;
    try {
      /** Holds the `parsed` intermediate used by `clearStaleOwner`. */
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

/** Converts an environment identity into a bounded lock-file name. */
function safeName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[^a-z0-9_.-]+/giu, "-")
    .slice(0, 120);
}

/** Reports whether already exists. */
function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** Reports whether process alive. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
