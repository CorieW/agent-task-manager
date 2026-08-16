/** Verifies provider-backed external-effect intent ordering, recovery, and authorization. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EffectCancellationAcknowledgedError,
  EffectTerminationUnconfirmedError,
  ExternalEffectBroker,
  finalizeAgentResult,
  finalizeRequest,
  InMemoryProvider,
  IndeterminateExternalEffectError,
  ProviderEffectJournal,
  resolveExternalEffectEnvironment,
  type ExternalEffectHandler,
  type ExternalEffectObservation,
  type ProviderEnvironment,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";

/** Defines the shared environment fixture for this test module. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { errors: "e", resources: "r", subAgents: "a", tasks: "t" },
  type: "memory",
};
/** Defines the shared target fixture for this test module. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};

test("persists the complete intent before applying and replays its receipt", async () => {
  /** Defines the provider fixture for “persists the complete intent before applying and replays its receipt”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the applications fixture for “persists the complete intent before applying and replays its receipt”. */
  let applications = 0;
  /** Defines the handler fixture for “persists the complete intent before applying and replays its receipt”. */
  const handler = testHandler({
    /** Simulates effect application. */
    async apply() {
      applications += 1;
      return applied("commit-1");
    },
  });
  /** Defines the broker fixture for “persists the complete intent before applying and replays its receipt”. */
  const broker = brokerFor(provider, handler);
  /** Defines the request fixture for “persists the complete intent before applying and replays its receipt”. */
  const request = requestFor("git.commit", { message: "feat: add broker" });
  /** Defines the first fixture for “persists the complete intent before applying and replays its receipt”. */
  const first = await broker.execute(request, deadline());
  /** Defines the second fixture for “persists the complete intent before applying and replays its receipt”. */
  const second = await broker.execute(request, deadline());
  assert.equal(first.state, "applied");
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(applications, 1);
  /** Defines the stored fixture for “persists the complete intent before applying and replays its receipt”. */
  const stored = await provider.getOptionalResource(
    `external-effect-intent/${request.effectId}`,
  );
  assert.equal(stored?.kind, "system/external-effect-intent");
  assert.equal((stored?.body ?? "").includes('"state":"applied"'), true);
});

test("recovers a side effect accepted before its receipt was persisted", async () => {
  /** Defines the provider fixture for “recovers a side effect accepted before its receipt was persisted”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the external applied fixture for “recovers a side effect accepted before its receipt was persisted”. */
  let externalApplied = false;
  /** Defines the applications fixture for “recovers a side effect accepted before its receipt was persisted”. */
  let applications = 0;
  /** Defines the handler fixture for “recovers a side effect accepted before its receipt was persisted”. */
  const handler = testHandler({
    /** Simulates effect application. */
    async apply() {
      applications += 1;
      externalApplied = true;
      throw new Error("connection lost after accept");
    },
    /** Simulates effect reconciliation. */
    async reconcile() {
      return externalApplied ? applied("branch-1") : notApplied();
    },
  });
  /** Defines the broker fixture for “recovers a side effect accepted before its receipt was persisted”. */
  const broker = brokerFor(provider, handler);
  /** Defines the request fixture for “recovers a side effect accepted before its receipt was persisted”. */
  const request = requestFor("git.commit", { message: "fix: recover" });
  await assert.rejects(
    broker.execute(request, deadline()),
    IndeterminateExternalEffectError,
  );
  /** Defines the recovered fixture for “recovers a side effect accepted before its receipt was persisted”. */
  const recovered = await broker.execute(request, deadline());
  assert.equal(recovered.state, "applied");
  assert.equal(applications, 1);
});

test("does not execute unauthorized or conflicting intents", async () => {
  /** Defines the provider fixture for “does not execute unauthorized or conflicting intents”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the broker fixture for “does not execute unauthorized or conflicting intents”. */
  const broker = brokerFor(provider, testHandler(), false);
  /** Defines the result fixture for “does not execute unauthorized or conflicting intents”. */
  const result = finalizeAgentResult({
    contextDigest: "a".repeat(64),
    definitionDigest: "b".repeat(64),
    outcome: "succeeded",
    payload: {},
    proposedIntents: [{ kind: "git.commit", payload: {} }],
    runId: "run",
    schema: "agent-result-v1",
  });
  await assert.rejects(
    broker.executeResult(result, deadline()),
    /not authorized/,
  );
  /** Defines the authorized fixture for “does not execute unauthorized or conflicting intents”. */
  const authorized = brokerFor(provider, testHandler());
  /** Defines the request fixture for “does not execute unauthorized or conflicting intents”. */
  const request = requestFor("git.commit", { message: "one" });
  await authorized.execute(request, deadline());
  await assert.rejects(
    authorized.execute({ ...request, payload: { message: "two" } }, deadline()),
    /digest is invalid/,
  );
});

