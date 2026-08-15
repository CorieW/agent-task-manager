// Verifies independent child nodes, dependency receipts, and provider-backed resume.
import assert from "node:assert/strict";
import test from "node:test";

import { canonicalize, ProviderChildAgentWaveEffects, sha256, toJsonValue, InMemoryProvider, type ChildAgentNodeDriver, type ExternalEffectObservation, type ProviderEnvironment, type WorkspaceSchemaDescriptor } from "../src/index.js";

const environment: ProviderEnvironment = { bootstrapParent: null, connection: {}, tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" }, type: "memory" };
const target: WorkspaceSchemaDescriptor = { digest: "target", providerType: "memory", tables: [], version: "v1" };

test("runs dependency-ordered nodes and persists each receipt in Resources", async () => {
  const provider = new InMemoryProvider(environment, target); await context(provider, "context/a"); await context(provider, "context/b");
  const order: string[] = [];
  const driver: ChildAgentNodeDriver = {
    async reconcile() { return notApplied; },
    async run(input) { order.push(input.node.nodeKey); if (input.node.nodeKey === "b") assert.deepEqual(input.dependencyReceipts.map((receipt) => receipt.nodeKey), ["a"]); return { evidence: { resultDigest: sha256(input.node.nodeKey) }, externalIdentity: { runId: input.nodeEffectId }, state: "applied" }; },
  };
  const effects = new ProviderChildAgentWaveEffects(provider, driver);
  const payload = { maxConcurrency: 2, nodes: [
    { contextResource: "context/a", definitionId: "reviewer", dependsOn: [], nodeKey: "a" },
    { contextResource: "context/b", definitionId: "reviewer", dependsOn: ["a"], nodeKey: "b" },
  ] } as const;
  const result = await effects.apply({ effectId: "c".repeat(64), payload });
  assert.equal(result.state, "applied"); assert.deepEqual(order, ["a", "b"]);
  assert.equal((await effects.reconcile({ effectId: "c".repeat(64), payload })).state, "applied");
  assert.equal(order.length, 2);
});

async function context(provider: InMemoryProvider, key: string): Promise<void> { const body = canonicalize(toJsonValue({ input: key })); await provider.putResource({ body, dependencies: [], digest: sha256(body), idempotencyKey: `seed:${key}`, key, kind: "agent/context", state: "active", version: "v1" }); }
const notApplied: ExternalEffectObservation = { evidence: {}, externalIdentity: {}, state: "not_applied" };
