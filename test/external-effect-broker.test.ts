// Verifies provider-backed external-effect intent ordering, recovery, and authorization.
import assert from "node:assert/strict";
import test from "node:test";

import { ExternalEffectBroker, ExternalEffectHandlerRegistry, finalizeAgentResult, finalizeRequest, InMemoryProvider, IndeterminateExternalEffectError, ProviderEffectJournal, type ExternalEffectHandler, type ExternalEffectObservation, type ProviderEnvironment, type WorkspaceSchemaDescriptor } from "../src/index.js";

const environment: ProviderEnvironment = { bootstrapParent: null, connection: {}, tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" }, type: "memory" };
const target: WorkspaceSchemaDescriptor = { digest: "target", providerType: "memory", tables: [], version: "v1" };

test("persists the complete intent before applying and replays its receipt", async () => {
  const provider = new InMemoryProvider(environment, target);
  let applications = 0;
  const handler = testHandler({ async apply() { applications += 1; return applied("commit-1"); } });
  const broker = brokerFor(provider, handler);
  const request = requestFor("git.commit", { message: "feat: add broker" });
  const first = await broker.execute(request);
  const second = await broker.execute(request);
  assert.equal(first.state, "applied");
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(applications, 1);
  const stored = await provider.getOptionalResource(`external-effect-intent/${request.effectId}`);
  assert.equal(stored?.kind, "system/external-effect-intent");
  assert.equal((stored?.body ?? "").includes('"state":"applied"'), true);
});

test("recovers a side effect accepted before its receipt was persisted", async () => {
  const provider = new InMemoryProvider(environment, target);
  let externalApplied = false;
  let applications = 0;
  const handler = testHandler({
    async apply() { applications += 1; externalApplied = true; throw new Error("connection lost after accept"); },
    async reconcile() { return externalApplied ? applied("branch-1") : notApplied(); },
  });
  const broker = brokerFor(provider, handler);
  const request = requestFor("git.commit", { message: "fix: recover" });
  await assert.rejects(broker.execute(request), IndeterminateExternalEffectError);
  const recovered = await broker.execute(request);
  assert.equal(recovered.state, "applied");
  assert.equal(applications, 1);
});

test("does not execute unauthorized or conflicting intents", async () => {
  const provider = new InMemoryProvider(environment, target);
  const broker = brokerFor(provider, testHandler());
  const result = finalizeAgentResult({ contextDigest: "a".repeat(64), definitionDigest: "b".repeat(64), outcome: "succeeded", payload: {}, proposedIntents: [{ kind: "git.commit", payload: {} }], runId: "run", schema: "agent-result-v1" });
  await assert.rejects(broker.executeResult(result, []), /not authorized/);
  const request = requestFor("git.commit", { message: "one" });
  await broker.execute(request);
  await assert.rejects(broker.execute({ ...request, payload: { message: "two" } }), /digest is invalid/);
});

function brokerFor(provider: InMemoryProvider, handler: ExternalEffectHandler): ExternalEffectBroker {
  const registry = new ExternalEffectHandlerRegistry(); registry.register(handler);
  return new ExternalEffectBroker(registry, new ProviderEffectJournal(provider));
}
function requestFor(kind: string, payload: Record<string, string>) { return finalizeRequest({ kind, payload, source: { contextDigest: "a".repeat(64), intentIndex: 0, resultDigest: "b".repeat(64), runId: "run" } }); }
function applied(id: string): ExternalEffectObservation { return { evidence: { verified: true }, externalIdentity: { id }, state: "applied" }; }
function notApplied(): ExternalEffectObservation { return { evidence: {}, externalIdentity: {}, state: "not_applied" }; }
function testHandler(overrides: Partial<ExternalEffectHandler> = {}): ExternalEffectHandler {
  return {
    id: "git-handler", kind: "git.commit", version: "1",
    async apply() { return applied("default"); }, async reconcile() { return notApplied(); }, validate() {}, ...overrides,
  };
}