test("serializes concurrent execution of one effect identity", async () => {
  /** Defines the provider fixture for “serializes concurrent execution of one effect identity”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the applications fixture for “serializes concurrent execution of one effect identity”. */
  let applications = 0;
  /** Defines the broker fixture for “serializes concurrent execution of one effect identity”. */
  const broker = brokerFor(
    provider,
    testHandler({
      /** Simulates effect application. */
      async apply() {
        applications += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return applied("once");
      },
    }),
  );
  /** Defines the request fixture for “serializes concurrent execution of one effect identity”. */
  const request = requestFor("git.commit", { message: "feat: once" });
  /** Defines the left and right fixture for “serializes concurrent execution of one effect identity”. */
  const [left, right] = await Promise.all([
    broker.execute(request, deadline()),
    broker.execute(request, deadline()),
  ]);
  assert.equal(applications, 1);
  assert.deepEqual(left.receipt, right.receipt);
});

test("preflights a complete result before applying its first effect", async () => {
  /** Defines the provider fixture for “preflights a complete result before applying its first effect”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the applications fixture for “preflights a complete result before applying its first effect”. */
  let applications = 0;
  /** Defines the first fixture for “preflights a complete result before applying its first effect”. */
  const first = testHandler({
    /** Simulates effect application. */
    async apply() {
      applications += 1;
      return applied("first");
    },
  });
  /** Defines the second fixture for “preflights a complete result before applying its first effect”. */
  const second: ExternalEffectHandler = {
    ...testHandler(),
    id: "bad-handler",
    kind: "command.run",
    /** Validates the simulated effect payload. */
    validate() {
      throw new TypeError("bad second payload");
    },
  };
  /** Defines the config fixture for “preflights a complete result before applying its first effect”. */
  const config = {
    adapters: null,
    effects: {
      handlers: { "command.run": second.id, "git.commit": first.id },
      settings: {},
    },
    environmentId: "test",
    provider: environment,
    raw: {},
    runtime: null,
    schema: "agent-task-manager-environment-v1" as const,
  };
  /** Defines the broker fixture for “preflights a complete result before applying its first effect”. */
  const broker = new ExternalEffectBroker(
    resolveExternalEffectEnvironment(config, [first, second]),
    new ProviderEffectJournal(provider),
    {
      /** Simulates authorization verification. */
      async verify() {},
    },
  );
  /** Defines the result fixture for “preflights a complete result before applying its first effect”. */
  const result = finalizeAgentResult({
    contextDigest: "a".repeat(64),
    definitionDigest: "c".repeat(64),
    outcome: "succeeded",
    payload: {},
    proposedIntents: [
      { kind: "git.commit", payload: {} },
      { kind: "command.run", payload: {} },
    ],
    runId: "run",
    schema: "agent-result-v1",
  });
  await assert.rejects(
    broker.executeResult(result, deadline()),
    /bad second payload/,
  );
  assert.equal(applications, 0);
});

test("persists replay quarantine before invoking an external apply", async () => {
  /** Defines the provider fixture for “persists replay quarantine before invoking an external apply”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the write ahead observed fixture for “persists replay quarantine before invoking an external apply”. */
  let writeAheadObserved = false;
  /** Defines the request fixture for “persists replay quarantine before invoking an external apply”. */
  const request = requestFor("git.commit", { message: "fix: write ahead" });
  /** Defines the handler fixture for “persists replay quarantine before invoking an external apply”. */
  const handler = testHandler({
    /** Simulates effect application. */
    async apply() {
      writeAheadObserved =
        (
          await provider.getOptionalResource(
            `external-effect-intent/${request.effectId}`,
          )
        )?.body.includes('"automaticReplayBlocked":true') === true;
      return applied("write-ahead");
    },
  });
  await brokerFor(provider, handler).execute(request, deadline());
  assert.equal(writeAheadObserved, true);
  assert.equal(
    (
      await provider.getOptionalResource(
        `external-effect-intent/${request.effectId}`,
      )
    )?.body.includes('"automaticReplayBlocked":false'),
    true,
  );
});

test("retains the provider claim when deadline cancellation is not acknowledged", async () => {
  /** Defines the provider fixture for “retains the provider claim when deadline cancellation is not acknowledged”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the handler fixture for “retains the provider claim when deadline cancellation is not acknowledged”. */
  const handler = testHandler({
    /** Simulates effect application. */
    async apply() {
      return new Promise<ExternalEffectObservation>(() => undefined);
    },
  });
  /** Defines the environment config fixture for “retains the provider claim when deadline cancellation is not acknowledged”. */
  const environmentConfig = {
    adapters: null,
    effects: { handlers: { "git.commit": handler.id }, settings: {} },
    environmentId: "test",
    provider: environment,
    raw: {},
    runtime: null,
    schema: "agent-task-manager-environment-v1" as const,
  };
  /** Defines the broker fixture for “retains the provider claim when deadline cancellation is not acknowledged”. */
  const broker = new ExternalEffectBroker(
    resolveExternalEffectEnvironment(environmentConfig, [handler]),
    new ProviderEffectJournal(provider),
    {
      /** Simulates authorization verification. */
      async verify() {},
    },
    5,
    1_000,
  );
  /** Defines the request fixture for “retains the provider claim when deadline cancellation is not acknowledged”. */
  const request = requestFor("git.commit", { message: "fix: quarantine" });
  await assert.rejects(
    broker.execute(request, Date.now() + 25),
    (error: unknown) =>
      error instanceof IndeterminateExternalEffectError &&
      error.retainClaimUntilExpiry,
  );
  await assert.rejects(broker.execute(request, deadline()), /already claimed/);
});

