/** Serializes in-process Notion writes and rejects live same-host writers through a shared lock file. */
import { createHash } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Controls whether a dead owning process is sufficient to recover a lock. */
export interface SingleHostMutexLockOptions {
  /** Whether a dead owning process permits automatic lock recovery. */
  readonly reclaimable?: boolean;
}

/** Releases a mutex normally or abandons its durable file as a fence. */
export interface SingleHostMutexRelease {
  (): Promise<void>;
  /** Closes local ownership while preserving the durable mutex fence. */
  abandon(): Promise<void>;
}

/** Domain-separated identity used to coordinate one environment or command run. */
export type SingleHostMutexIdentity =
  | {
      /** Stable identity used to isolate one managed environment. */
      readonly environmentId: string;
      /** Environment-wide lock scope. */
      readonly scope: "environment";
    }
  | {
      /** Stable identity used to isolate one managed environment. */
      readonly environmentId: string;
      /** Harness-supplied idempotency identity of the run attempt. */
      readonly runId: string;
      /** Run-specific lock scope. */
      readonly scope: "command";
    };

/** Serializes local processes with recoverable filesystem lock files. */
export class SingleHostMutex {
  /** Absolute path of the primary lock file. */
  readonly #path: string;
  /** Fail-closed sidecar that serializes stale-primary recovery. */
  readonly #recoveryPath: string;
  /** Per-key promise tail that serializes mutex callers. */
  #tail: Promise<void> = Promise.resolve();

  /** Initializes a mutex inside a host-private coordination directory. */
  public constructor(identity: SingleHostMutexIdentity, root: string) {
    if (!isAbsolute(root))
      throw new TypeError("Mutex root must be an absolute path");
    this.#path = join(root, `agent-task-manager-${safeName(identity)}.lock`);
    this.#recoveryPath = `${this.#path}.recovery`;
  }

  /** Runs one callback under in-process ordering and the same-host lock file. */
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    /** Release callback for the acquired lease or mutex. */
    const release = await this.lock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  /** Acquires the mutex until the returned release callback is awaited. */
  public async lock(
    options: SingleHostMutexLockOptions = {},
  ): Promise<SingleHostMutexRelease> {
    /** Prior queue tail awaited before attempting the filesystem lock. */
    const previous = this.#tail;
    /** Callback that releases this caller's queue position. */
    let releaseQueue!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    /** Exclusive primary-lock handle owned until release or abandonment. */
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await this.acquireFile(options.reclaimable ?? true);
    } catch (error) {
      releaseQueue();
      throw error;
    }
    /** Whether this lock release has already completed. */
    let finished = false;
    /** Idempotent finalizer for the lock handle and queue position. */
    const finish = async (remove: boolean): Promise<void> => {
      if (finished) return;
      finished = true;
      try {
        try {
          await handle.close();
        } finally {
          if (remove) await rm(this.#path, { force: true });
        }
      } finally {
        releaseQueue();
      }
    };
    return Object.assign(async () => finish(true), {
      abandon: async () => finish(false),
    });
  }

  /** Acquires the lock, clearing one stale owner before a single retry. */
  private async acquireFile(reclaimable: boolean) {
    try {
      return await this.createLock(reclaimable);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return this.recoverStaleOwner(error, reclaimable);
    }
  }

  /** Revalidates and replaces one stale primary under an exclusive sidecar. */
  private async recoverStaleOwner(contention: unknown, reclaimable: boolean) {
    /** Exclusive recovery sidecar; abandoned sidecars are never auto-reclaimed. */
    let recoveryHandle: Awaited<ReturnType<typeof open>>;
    try {
      recoveryHandle = await open(this.#recoveryPath, "wx", 0o600);
    } catch {
      throw contention;
    }
    try {
      if (!(await this.staleOwnerIsReclaimable())) throw contention;
      await rm(this.#path, { force: true });
      return await this.createLock(reclaimable);
    } finally {
      try {
        await recoveryHandle.close();
      } finally {
        await rm(this.#recoveryPath, { force: true });
      }
    }
  }

  /** Creates and initializes a lock, restoring the unlocked state on failure. */
  private async createLock(reclaimable: boolean) {
    /** Exclusively created lock handle owned by this acquisition attempt. */
    const handle = await open(this.#path, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          reclaimable,
          startedAt: new Date().toISOString(),
        }),
        "utf8",
      );
      return handle;
    } catch (error) {
      try {
        await handle.close();
      } catch {
        // Preserve the initialization failure that made this lock unusable.
      }
      try {
        await rm(this.#path, { force: true });
      } catch {
        // The primary initialization failure remains the actionable cause.
      }
      throw error;
    }
  }

  /** Reports whether the current primary explicitly permits dead-owner recovery. */
  private async staleOwnerIsReclaimable(): Promise<boolean> {
    /** Process identifier recorded by the primary lock. */
    let pid: number;
    try {
      /** Parsed primary-lock record re-read while holding the recovery sidecar. */
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("reclaimable" in parsed) ||
        parsed.reclaimable !== true ||
        !("pid" in parsed) ||
        typeof parsed.pid !== "number"
      )
        return false;
      pid = parsed.pid;
    } catch {
      return false;
    }
    return !isProcessAlive(pid);
  }
}

/** Converts a full normalized identity into a bounded, collision-resistant lock-file name. */
function safeName(identity: SingleHostMutexIdentity): string {
  /** Injective tuple encoding whose exact bytes bind the identity and its domain. */
  const encoded =
    identity.scope === "environment"
      ? JSON.stringify(["environment", identity.environmentId])
      : JSON.stringify(["command", identity.environmentId, identity.runId]);
  /** Human-readable source whose normalization is cosmetic only. */
  const display =
    identity.scope === "environment"
      ? `environment-${identity.environmentId}`
      : `command-${identity.environmentId}-${identity.runId}`;
  /** Human-readable prefix retained for local lock-file diagnostics. */
  const prefix =
    display
      .normalize("NFC")
      .replace(/[^a-z0-9_.-]+/giu, "-")
      .slice(0, 48) || "lock";
  /** Prevents domains, delimiters, Unicode, and truncation from aliasing identities. */
  const digest = createHash("sha256").update(encoded, "utf8").digest("hex");
  return `${prefix}-${digest}`;
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
