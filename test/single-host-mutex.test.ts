/** Collision-resistance coverage for same-host mutex identities. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SingleHostMutex,
  type SingleHostMutexIdentity,
  type SingleHostMutexRelease,
} from "../src/provider/notion/single-host-mutex.js";

test("mutex requires an explicit absolute coordination root", () => {
  assert.throws(
    () =>
      new SingleHostMutex(
        { environmentId: "environment", scope: "environment" },
        "relative",
      ),
    /Mutex root must be an absolute path/u,
  );
});

test("abandon closes the handle while preserving a durable fence", async () => {
  /** Test fixture for root. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-mutex-"));
  try {
    /** Test fixture for identity. */
    const identity = {
      environmentId: "environment",
      runId: "run-1",
      scope: "command",
    } as const;
    /** Release callback for the acquired lease or mutex. */
    const release = await new SingleHostMutex(identity, root).lock({
      reclaimable: false,
    });
    await release.abandon();
    await assert.rejects(
      new SingleHostMutex(identity, root).lock(),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "EEXIST",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

/** Proves two identities can hold distinct lock files at the same time. */
async function assertDistinctLockIdentities(
  first: SingleHostMutexIdentity,
  second: SingleHostMutexIdentity,
) {
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
    { environmentId, scope: "environment" },
    { environmentId, runId: "run-1", scope: "command" },
  );
});

test("sanitization-equivalent identities use distinct mutex files", async () => {
  await assertDistinctLockIdentities(
    { environmentId: "environment/x", scope: "environment" },
    { environmentId: "environment?x", scope: "environment" },
  );
});

test("environment and command lock domains cannot alias", async () => {
  await assertDistinctLockIdentities(
    { environmentId: "alpha.command.run-1", scope: "environment" },
    { environmentId: "alpha", runId: "run-1", scope: "command" },
  );
  await assertDistinctLockIdentities(
    {
      environmentId: "alpha",
      runId: "beta.command.gamma",
      scope: "command",
    },
    {
      environmentId: "alpha.command.beta",
      runId: "gamma",
      scope: "command",
    },
  );
});

test("byte-distinct Unicode identities use distinct mutex files", async () => {
  await assertDistinctLockIdentities(
    { environmentId: "\u00e9", scope: "environment" },
    { environmentId: "e\u0301", scope: "environment" },
  );
});

test("dead reclaimable owners are recovered", async () => {
  /** Isolated directory containing the artificial stale lock. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-mutex-"));
  try {
    /** Mutex used to discover its collision-resistant lock path. */
    const mutex = new SingleHostMutex(
      { environmentId: "environment", scope: "environment" },
      root,
    );
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

test("concurrent stale recovery admits exactly one mutex owner", async () => {
  /** Isolated directory containing the shared stale primary. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-mutex-"));
  try {
    /** Test fixture for identity. */
    const identity = {
      environmentId: "environment",
      scope: "environment",
    } as const;
    /** Mutex used to discover its primary lock path. */
    const seed = new SingleHostMutex(identity, root);
    /** Test fixture for release seed. */
    const releaseSeed = await seed.lock();
    /** Exact primary path shared by every contender. */
    const path = join(root, (await readdir(root))[0]!);
    await releaseSeed();
    await writeFile(
      path,
      JSON.stringify({
        pid: Number.MAX_SAFE_INTEGER,
        reclaimable: true,
        startedAt: new Date(0).toISOString(),
      }),
      "utf8",
    );

    /** Test fixture for attempts. */
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        new SingleHostMutex(identity, root).lock(),
      ),
    );
    /** Test fixture for acquired. */
    const acquired = attempts.filter(
      (result): result is PromiseFulfilledResult<SingleHostMutexRelease> =>
        result.status === "fulfilled",
    );
    assert.equal(acquired.length, 1);
    assert.equal(
      attempts.filter((result) => result.status === "rejected").length,
      7,
    );
    assert.deepEqual(await readdir(root), [path.split(/[\\/]/u).at(-1)]);
    await acquired[0]!.value();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an abandoned recovery guard fails closed", async () => {
  /** Isolated directory containing the primary and recovery guard. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-mutex-"));
  try {
    /** Test fixture for identity. */
    const identity = {
      environmentId: "environment",
      scope: "environment",
    } as const;
    /** Test fixture for mutex. */
    const mutex = new SingleHostMutex(identity, root);
    /** Release callback for the acquired lease or mutex. */
    const release = await mutex.lock();
    /** Exact primary path used to derive its sidecar guard path. */
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
    await writeFile(
      `${path}.recovery`,
      "operator verification required",
      "utf8",
    );

    await assert.rejects(
      mutex.lock(),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "EEXIST",
    );
    assert.deepEqual(
      (await readdir(root)).sort(),
      [
        path.split(/[\\/]/u).at(-1)!,
        `${path.split(/[\\/]/u).at(-1)!}.recovery`,
      ].sort(),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("dead command owners remain fenced until verified recovery", async () => {
  /** Isolated directory containing the artificial orphaned lease. */
  const root = await mkdtemp(join(tmpdir(), "agent-task-manager-mutex-"));
  try {
    /** Command mutex whose lock path is populated with an orphaned lease. */
    const identity = {
      environmentId: "environment",
      runId: "run-1",
      scope: "command",
    } as const;
    /** Test fixture for mutex. */
    const mutex = new SingleHostMutex(identity, root);
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
      new SingleHostMutex(identity, root).lock(),
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