test("durable quarantine blocks replay after its provider claim expires", async () => {
  /** Defines the provider fixture for “durable quarantine blocks replay after its provider claim expires”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the applications fixture for “durable quarantine blocks replay after its provider claim expires”. */
  let applications = 0;
  /** Defines the handler fixture for “durable quarantine blocks replay after its provider claim expires”. */
  const handler = testHandler({
    /** Simulates effect application. */
    async apply(_request, control) {
      applications += 1;
      return new Promise<ExternalEffectObservation>((_resolve, reject) => {
        control.signal.addEventListener(
          "abort",
          () =>
            reject(
              new EffectTerminationUnconfirmedError([], "teardown unconfirmed"),
            ),
          { once: true },
        );
      });
    },
    /** Simulates effect reconciliation. */
    async reconcile() {
      if (applications > 0)
        throw new EffectCancellationAcknowledgedError(
          "reconciliation cancelled safely",
        );
      return notApplied();
    },
  });
  /** Defines the environment config fixture for “durable quarantine blocks replay after its provider claim expires”. */
  const environmentConfig = {
    adapters: null,
    effects: { handlers: { "git.commit": handler.id }, settings: {} },
    environmentId: "test",
    provider: environment,
    raw: {},
    runtime: null,
    schema: "agent-task-manager-environment-v1" as const,
  };
  /** Defines the broker fixture for “durable quarantine blocks replay after its provider claim expires”. */
  const broker = new ExternalEffectBroker(
    resolveExternalEffectEnvironment(environmentConfig, [handler]),
    new ProviderEffectJournal(provider),
    {
      /** Simulates authorization verification. */
      async verify() {},
    },
    5,
    0,
  );
  /** Defines the request fixture for “durable quarantine blocks replay after its provider claim expires”. */
  const request = requestFor("git.commit", {
    message: "fix: durable quarantine",
  });
  await assert.rejects(
    broker.execute(request, Date.now() + 25),
    (error: unknown) =>
      error instanceof IndeterminateExternalEffectError &&
      error.retainClaimUntilExpiry,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(
    broker.execute(request, deadline()),
    (error: unknown) =>
      error instanceof IndeterminateExternalEffectError &&
      !error.retainClaimUntilExpiry,
  );
  assert.equal(applications, 1);
  assert.equal(
    (
      await provider.getOptionalResource(
        `external-effect-intent/${request.effectId}`,
      )
    )?.body.includes('"automaticReplayBlocked":true'),
    true,
  );
});

/** Creates the broker for test fixture. */
function brokerFor(
  provider: InMemoryProvider,
  handler: ExternalEffectHandler,
  authorized = true,
): ExternalEffectBroker {
  /** Defines the environment config fixture used by broker for. */
  const environmentConfig = {
    adapters: null,
    effects: { handlers: { "git.commit": handler.id }, settings: {} },
    environmentId: "test",
    provider: environment,
    raw: {},
    runtime: null,
    schema: "agent-task-manager-environment-v1" as const,
  };
  return new ExternalEffectBroker(
    resolveExternalEffectEnvironment(environmentConfig, [handler]),
    new ProviderEffectJournal(provider),
    {
      /** Simulates authorization verification. */
      async verify(request) {
        if (!authorized || request.kind !== "git.commit")
          throw new Error("External effect is not authorized");
      },
    },
  );
}
/** Requests for. */
function requestFor(kind: string, payload: Record<string, string>) {
  return finalizeRequest({
    kind,
    payload,
    source: {
      contextDigest: "a".repeat(64),
      definitionDigest: "c".repeat(64),
      intentIndex: 0,
      resultDigest: "b".repeat(64),
      runId: "run",
    },
  });
}
/** Creates the applied test fixture. */
function applied(id: string): ExternalEffectObservation {
  return {
    evidence: { verified: true },
    externalIdentity: { id },
    state: "applied",
  };
}
/** Creates a not-applied effect observation. */
function notApplied(): ExternalEffectObservation {
  return { evidence: {}, externalIdentity: {}, state: "not_applied" };
}
/** Creates an external-effect handler test double. */
function testHandler(
  overrides: Partial<ExternalEffectHandler> = {},
): ExternalEffectHandler {
  return {
    id: "git-handler",
    kind: "git.commit",
    version: "1",
    /** Simulates effect application. */
    async apply() {
      return applied("default");
    },
    /** Simulates effect reconciliation. */
    async reconcile() {
      return notApplied();
    },
    /** Validates the simulated effect payload. */
    validate() {},
    ...overrides,
  };
}
/** Returns a future deadline for the test scenario. */
function deadline(): number {
  return Date.now() + 10_000;
}
