/** Verifies the provider-backed handshake used by an external Agent harness. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryProvider,
  completeHarnessAssignment,
  prepareHarnessAssignment,
  prepareHarnessSelection,
  type AgentDefinition,
  type HarnessAssignmentCompletion,
  type LeaseRelease,
  type ProviderEnvironment,
  type ResourceMutation,
  type WriteReceipt,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";
import { sha256 } from "../src/core/digest.js";

/** Provider environment used by every external-harness scenario. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: { agents: "a", errors: "e", resources: "r", tasks: "t" },
  type: "memory",
};

/** Minimal schema descriptor accepted by the in-memory provider. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};

/** Canonical future expiry used by deterministic lease assertions. */
const EXPIRY = "2099-01-01T00:00:00.000Z";

/** Simulates one lost response while releasing the run lease. */
class InterruptedReleaseProvider extends InMemoryProvider {
  /** Number of lease-release attempts observed by the provider. */
  private releaseAttempts = 0;

  /** Releases normally except for the first run-lease attempt. */
  public override async releaseLease(
    request: LeaseRelease,
  ): Promise<WriteReceipt> {
    this.releaseAttempts += 1;
    if (this.releaseAttempts === 2)
      throw new Error("Injected run-lease release interruption");
    return super.releaseLease(request);
  }
}

/** Enforces the same manager-owned Resource namespace as the Notion provider. */
class StrictSystemResourceProvider extends InMemoryProvider {
  /** Rejects manager writes whose key or kind escapes the reserved namespace. */
  public override async putSystemResource(
    record: ResourceMutation,
  ): Promise<WriteReceipt> {
    if (!record.key.startsWith("system/") || !record.kind.startsWith("system/"))
      throw new Error("Manager-owned Resources require system/ key and kind");
    return super.putSystemResource(record);
  }
}

test("prepares context for a harness and completes without model dispatch", async () => {
  /** Isolated provider state owned entirely by the manager boundary. */
  const provider = await preparedProvider();
  /** Immutable assignment and role context returned to the external harness. */
  const preparation = await prepareHarnessAssignment({
    agentId: "planner",
    assignmentDepth: 0,
    environmentId: "demo",
    expiresAt: EXPIRY,
    input: { requestedBy: "scheduled-task" },
    operationKey: "issue-001-plan",
    provider,
    taskId: "task-1",
  });
  assert.equal(preparation.state, "prepared");
  if (preparation.state !== "prepared") return;
  assert.equal(preparation.assignment.context.definition.model, "model");
  assert.equal(preparation.assignment.context.task.body, "Task body");
  assert.equal(
    preparation.assignment.context.resources.some(
      ({ key }) => key === "prompt/planner",
    ),
    true,
  );
  assert.equal((await provider.getAgentActivity("planner")).status, "Online");
  assert.deepEqual((await provider.getAgentActivity("planner")).taskIds, [
    "task-1",
  ]);

  /** Schema-valid Agent result produced outside Agent Task Manager. */
  const result = {
    outcome: "succeeded",
    payload: { summary: "Plan ready" },
    proposedIntents: [],
    schema: "harness-agent-result-v1" as const,
  };
  /** Closed completion envelope attesting the external harness performed no effects. */
  const completion: HarnessAssignmentCompletion = {
    effectAttestations: [],
    humanResolution: null,
    result,
    reviewFindingKeys: null,
    schema: "harness-assignment-completion-v1",
    testFailureKeys: null,
  };
  /** Durable terminal report returned after provider routing and lease cleanup. */
  const report = await completeHarnessAssignment({
    completion,
    environmentId: "demo",
    operationKey: "issue-001-plan",
    provider,
  });
  assert.equal(report.outcome, "succeeded");
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Planned");
  assert.deepEqual((await provider.getAgentActivity("planner")).taskIds, []);
  assert.equal((await provider.getAgentActivity("planner")).status, "Offline");

  /** Exact completion replay proving no second transition is attempted. */
  const replay = await completeHarnessAssignment({
    completion,
    environmentId: "demo",
    operationKey: "issue-001-plan",
    provider,
  });
  assert.deepEqual(replay, report);
  /** Preparation replay returns the same terminal provider report. */
  const preparedReplay = await prepareHarnessAssignment({
    agentId: "planner",
    assignmentDepth: 0,
    environmentId: "demo",
    expiresAt: EXPIRY,
    input: { requestedBy: "scheduled-task" },
    operationKey: "issue-001-plan",
    provider,
    taskId: "task-1",
  });
  assert.deepEqual(preparedReplay, { report, state: "complete" });
});

