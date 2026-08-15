/** Serializes in-process Notion writes and rejects live same-host writers through a shared lock file. */
import { open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class SingleHostMutex {
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();

  public constructor(identity: string, root = tmpdir()) {
    this.#path = join(root, `agent-task-manager-${safeName(identity)}.lock`);
  }

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

  private async acquire() {
    try {
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

function safeName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[^a-z0-9_.-]+/giu, "-")
    .slice(0, 120);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
