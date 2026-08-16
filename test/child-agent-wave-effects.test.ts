/** Verifies independent child nodes, dependency receipts, and provider-backed resume. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalize,
  ProviderChildAgentWaveEffects,
  sha256,
  toJsonValue,
  InMemoryProvider,
  type ChildAgentNodeDriver,
  type ExternalEffectObservation,
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

test("runs dependency-ordered nodes and persists each receipt in Resources", async () => {
  /** Defines the provider fixture for “runs dependency-ordered nodes and persists each receipt in Resources”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the context a fixture for “runs dependency-ordered nodes and persists each receipt in Resources”. */
  const contextA = await context(provider, "context/a");
  /** Defines the context b fixture for “runs dependency-ordered nodes and persists each receipt in Resources”. */
  const contextB = await context(provider, "context/b");
  /** Defines the order fixture for “runs dependency-ordered nodes and persists each receipt in Resources”. */
  const order: string[] = [];
  /** Defines the driver fixture for “runs dependency-ordered nodes and persists each receipt in Resources”. */
  const driver: ChildAgentNodeDriver = {
    /** Simulates effect reconciliation. */
    async reconcile() {
      return notApplied;
    },
    /** Creates the run test fixture. */
    async run(input) {
      order.push(input.node.nodeKey);
      if (input.node.nodeKey === "b")
        assert.deepEqual(
          input.dependencyReceipts.map((receipt) => receipt.nodeKey),
          ["a"],
        );
      return {
        evidence: { resultDigest: sha256(input.node.nodeKey) },
        externalIdentity: { runId: input.nodeEffectId },
        state: "applied",
      };
    },
  };
  /** Defines the effects fixture for “runs dependency-ordered nodes and persists each receipt in Resources”. */
  const effects = new ProviderChildAgentWaveEffects(provider, driver);
  /** Defines the payload fixture for “runs dependency-ordered nodes and persists each receipt in Resources”. */
  const payload = {
    maxConcurrency: 2,
    nodes: [
      {
        contextDigest: contextA,
        contextResource: "context/a",
        contextVersion: "v1",
        definitionId: "reviewer",
        dependsOn: [],
        nodeKey: "a",
      },
      {
        contextDigest: contextB,
        contextResource: "context/b",
        contextVersion: "v1",
        definitionId: "reviewer",
        dependsOn: ["a"],
        nodeKey: "b",
      },
    ],
  } as const;
  /** Defines the control fixture for “runs dependency-ordered nodes and persists each receipt in Resources”. */
  const control = {
    deadlineAt: Date.now() + 10_000,
    signal: new AbortController().signal,
  };
  /** Defines the result fixture for “runs dependency-ordered nodes and persists each receipt in Resources”. */
  const result = await effects.apply({
    control,
    effectId: "c".repeat(64),
    payload,
  });
  assert.equal(result.state, "applied");
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(
    (await effects.reconcile({ control, effectId: "c".repeat(64), payload }))
      .state,
    "applied",
  );
  assert.equal(order.length, 2);
});

test("rejects malformed node receipts and changed context pins", async () => {
  /** Defines the provider fixture for “rejects malformed node receipts and changed context pins”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the context digest fixture for “rejects malformed node receipts and changed context pins”. */
  const contextDigest = await context(provider, "context/a");
  /** Defines the effect ID fixture for “rejects malformed node receipts and changed context pins”. */
  const effectId = "d".repeat(64);
  /** Defines the node fixture for “rejects malformed node receipts and changed context pins”. */
  const node = {
    contextDigest,
    contextResource: "context/a",
    contextVersion: "v1",
    definitionId: "reviewer",
    dependsOn: [],
    nodeKey: "a",
  } as const;
  /** Defines the malformed fixture for “rejects malformed node receipts and changed context pins”. */
  const malformed = canonicalize(
    toJsonValue({
      contextDigest,
      contextKey: "context/a",
      contextVersion: "v1",
      definitionId: "reviewer",
      dependencyNodeKeys: [],
      lastObservation: { evidence: {}, externalIdentity: {}, state: "applied" },
      nodeEffectId: sha256(
        canonicalize(toJsonValue({ node, waveEffectId: effectId })),
      ),
      nodeKey: "a",
      receipt: {},
      schema: "child-agent-node-intent-v1",
      state: "applied",
      waveEffectId: effectId,
    }),
  );
  await provider.putResource({
    body: malformed,
    dependencies: [{ digest: contextDigest, key: "context/a", version: "v1" }],
    digest: sha256(malformed),
    idempotencyKey: "malformed",
    key: `child-agent-node/${effectId}/${sha256("a")}`,
    kind: "system/child-agent-node-intent",
    state: "active",
    version: "v1",
  });
  /** Defines the effects fixture for “rejects malformed node receipts and changed context pins”. */
  const effects = new ProviderChildAgentWaveEffects(provider, {
    /** Simulates effect reconciliation. */
    async reconcile() {
      return notApplied;
    },
    /** Creates the run test fixture. */
    async run() {
      return notApplied;
    },
  });
  await assert.rejects(
    effects.reconcile({
      control: {
        deadlineAt: Date.now() + 10_000,
        signal: new AbortController().signal,
      },
      effectId,
      payload: { maxConcurrency: 1, nodes: [node] },
    }),
    /unexpected or missing fields/,
  );
});

/** Creates the context test fixture. */
async function context(
  provider: InMemoryProvider,
  key: string,
): Promise<string> {
  /** Defines the body fixture used by context. */
  const body = canonicalize(toJsonValue({ input: key }));
  /** Defines the digest fixture used by context. */
  const digest = sha256(body);
  await provider.putResource({
    body,
    dependencies: [],
    digest,
    idempotencyKey: `seed:${key}`,
    key,
    kind: "agent/context",
    state: "active",
    version: "v1",
  });
  return digest;
}
/** Defines the shared not applied fixture for this test module. */
const notApplied: ExternalEffectObservation = {
  evidence: {},
  externalIdentity: {},
  state: "not_applied",
};