test("persists a blocked harness completion within the system namespace", async () => {
  /** Strict provider exposing the same manager namespace rule as Notion. */
  const provider = await preparedProvider([], undefined, true);
  await prepareHarnessAssignment({
    agentId: "planner",
    assignmentDepth: 0,
    environmentId: "demo",
    expiresAt: EXPIRY,
    input: {},
    operationKey: "issue-001-needs-human",
    provider,
    taskId: "task-1",
  });
  /** Completion asking the manager to persist one human decision slot. */
  const completion: HarnessAssignmentCompletion = {
    effectAttestations: [],
    humanResolution: {
      createdAt: "2026-08-16T19:00:00.000Z",
      error: {
        description: "Product scope is not approved.",
        errorKey: "planning/product-scope",
        relatedAgentId: "planner",
        relatedRunId: "run-1",
        resolution: "Approve the product scope, then resume planning.",
        severity: "high",
        status: "Not Fixed",
        title: "Product scope approval required",
      },
      generation: 1,
      prompt: "Approve the primary user, MVP boundaries, and success metrics.",
      requestedBy: "planner",
      resumeStatus: "Ready",
    },
    result: {
      outcome: "needs_human",
      payload: { summary: "Planning requires approved product scope." },
      proposedIntents: [],
      schema: "harness-agent-result-v1",
    },
    reviewFindingKeys: null,
    schema: "harness-assignment-completion-v1",
    testFailureKeys: null,
  };

  /** Terminal report returned after human recovery and lease cleanup. */
  const report = await completeHarnessAssignment({
    completion,
    environmentId: "demo",
    operationKey: "issue-001-needs-human",
    provider,
  });

  assert.equal(report.outcome, "needs_human");
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Blocked");
  assert.equal((await provider.getAgentActivity("planner")).status, "Offline");
  assert.deepEqual((await provider.getAgentActivity("planner")).taskIds, []);
});

test("returns a read-only provider-defined candidate basis", async () => {
  /** Provider containing one eligible and one ineligible Task. */
  const provider = await preparedProvider();
  provider.seedTask({
    archived: false,
    body: "Backlog body",
    dependencies: [],
    id: "task-backlog",
    priority: 2,
    properties: { Status: "Backlog" },
    status: "Backlog",
    title: "Backlog task",
    version: "v1",
  });
  provider.seedTask({
    archived: false,
    body: "Unfinished dependency",
    dependencies: [],
    id: "dependency-ready",
    priority: 3,
    properties: { Status: "Backlog" },
    status: "Backlog",
    title: "Unfinished dependency",
    version: "v1",
  });
  provider.seedTask({
    archived: false,
    body: "Blocked by unfinished work",
    dependencies: ["dependency-ready"],
    id: "task-dependent",
    priority: 1,
    properties: { Status: "Ready" },
    status: "Ready",
    title: "Dependent task",
    version: "v1",
  });
  /** Candidate basis compiled from the Agent's Task Query Resource. */
  const preparation = await prepareHarnessSelection(provider, "planner");
  assert.deepEqual(
    preparation.selection.candidateSet.summaries.map(({ id }) => id),
    ["task-1"],
  );
  assert.equal((await provider.getAgentActivity("planner")).status, "Offline");
  assert.deepEqual((await provider.getAgentActivity("planner")).taskIds, []);
});

