/** Serializes one logical execution across cooperating processes on the same host. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostFileMutex } from "../core/host-file-mutex.js";

/** Process-local queue and borrower count for one execution identity. */
interface ExecutionMutexEntry {
  /** Filesystem mutex shared by every current borrower. */
  readonly mutex: HostFileMutex;
  /** Running or queued callers that still depend on this entry. */
  users: number;
}

/** Reuses one in-process queue while an execution identity has borrowers. */
const mutexes = new Map<string, ExecutionMutexEntry>();

/** Runs an execution while holding its host-local filesystem mutex. */
export async function withSingleHostExecutionLock<T>(
  identity: string,
  operation: () => Promise<T>,
): Promise<T> {
  /** Shared queue entry retained while any caller is running or waiting. */
  const entry =
    mutexes.get(identity) ??
    ({
      mutex: new HostFileMutex(
        join(tmpdir(), `agent-task-manager-${identity}.lock`),
      ),
      users: 0,
    } satisfies ExecutionMutexEntry);
  mutexes.set(identity, entry);
  entry.users += 1;
  try {
    return await entry.mutex.run(operation);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(`Agent execution is already active: ${identity}`, {
        cause: error,
      });
    throw error;
  } finally {
    entry.users -= 1;
    if (entry.users === 0 && mutexes.get(identity) === entry)
      mutexes.delete(identity);
  }
}
