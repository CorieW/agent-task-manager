/** Verifies independent child nodes, dependency receipts, and provider-backed resume. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalize,
  ProviderChildAgentWaveEffects,
  resolveDefinition,
  sha256,
  toJsonValue,
  InMemoryProvider,
  type ChildAgentNodeDriver,
  type AgentDefinition,
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
  const contextA = await seedAgentContext(provider, "context/a");
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
  const effects = new ProviderChildAgentWaveEffects(
    provider,
    driver,
    authority([entry("context/a", contextA)]),
  );
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
        contextDigest: contextA,
        contextResource: "context/a",
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
  const contextDigest = await seedAgentContext(provider, "context/a");
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
  const effects = new ProviderChildAgentWaveEffects(
    provider,
    {
      /** Simulates effect reconciliation. */
      async reconcile() {
        return notApplied;
      },
      /** Returns a neutral observation when malformed state reaches execution. */
      async run() {
        return notApplied;
      },
    },
    authority([entry("context/a", contextDigest)]),
  );
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

test("rejects contexts outside the exact parent run and Agent catalog", async () => {
  /** Provides a valid context whose authority will be deliberately mismatched. */
  const provider = new InMemoryProvider(environment, target);
  /** Pins the valid reviewer context used by both rejection cases. */
  const contextDigest = await seedAgentContext(provider, "context/a");
  /** Counts driver calls to prove rejection occurs before child execution. */
  let driverCalls = 0;
  /** Driver that must remain unreachable for unauthorized contexts. */
  const driver: ChildAgentNodeDriver = {
    /** Records any unauthorized reconciliation attempt. */
    async reconcile() {
      driverCalls += 1;
      return notApplied;
    },
    /** Records any unauthorized child execution attempt. */
    async run() {
      driverCalls += 1;
      return notApplied;
    },
  };
  /** Base node pinned to the persisted reviewer context. */
  const node = {
    contextDigest,
    contextResource: "context/a",
    contextVersion: "v1",
    definitionId: "reviewer",
    dependsOn: [],
    nodeKey: "a",
  } as const;
  /** Common effect control for both authorization checks. */
  const control = {
    deadlineAt: Date.now() + 10_000,
    signal: new AbortController().signal,
  };

  /** Effects boundary tested with a node/context definition mismatch. */
  const wrongDefinitionEffects = new ProviderChildAgentWaveEffects(
    provider,
    driver,
    authority([entry("context/a", contextDigest)]),
  );
  await assert.rejects(
    wrongDefinitionEffects.apply({
      control,
      effectId: "e".repeat(64),
      payload: {
        maxConcurrency: 1,
        nodes: [{ ...node, definitionId: "coder" }],
      },
    }),
    (error: unknown) => aggregateContains(error, /authorized catalog/u),
  );

  /** Effects boundary tested with authority from a different parent run. */
  const staleRunEffects = new ProviderChildAgentWaveEffects(provider, driver, {
    ...authority([entry("context/a", contextDigest)]),
    parentRunId: "another-run",
  });
  await assert.rejects(
    staleRunEffects.apply({
      control,
      effectId: "f".repeat(64),
      payload: { maxConcurrency: 1, nodes: [node] },
    }),
    (error: unknown) => aggregateContains(error, /context authority/u),
  );
  assert.equal(driverCalls, 0);
});