test("requires ordered harness attestations for every proposed effect", async () => {
  /** Provider and assignment used to validate effect attestations. */
  const provider = await preparedProvider(["publication.draft_pr"]);
  /** Prepared context bound to the effect-producing result. */
  const preparation = await prepareHarnessAssignment({
    agentId: "planner",
    assignmentDepth: 0,
    environmentId: "demo",
    expiresAt: EXPIRY,
    input: {},
    operationKey: "issue-001-publish",
    provider,
    taskId: "task-1",
  });
  assert.equal(preparation.state, "prepared");
  if (preparation.state !== "prepared") return;
  /** Agent result proposing one externally executed effect. */
  const result = {
    outcome: "succeeded",
    payload: { summary: "Published" },
    proposedIntents: [
      { kind: "publication.draft_pr", payload: { title: "Draft" } },
    ],
    schema: "harness-agent-result-v1" as const,
  };
  await assert.rejects(
    completeHarnessAssignment({
      completion: {
        effectAttestations: [],
        humanResolution: null,
        result,
        reviewFindingKeys: null,
        schema: "harness-assignment-completion-v1",
        testFailureKeys: null,
      },
      environmentId: "demo",
      operationKey: "issue-001-publish",
      provider,
    }),
    /attest every proposed intent/u,
  );
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Ready");

  /** Valid attestation proving the harness applied the proposed publication. */
  const report = await completeHarnessAssignment({
    completion: {
      effectAttestations: [
        {
          evidence: { draftPullRequest: 12 },
          intentIndex: 0,
          kind: "publication.draft_pr",
          schema: "harness-effect-attestation-v1",
          state: "applied",
        },
      ],
      humanResolution: null,
      result,
      reviewFindingKeys: null,
      schema: "harness-assignment-completion-v1",
      testFailureKeys: null,
    },
    environmentId: "demo",
    operationKey: "issue-001-publish",
    provider,
  });
  assert.equal(report.effectIds.length, 1);
  assert.match(report.effectIds[0] ?? "", /^[a-f0-9]{64}$/u);
  assert.equal((await provider.getTaskSnapshot("task-1")).status, "Planned");
});

test("rejects operation-key reuse with changed assignment input", async () => {
  /** Provider retaining the first immutable assignment request. */
  const provider = await preparedProvider();
  await prepareHarnessAssignment({
    agentId: "planner",
    assignmentDepth: 0,
    environmentId: "demo",
    expiresAt: EXPIRY,
    input: { request: "first" },
    operationKey: "issue-001-stable",
    provider,
    taskId: "task-1",
  });
  await assert.rejects(
    prepareHarnessAssignment({
      agentId: "planner",
      assignmentDepth: 0,
      environmentId: "demo",
      expiresAt: EXPIRY,
      input: { request: "changed" },
      operationKey: "issue-001-stable",
      provider,
      taskId: "task-1",
    }),
    /reused with different input/u,
  );
});

test("rejects stale harness results after the Task changes", async () => {
  /** Provider whose Task changes after assignment preparation. */
  const provider = await preparedProvider();
  /** Assignment frozen against the original Task version and status. */
  const preparation = await prepareHarnessAssignment({
    agentId: "planner",
    assignmentDepth: 0,
    environmentId: "demo",
    expiresAt: EXPIRY,
    input: {},
    operationKey: "issue-001-stale",
    provider,
    taskId: "task-1",
  });
  assert.equal(preparation.state, "prepared");
  await provider.applyTaskMutation({
    expectedVersion: "v1",
    idempotencyKey: "human-edit",
    nextBody: "Human-edited body",
    nextProperties: { Status: "Ready" },
    nextStatus: "Ready",
    taskId: "task-1",
  });
  await assert.rejects(
    completeHarnessAssignment({
      completion: {
        effectAttestations: [],
        humanResolution: null,
        result: {
          outcome: "succeeded",
          payload: { summary: "Stale plan" },
          proposedIntents: [],
          schema: "harness-agent-result-v1",
        },
        reviewFindingKeys: null,
        schema: "harness-assignment-completion-v1",
        testFailureKeys: null,
      },
      environmentId: "demo",
      operationKey: "issue-001-stale",
      provider,
    }),
    /Task|assignment/u,
  );
  assert.equal(
    (await provider.getTaskSnapshot("task-1")).body,
    "Human-edited body",
  );
});

