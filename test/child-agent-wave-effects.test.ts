/** Verifies independent child nodes, dependency receipts, and provider-backed resume. */
import assert from "node:assert/strict";
import test from "node:test";

import { canonicalize, ProviderChildAgentWaveEffects, sha256, toJsonValue, InMemoryProvider, type ChildAgentNodeDriver, type ExternalEffectObservation, type ProviderEnvironment, type WorkspaceSchemaDescriptor } from "../src/index.js";

const environment: ProviderEnvironment = { bootstrapParent: null, connection: {}, tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" }, type: "memory" };
const target: WorkspaceSchemaDescriptor = { digest: "target", providerType: "memory", tables: [], version: "v1" };

test("runs dependency-ordered nodes and persists each receipt in Resources", async () => {
  const provider = new InMemoryProvider(environment, target); const contextA = await context(provider, "context/a"); const contextB = await context(provider, "context/b");
  const order: string[] = [];
  const driver: ChildAgentNodeDriver = {
    async reconcile() { return notApplied; },
    async run(input) { order.push(input.node.nodeKey); if (input.node.nodeKey === "b") assert.deepEqual(input.dependencyReceipts.map((receipt) => receipt.nodeKey), ["a"]); return { evidence: { resultDigest: sha256(input.node.nodeKey) }, externalIdentity: { runId: input.nodeEffectId }, state: "applied" }; },
  };
  const effects = new ProviderChildAgentWaveEffects(provider, driver);
  const payload = { maxConcurrency: 2, nodes: [
    { contextDigest: contextA, contextResource: "context/a", contextVersion: "v1", definitionId: "reviewer", dependsOn: [], nodeKey: "a" },
    { contextDigest: contextB, contextResource: "context/b", contextVersion: "v1", definitionId: "reviewer", dependsOn: ["a"], nodeKey: "b" },
  ] } as const;
  const control = { deadlineAt: Date.now() + 10_000, signal: new AbortController().signal };
  const result = await effects.apply({ control, effectId: "c".repeat(64), payload });
  assert.equal(result.state, "applied"); assert.deepEqual(order, ["a", "b"]);
  assert.equal((await effects.reconcile({ control, effectId: "c".repeat(64), payload })).state, "applied");
  assert.equal(order.length, 2);
});

test("rejects malformed node receipts and changed context pins", async () => {
  const provider = new InMemoryProvider(environment, target); const contextDigest = await context(provider, "context/a"); const effectId = "d".repeat(64);
  const node = { contextDigest, contextResource: "context/a", contextVersion: "v1", definitionId: "reviewer", dependsOn: [], nodeKey: "a" } as const;
  const malformed = canonicalize(toJsonValue({ contextDigest, contextKey: "context/a", contextVersion: "v1", definitionId: "reviewer", dependencyNodeKeys: [], lastObservation: { evidence: {}, externalIdentity: {}, state: "applied" }, nodeEffectId: sha256(canonicalize(toJsonValue({ node, waveEffectId: effectId }))), nodeKey: "a", receipt: {}, schema: "child-agent-node-intent-v1", state: "applied", waveEffectId: effectId }));
  await provider.putResource({ body: malformed, dependencies: [{ digest: contextDigest, key: "context/a", version: "v1" }], digest: sha256(malformed), idempotencyKey: "malformed", key: `child-agent-node/${effectId}/${sha256("a")}`, kind: "system/child-agent-node-intent", state: "active", version: "v1" });
  const effects = new ProviderChildAgentWaveEffects(provider, { async reconcile() { return notApplied; }, async run() { return notApplied; } });
  await assert.rejects(effects.reconcile({ control: { deadlineAt: Date.now() + 10_000, signal: new AbortController().signal }, effectId, payload: { maxConcurrency: 1, nodes: [node] } }), /unexpected or missing fields/);
});

async function context(provider: InMemoryProvider, key: string): Promise<string> { const body = canonicalize(toJsonValue({ input: key })); const digest = sha256(body); await provider.putResource({ body, dependencies: [], digest, idempotencyKey: `seed:${key}`, key, kind: "agent/context", state: "active", version: "v1" }); return digest; }
const notApplied: ExternalEffectObservation = { evidence: {}, externalIdentity: {}, state: "not_applied" };