/** Persists and returns the digest of a pinned Agent context Resource. */
async function seedAgentContext(
  provider: InMemoryProvider,
  key: string,
): Promise<string> {
  /** Target definition whose live digest is embedded in the context. */
  const definition = childDefinition();
  provider.seedDefinition(definition);
  for (const resource of childResources()) await provider.putResource(resource);
  /** Validated target definition and immutable Resource graph. */
  const resolved = await resolveDefinition(provider, definition.id);
  /** Ordered dependency pins shared by the context body and Resource envelope. */
  const resourcePins = resolved.resources.map(({ digest, key, version }) => ({
    digest,
    key,
    version,
  }));
  /** Canonical persisted Agent-context authority record. */
  const body = canonicalize(
    toJsonValue({
      assignmentDepth: 1,
      parentActivationDigest: "a".repeat(64),
      parentDefinitionDigest: "b".repeat(64),
      parentDefinitionId: "task-master",
      parentRunId: "parent-run",
      schema: "agent-context-v1",
      targetActivationDigest: "c".repeat(64),
      targetDefinitionDigest: resolved.digest,
      targetDefinitionId: "reviewer",
      targetResourcePins: resourcePins,
      task: { id: "task-1", version: "task-v1" },
      taskId: "task-1",
      taskVersion: "task-v1",
    }),
  );
  /** Pins the canonical content expected by the Resource read. */
  const digest = sha256(body);
  await provider.putResource({
    body,
    dependencies: resourcePins,
    digest,
    idempotencyKey: `seed:${key}`,
    key,
    kind: "agent/context",
    state: "active",
    version: "v1",
  });
  return digest;
}

/** Defines the reviewer whose resolved identity is bound into each context. */
function childDefinition(): AgentDefinition {
  return {
    allowedIntents: [],
    capabilities: [],
    contextBudgetBytes: 100_000,
    deadlineSeconds: 60,
    enabled: true,
    humanResolutionOutcomes: [],
    id: "reviewer",
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    maxAssignmentDepth: 2,
    maxAssignmentsPerRun: 1,
    maxConcurrency: 1,
    model: "model",
    name: "Reviewer",
    outputSchema: "schema/output",
    priority: 1,
    prohibitedCapabilities: [],
    promptResources: ["prompt/reviewer"],
    reasoning: "medium",
    requiredProviderCapabilities: [],
    retry: { maxAttempts: 1, noVerdict: "block" },
    revision: 1,
    runnerProfile: "no-tools",
    schema: "agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: ["coordinator"],
      maxCandidateSummaries: 1,
      mode: "explicit",
      resultSchema: "schema/selection",
      taskQueryResource: "query/reviewer",
    },
    transitions: { succeeded: "Done" },
  };
}

/** Supplies the immutable Resource graph resolved for the reviewer context. */
function childResources() {
  /** Resource tuples converted into active, digest-bound mutations. */
  const records = [
    ["prompt/reviewer", "prompt", "Review the task."],
    [
      "query/reviewer",
      "task-query",
      JSON.stringify({
        dependencySatisfiedStatuses: ["Done"],
        limit: 1,
        predicate: { status: "Ready" },
        schema: "task-query-v1",
      }),
    ],
    [
      "schema/output",
      "json-schema",
      JSON.stringify({
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object",
      }),
    ],
    [
      "schema/selection",
      "json-schema",
      JSON.stringify({
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object",
      }),
    ],
  ] as const;
  return records.map(([key, kind, body]) => ({
    body,
    dependencies: [],
    digest: sha256(body),
    idempotencyKey: `seed:${key}`,
    key,
    kind,
    state: "active" as const,
    version: "v1",
  }));
}

/** Builds one trusted parent-run catalog scope for the test contexts. */
function authority(catalog: readonly ReturnType<typeof entry>[]) {
  return {
    catalog,
    parentActivationDigest: "a".repeat(64),
    parentDefinitionDigest: "b".repeat(64),
    parentDefinitionId: "task-master",
    parentRunId: "parent-run",
    taskId: "task-1",
    taskVersion: "task-v1",
  };
}

/** Builds one exact catalog entry for a persisted context fixture. */
function entry(contextResource: string, contextDigest: string) {
  return {
    contextDigest,
    contextResource,
    contextVersion: "v1",
    definitionId: "reviewer",
  };
}

/** Reports whether one child failure inside a wave matches the expected error. */
function aggregateContains(error: unknown, pattern: RegExp): boolean {
  return (
    error instanceof AggregateError &&
    error.errors.some(
      (cause) => cause instanceof Error && pattern.test(cause.message),
    )
  );
}

/** Represents an effect observation with no external change. */
const notApplied: ExternalEffectObservation = {
  evidence: {},
  externalIdentity: {},
  state: "not_applied",
};