test("resumes lease cleanup after a terminal completion interruption", async () => {
  /** Provider that loses the first run-lease release response. */
  const provider = await preparedProvider(
    [],
    new InterruptedReleaseProvider(environment, target),
  );
  await prepareHarnessAssignment({
    agentId: "planner",
    assignmentDepth: 0,
    environmentId: "demo",
    expiresAt: EXPIRY,
    input: {},
    operationKey: "issue-001-cleanup",
    provider,
    taskId: "task-1",
  });
  /** Completion reused after the injected cleanup interruption. */
  const completion: HarnessAssignmentCompletion = {
    effectAttestations: [],
    humanResolution: null,
    result: {
      outcome: "succeeded",
      payload: { summary: "Plan survives cleanup retry" },
      proposedIntents: [],
      schema: "harness-agent-result-v1",
    },
    reviewFindingKeys: null,
    schema: "harness-assignment-completion-v1",
    testFailureKeys: null,
  };
  await assert.rejects(
    completeHarnessAssignment({
      completion,
      environmentId: "demo",
      operationKey: "issue-001-cleanup",
      provider,
    }),
    /release interruption/u,
  );
  /** Terminal replay that finishes the remaining idempotent cleanup. */
  const report = await completeHarnessAssignment({
    completion,
    environmentId: "demo",
    operationKey: "issue-001-cleanup",
    provider,
  });
  assert.equal(report.outcome, "succeeded");
  assert.equal((await provider.getAgentActivity("planner")).status, "Offline");
  assert.deepEqual((await provider.getAgentActivity("planner")).taskIds, []);
});

/** Creates a provider populated with one role, its Resources, and one Ready Task. */
async function preparedProvider(
  allowedIntents: readonly string[] = [],
  provider: InMemoryProvider = new StrictSystemResourceProvider(
    environment,
    target,
  ),
  humanResolution = false,
): Promise<InMemoryProvider> {
  /** Provider-defined role used by the external harness. */
  const definition = agentDefinition(allowedIntents, humanResolution);
  provider.seedDefinition(definition);
  provider.seedTaskStatusOptions(["Backlog", "Blocked", "Planned", "Ready"]);
  provider.seedTask({
    archived: false,
    body: "Task body",
    dependencies: [],
    id: "task-1",
    priority: 1,
    properties: { Status: "Ready" },
    status: "Ready",
    title: "Task",
    version: "v1",
  });
  for (const record of resources()) await provider.putResource(record);
  return provider;
}

/** Defines the provider-driven role and lifecycle accepted by the harness tests. */
function agentDefinition(
  allowedIntents: readonly string[],
  humanResolution = false,
): AgentDefinition {
  return {
    allowedIntents,
    capabilities: [],
    contextBudgetBytes: 100_000,
    deadlineSeconds: 60,
    enabled: true,
    humanResolutionOutcomes: humanResolution ? ["needs_human"] : [],
    id: "planner",
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    maxAssignmentDepth: 2,
    maxAssignmentsPerRun: 1,
    maxConcurrency: 1,
    model: "model",
    name: "Planner",
    outputSchema: "schema/output",
    priority: 1,
    prohibitedCapabilities: [],
    promptResources: ["prompt/planner"],
    reasoning: "medium",
    requiredProviderCapabilities: [],
    retry: { maxAttempts: 1, noVerdict: "block" },
    revision: 1,
    runnerProfile: "external-harness",
    schema: "agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: ["explicit"],
      maxCandidateSummaries: 10,
      mode: "explicit",
      resultSchema: "schema/selection",
      taskQueryResource: "query/planner",
    },
    transitions: humanResolution
      ? { needs_human: "Blocked", succeeded: "Planned" }
      : { succeeded: "Planned" },
  };
}

/** Supplies the immutable Resource graph required by the role. */
function resources(): readonly ResourceMutation[] {
  return [
    resource("prompt/planner", "prompt", "Plan the assigned Task."),
    resource(
      "query/planner",
      "task-query",
      JSON.stringify({
        dependencySatisfiedStatuses: ["Planned"],
        limit: 10,
        predicate: { status: "Ready" },
        schema: "task-query-v1",
      }),
    ),
    resource("schema/selection", "json-schema", closedSchema({}, [])),
    resource(
      "schema/output",
      "json-schema",
      closedSchema({ summary: { minLength: 1, type: "string" } }, ["summary"]),
    ),
  ];
}

/** Creates one digest-bound active Resource mutation. */
function resource(key: string, kind: string, body: string): ResourceMutation {
  return {
    body,
    dependencies: [],
    digest: sha256(body),
    idempotencyKey: `seed:${key}`,
    key,
    kind,
    state: "active",
    version: "v1",
  };
}

/** Serializes a minimal recursively closed JSON Schema. */
function closedSchema(properties: object, required: string[]): string {
  return JSON.stringify({
    additionalProperties: false,
    properties,
    required,
    type: "object",
  });
}
