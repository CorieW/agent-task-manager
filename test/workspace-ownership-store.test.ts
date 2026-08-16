/** Verifies provider-backed workspace ownership is durable, exclusive, and releasable. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryProvider,
  ProviderWorkspaceOwnershipStore,
  type ProviderEnvironment,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";

/** Supplies the provider environment shared by the scenarios. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: "e", resources: "r", agents: "a", tasks: "t" },
  type: "memory",
};

/** Supplies the canonical workspace schema target. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};

test("persists and verifies workspace ownership through Operations", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Exercises provider-backed persistence for the scenario. */
  const store = new ProviderWorkspaceOwnershipStore(provider);
  /** Identifies the workspace-provisioning intent later released. */
  const provisionEffectId = "a".repeat(64);
  /** Captures the ownership claim persisted by the store. */
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
  /** Captures ownership state after the release operation. */
  const released = await store.release({
    releaseEffectId: "c".repeat(64),
    repositoryId: "repo",
    workspaceKey: "task-1",
  });
  assert.equal(released.state, "released");
  assert.equal((await store.get("task-1"))?.releaseEffectId, "c".repeat(64));
});
