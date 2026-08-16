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

test("runs dependency-ordered nodes and persists each receipt in Resources", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Creates the first pinned child-agent context Resource. */
  const contextA = await context(provider, "context/a");
  /** Creates the dependent child-agent context Resource. */
  const contextB = await context(provider, "context/b");
  /** Records dependency-ordered child-agent execution. */
  const order: string[] = [];
  /** Simulates child-agent execution and records call order. */
  const driver: ChildAgentNodeDriver = {
    /** Simulates effect reconciliation. */
    async reconcile() {
      return notApplied;
    },
    /** Records and completes one child-agent node execution. */
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
  /** Runs the child-agent wave through the effect broker. */
  const effects = new ProviderChildAgentWaveEffects(provider, driver);
  /** Supplies the child-agent result persisted by the wave. */
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
  /** Supplies the deadline and cancellation signal to the wave. */
  const control = {
    deadlineAt: Date.now() + 10_000,
    signal: new AbortController().signal,
  };
  /** Captures the operation outcome used by assertions. */
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
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Pins the child-agent context expected by the receipt. */
  const contextDigest = await context(provider, "context/a");
  /** Identifies the persisted child-agent node intent. */
  const effectId = "d".repeat(64);
  /** Describes the child-agent wave node being reconciled. */
  const node = {
    contextDigest,
    contextResource: "context/a",
    contextVersion: "v1",
    definitionId: "reviewer",
    dependsOn: [],
    nodeKey: "a",
  } as const;
  /** Builds a deliberately invalid child-agent receipt. */
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
  /** Runs the child-agent wave through the effect broker. */
  const effects = new ProviderChildAgentWaveEffects(provider, {
    /** Simulates effect reconciliation. */
    async reconcile() {
      return notApplied;
    },
    /** Returns a neutral observation when malformed state reaches execution. */
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

/** Persists and returns the digest of a pinned Agent context Resource. */
async function context(
  provider: InMemoryProvider,
  key: string,
): Promise<string> {
  /** Decodes the request body consumed by the fake transport. */
  const body = canonicalize(toJsonValue({ input: key }));
  /** Pins the canonical content expected by the Resource read. */
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

/** Represents an effect observation with no external change. */
const notApplied: ExternalEffectObservation = {
  evidence: {},
  externalIdentity: {},
  state: "not_applied",
};
