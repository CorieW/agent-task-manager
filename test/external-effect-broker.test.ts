// Verifies provider-backed external-effect intent ordering, recovery, and authorization.
import assert from "node:assert/strict";
import test from "node:test";

import { ExternalEffectBroker, finalizeAgentResult, finalizeRequest, InMemoryProvider, IndeterminateExternalEffectError, ProviderEffectJournal, resolveExternalEffectEnvironment, type ExternalEffectHandler, type ExternalEffectObservation, type ProviderEnvironment, type WorkspaceSchemaDescriptor } from "../src/index.js";

const environment: ProviderEnvironment = { bootstrapParent: null, connection: {}, tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" }, type: "memory" };
const target: WorkspaceSchemaDescriptor = { digest: "target", providerType: "memory", tables: [], version: "v1" };

test("persists the complete intent before applying and replays its receipt", async () => {
  const provider = new InMemoryProvider(environment, target);
  let applications = 0;
  const handler = testHandler({ async apply() { applications += 1; return applied("commit-1"); } });
  const broker = brokerFor(provider, handler);
  const request = requestFor("git.commit", { message: "feat: add broker" });
  const first = await broker.execute(request, deadline());
  const second = await broker.execute(request, deadline());
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
  await assert.rejects(broker.execute(request, deadline()), IndeterminateExternalEffectError);
  const recovered = await broker.execute(request, deadline());
  assert.equal(recovered.state, "applied");
  assert.equal(applications, 1);
});

test("does not execute unauthorized or conflicting intents", async () => {
  const provider = new InMemoryProvider(environment, target);
  const broker = brokerFor(provider, testHandler(), false);
  const result = finalizeAgentResult({ contextDigest: "a".repeat(64), definitionDigest: "b".repeat(64), outcome: "succeeded", payload: {}, proposedIntents: [{ kind: "git.commit", payload: {} }], runId: "run", schema: "agent-result-v1" });
  await assert.rejects(broker.executeResult(result, deadline()), /not authorized/);
  const authorized = brokerFor(provider, testHandler());
  const request = requestFor("git.commit", { message: "one" });
  await authorized.execute(request, deadline());
  await assert.rejects(authorized.execute({ ...request, payload: { message: "two" } }, deadline()), /digest is invalid/);
});

test("serializes concurrent execution of one effect identity", async () => {
  const provider = new InMemoryProvider(environment, target); let applications = 0;
  const broker = brokerFor(provider, testHandler({ async apply() { applications += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return applied("once"); } }));
  const request = requestFor("git.commit", { message: "feat: once" });
  const [left, right] = await Promise.all([broker.execute(request, deadline()), broker.execute(request, deadline())]);
  assert.equal(applications, 1); assert.deepEqual(left.receipt, right.receipt);
});

test("preflights a complete result before applying its first effect", async () => {
  const provider = new InMemoryProvider(environment, target); let applications = 0;
  const first = testHandler({ async apply() { applications += 1; return applied("first"); } });
  const second: ExternalEffectHandler = { ...testHandler(), id: "bad-handler", kind: "command.run", validate() { throw new TypeError("bad second payload"); } };
  const config = { adapters: null, effects: { handlers: { "command.run": second.id, "git.commit": first.id }, settings: {} }, environmentId: "test", provider: environment, raw: {}, runtime: null, schema: "agent-task-manager-environment-v1" as const };
  const broker = new ExternalEffectBroker(resolveExternalEffectEnvironment(config, [first, second]), new ProviderEffectJournal(provider), { async verify() {} });
  const result = finalizeAgentResult({ contextDigest: "a".repeat(64), definitionDigest: "c".repeat(64), outcome: "succeeded", payload: {}, proposedIntents: [{ kind: "git.commit", payload: {} }, { kind: "command.run", payload: {} }], runId: "run", schema: "agent-result-v1" });
  await assert.rejects(broker.executeResult(result, deadline()), /bad second payload/); assert.equal(applications, 0);
});

test("retains the provider claim when deadline cancellation is not acknowledged", async () => {
  const provider = new InMemoryProvider(environment, target);
  const handler = testHandler({ async apply() { return new Promise<ExternalEffectObservation>(() => undefined); } });
  const environmentConfig = { adapters: null, effects: { handlers: { "git.commit": handler.id }, settings: {} }, environmentId: "test", provider: environment, raw: {}, runtime: null, schema: "agent-task-manager-environment-v1" as const };
  const broker = new ExternalEffectBroker(resolveExternalEffectEnvironment(environmentConfig, [handler]), new ProviderEffectJournal(provider), { async verify() {} }, 5, 1_000);
  const request = requestFor("git.commit", { message: "fix: quarantine" });
  await assert.rejects(broker.execute(request, Date.now() + 25), (error: unknown) => error instanceof IndeterminateExternalEffectError && error.retainClaimUntilExpiry);
  await assert.rejects(broker.execute(request, deadline()), /already claimed/);
});

function brokerFor(provider: InMemoryProvider, handler: ExternalEffectHandler, authorized = true): ExternalEffectBroker {
  const environmentConfig = {
    adapters: null, effects: { handlers: { "git.commit": handler.id }, settings: {} }, environmentId: "test", provider: environment,
    raw: {}, runtime: null, schema: "agent-task-manager-environment-v1" as const,
  };
  return new ExternalEffectBroker(resolveExternalEffectEnvironment(environmentConfig, [handler]), new ProviderEffectJournal(provider), { async verify(request) { if (!authorized || request.kind !== "git.commit") throw new Error("External effect is not authorized"); } });
}
function requestFor(kind: string, payload: Record<string, string>) { return finalizeRequest({ kind, payload, source: { contextDigest: "a".repeat(64), definitionDigest: "c".repeat(64), intentIndex: 0, resultDigest: "b".repeat(64), runId: "run" } }); }
function applied(id: string): ExternalEffectObservation { return { evidence: { verified: true }, externalIdentity: { id }, state: "applied" }; }
function notApplied(): ExternalEffectObservation { return { evidence: {}, externalIdentity: {}, state: "not_applied" }; }
function testHandler(overrides: Partial<ExternalEffectHandler> = {}): ExternalEffectHandler {
  return {
    id: "git-handler", kind: "git.commit", version: "1",
    async apply() { return applied("default"); }, async reconcile() { return notApplied(); }, validate() {}, ...overrides,
  };
}
function deadline(): number { return Date.now() + 10_000; }
