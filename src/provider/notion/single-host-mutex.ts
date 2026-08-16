/** Serializes in-process Notion writes and rejects live same-host writers through a shared lock file. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostFileMutex } from "../../core/host-file-mutex.js";

/** Preserves Notion's provider-specific lock naming over the shared mutex primitive. */
export class SingleHostMutex {
  /** Shared lock primitive bound to the provider-specific file identity. */
  readonly #mutex: HostFileMutex;

  /** Binds an environment identity to a normalized lock path under the chosen root. */
  public constructor(identity: string, root = tmpdir()) {
    this.#mutex = new HostFileMutex(
      join(root, `agent-task-manager-${safeName(identity)}.lock`),
    );
  }

  /** Runs one callback under in-process ordering and the same-host lock file. */
  public async run<T>(operation: () => Promise<T>): Promise<T> {
    return this.#mutex.run(operation);
  }
}

/** Converts an environment identity into a bounded lock-file name. */
function safeName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[^a-z0-9_.-]+/giu, "-")
    .slice(0, 120);
}
