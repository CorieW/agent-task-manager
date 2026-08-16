/** Verifies provider-backed workspace ownership is durable, exclusive, and releasable. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryProvider,
  ProviderWorkspaceOwnershipStore,
  type ProviderEnvironment,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";

/** Defines the shared environment fixture for this test module. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: "e", resources: "r", agents: "a", tasks: "t" },
  type: "memory",
};
/** Defines the shared target fixture for this test module. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};

test("persists and verifies workspace ownership through provider Resources", async () => {
  /** Defines the provider fixture for “persists and verifies workspace ownership through provider Resources”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the store fixture for “persists and verifies workspace ownership through provider Resources”. */
  const store = new ProviderWorkspaceOwnershipStore(provider);
  /** Defines the provision effect ID fixture for “persists and verifies workspace ownership through provider Resources”. */
  const provisionEffectId = "a".repeat(64);
  /** Defines the claimed fixture for “persists and verifies workspace ownership through provider Resources”. */
  const claimed = await store.claim({
    mode: "worktree",
    provisionEffectId,
    repositoryId: "repo",
    workspaceKey: "task-1",
  });
  assert.deepEqual(
    await new ProviderWorkspaceOwnershipStore(provider).get("task-1"),
    claimed,
  );
  await assert.rejects(
    store.claim({
      mode: "worktree",
      provisionEffectId: "b".repeat(64),
      repositoryId: "repo",
      workspaceKey: "task-1",
    }),
    /owned by another effect/,
  );
  /** Defines the released fixture for “persists and verifies workspace ownership through provider Resources”. */
  const released = await store.release({
    releaseEffectId: "c".repeat(64),
    repositoryId: "repo",
    workspaceKey: "task-1",
  });
  assert.equal(released.state, "released");
  assert.equal((await store.get("task-1"))?.releaseEffectId, "c".repeat(64));
});
