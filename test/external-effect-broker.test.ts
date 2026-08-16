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

test("persists the complete intent before applying and replays its receipt", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Counts external applications to detect duplicate effects. */
  let applications = 0;
  /** Simulates the external effect adapter under test. */
  const handler = testHandler({
    /** Simulates effect application. */
    async apply() {
      applications += 1;
      return applied("commit-1");
    },
  });
  /** Executes the durable effect workflow under test. */
  const broker = brokerFor(provider, handler);
  /** Supplies the operation input under test. */
  const request = requestFor("git.commit", { message: "feat: add broker" });
  /** Captures the first operation result for replay comparison. */
  const first = await broker.execute(request, deadline());
  /** Captures the replayed result for idempotency comparison. */
  const second = await broker.execute(request, deadline());
  assert.equal(first.state, "applied");
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(applications, 1);
  /** Reads persisted state used as the assertion oracle. */
  const stored = await provider.getOptionalResource(
    `external-effect-intent/${request.effectId}`,
  );
  assert.equal(stored?.kind, "system/external-effect-intent");
  assert.equal((stored?.body ?? "").includes('"state":"applied"'), true);
});

test("recovers a side effect accepted before its receipt was persisted", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Tracks whether the external system accepted the effect. */
  let externalApplied = false;
  /** Counts external applications to detect duplicate effects. */
  let applications = 0;
  /** Simulates the external effect adapter under test. */
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
  /** Executes the durable effect workflow under test. */
  const broker = brokerFor(provider, handler);
  /** Supplies the operation input under test. */
  const request = requestFor("git.commit", { message: "fix: recover" });
  await assert.rejects(
    broker.execute(request, deadline()),
    IndeterminateExternalEffectError,
  );
  /** Captures the effect reconstructed after response loss. */
  const recovered = await broker.execute(request, deadline());
  assert.equal(recovered.state, "applied");
  assert.equal(applications, 1);
});

test("does not execute unauthorized or conflicting intents", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Executes the durable effect workflow under test. */
  const broker = brokerFor(provider, testHandler(), false);
  /** Captures the operation outcome used by assertions. */
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
  /** Controls whether the test verifier accepts the effect. */
  const authorized = brokerFor(provider, testHandler());
  /** Supplies the operation input under test. */
  const request = requestFor("git.commit", { message: "one" });
  await authorized.execute(request, deadline());
  await assert.rejects(
    authorized.execute({ ...request, payload: { message: "two" } }, deadline()),
    /digest is invalid/,
  );
});

test("serializes concurrent execution of one effect identity", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Counts external applications to detect duplicate effects. */
  let applications = 0;
  /** Executes the durable effect workflow under test. */
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
  /** Supplies the operation input under test. */
  const request = requestFor("git.commit", { message: "feat: once" });
  /** Creates two handlers competing for one effect identity. */
  const [left, right] = await Promise.all([
    broker.execute(request, deadline()),
    broker.execute(request, deadline()),
  ]);
  assert.equal(applications, 1);
  assert.deepEqual(left.receipt, right.receipt);
});

