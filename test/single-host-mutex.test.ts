/** Collision-resistance coverage for same-host mutex identities. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

test("dead reclaimable owners are recovered", async () => {
  /** Isolated directory containing the artificial stale lock. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-mutex-"));
  try {
    /** Mutex used to discover its collision-resistant lock path. */
    const mutex = new SingleHostMutex("environment", root);
    /** Release callback for the temporary path-discovery acquisition. */
    const release = await mutex.lock();
    /** Exact lock path created for this identity. */
    const path = join(root, (await readdir(root))[0]!);
    await release();
    await writeFile(
      path,
      JSON.stringify({
        pid: Number.MAX_SAFE_INTEGER,
        reclaimable: true,
        startedAt: new Date(0).toISOString(),
      }),
      "utf8",
    );
    /** Release callback proves the dead owner was reclaimed. */
    const releaseRecovered = await mutex.lock();
    await releaseRecovered();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("dead command owners remain fenced until verified recovery", async () => {
  /** Isolated directory containing the artificial orphaned lease. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-mutex-"));
  try {
    /** Command mutex whose lock path is populated with an orphaned lease. */
    const mutex = new SingleHostMutex("environment.command.run-1", root);
    /** Release callback for the temporary path-discovery acquisition. */
    const release = await mutex.lock({ reclaimable: false });
    /** Exact lock path created for this command identity. */
    const path = join(root, (await readdir(root))[0]!);
    await release();
    await writeFile(
      path,
      JSON.stringify({
        pid: Number.MAX_SAFE_INTEGER,
        reclaimable: false,
        startedAt: new Date(0).toISOString(),
      }),
      "utf8",
    );
    await assert.rejects(
      new SingleHostMutex("environment.command.run-1", root).lock(),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "EEXIST",
    );

    // Operators may remove the fence only after verifying broker containment stopped.
    await rm(path);
    /** Release callback proves deliberate recovery restores the lease. */
    const releaseRecovered = await mutex.lock({ reclaimable: false });
    await releaseRecovered();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
