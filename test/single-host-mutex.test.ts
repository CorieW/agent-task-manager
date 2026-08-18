/** Collision-resistance coverage for same-host mutex identities. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SingleHostMutex } from "../src/provider/notion/single-host-mutex.js";

/** Proves two identities can hold distinct lock files at the same time. */
async function assertDistinctLockIdentities(first: string, second: string) {
  /** Isolated directory containing only this test's lock files. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-mutex-"));
  try {
    /** Release callback for the first identity's active lock. */
    const releaseFirst = await new SingleHostMutex(first, root).lock();
    try {
      /** Release callback proves the second identity did not alias the first. */
      const releaseSecond = await new SingleHostMutex(second, root).lock();
      await releaseSecond();
    } finally {
      await releaseFirst();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("long environment and run identities use distinct mutex files", async () => {
  /** Environment identity long enough to consume the former filename limit. */
  const environmentId = "a".repeat(120);
  await assertDistinctLockIdentities(
    environmentId,
    `${environmentId}.command.run-1`,
  );
});

test("sanitization-equivalent identities use distinct mutex files", async () => {
  await assertDistinctLockIdentities("environment/x", "environment?x");
});