test("preflights a complete result before applying its first effect", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Counts external applications to detect duplicate effects. */
  let applications = 0;
  /** Captures the first operation result for replay comparison. */
  const first = testHandler({
    /** Simulates effect application. */
    async apply() {
      applications += 1;
      return applied("first");
    },
  });
  /** Captures the replayed result for idempotency comparison. */
  const second: ExternalEffectHandler = {
    ...testHandler(),
    id: "bad-handler",
    kind: "command.run",
    /** Validates the simulated effect payload. */
    validate() {
      throw new TypeError("bad second payload");
    },
  };
  /** Binds the runtime adapters and policies used by the scenario. */
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
  /** Executes the durable effect workflow under test. */
  const broker = new ExternalEffectBroker(
    resolveExternalEffectEnvironment(config, [first, second]),
    new ProviderEffectJournal(provider),
    {
      /** Simulates authorization verification. */
      async verify() {},
    },
  );
  /** Captures the operation outcome used by assertions. */
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

test("stops an ordered effect sequence after a failed predecessor", async () => {
  /** Persists effect intents and receipts for the sequence under test. */
  const provider = new InMemoryProvider(environment, target);
  /** Counts whether the dependent publication effect is attempted. */
  let publicationApplications = 0;
  /** Returns the failed predecessor observation. */
  const command = testHandler({
    id: "command-handler",
    kind: "command.run",
    /** Simulates a command failure without throwing. */
    async apply() {
      return {
        evidence: { exitCode: 1 },
        externalIdentity: {},
        state: "failed",
      };
    },
  });
  /** Records any attempt to publish after the failed command. */
  const publication = testHandler({
    id: "publication-handler",
    kind: "publication.draft_pr",
    /** Counts and accepts a publication attempt. */
    async apply() {
      publicationApplications += 1;
      return applied("pr-1");
    },
  });
  /** Binds both effect kinds to their test handlers. */
  const config = {
    adapters: null,
    effects: {
      handlers: {
        "command.run": command.id,
        "publication.draft_pr": publication.id,
      },
      settings: {},
    },
    environmentId: "test",
    provider: environment,
    raw: {},
    runtime: null,
    schema: "agent-task-manager-environment-v1" as const,
  };
  /** Executes the ordered effects through a provider-backed journal. */
  const broker = new ExternalEffectBroker(
    resolveExternalEffectEnvironment(config, [command, publication]),
    new ProviderEffectJournal(provider),
    {
      /** Allows the sequence to reach effect execution. */
      async verify() {},
    },
  );
  /** Supplies the failed command before the dependent publication. */
  const result = finalizeAgentResult({
    contextDigest: "a".repeat(64),
    definitionDigest: "c".repeat(64),
    outcome: "succeeded",
    payload: {},
    proposedIntents: [
      { kind: "command.run", payload: {} },
      { kind: "publication.draft_pr", payload: {} },
    ],
    runId: "run",
    schema: "agent-result-v1",
  });

  /** Captures the prefix executed before failure stopped the sequence. */
  const executions = await broker.executeResult(result, deadline());

  assert.deepEqual(
    executions.map((execution) => execution.state),
    ["failed"],
  );
  assert.equal(publicationApplications, 0);
});

test("persists replay quarantine before invoking an external apply", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Tracks whether durable intent preceded effect application. */
  let writeAheadObserved = false;
  /** Supplies the operation input under test. */
  const request = requestFor("git.commit", { message: "fix: write ahead" });
  /** Simulates the external effect adapter under test. */
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
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Simulates the external effect adapter under test. */
  const handler = testHandler({
    /** Simulates effect application. */
    async apply() {
      return new Promise<ExternalEffectObservation>(() => undefined);
    },
  });
  /** Defines the runtime deadline and adapter bindings. */
  const environmentConfig = {
    adapters: null,
    effects: { handlers: { "git.commit": handler.id }, settings: {} },
    environmentId: "test",
    provider: environment,
    raw: {},
    runtime: null,
    schema: "agent-task-manager-environment-v1" as const,
  };
  /** Executes the durable effect workflow under test. */
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
  /** Supplies the operation input under test. */
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
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Counts external applications to detect duplicate effects. */
  let applications = 0;
  /** Simulates the external effect adapter under test. */
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
  /** Defines the runtime deadline and adapter bindings. */
  const environmentConfig = {
    adapters: null,
    effects: { handlers: { "git.commit": handler.id }, settings: {} },
    environmentId: "test",
    provider: environment,
    raw: {},
    runtime: null,
    schema: "agent-task-manager-environment-v1" as const,
  };
  /** Executes the durable effect workflow under test. */
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
  /** Supplies the operation input under test. */
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

/** Builds an effect broker with deterministic authorization and deadlines. */
function brokerFor(
  provider: InMemoryProvider,
  handler: ExternalEffectHandler,
  authorized = true,
): ExternalEffectBroker {
  /** Defines the runtime deadline and adapter bindings. */
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

/** Builds a successful external-effect observation. */
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
