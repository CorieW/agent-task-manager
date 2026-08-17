/** Verifies provider-defined roles, Resource resolution, grants, queries, and routes. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  compileCapabilityGrant,
  activateDefinitions,
  finalizeCandidateSet,
  InMemoryProvider,
  parseAgentDefinitionManifest,
  parseTaskQueryContract,
  resolveDefinition,
  routeOutcome,
  taskSummaryMatchesPredicate,
  taskQueryForDefinition,
  type ProviderEnvironment,
  type JsonObject,
  type ResourceMutation,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";
import { sha256 } from "../src/core/digest.js";

/** Supplies the provider environment shared by the scenarios. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: {
    errors: "errors",
    resources: "resources",
    agents: "agents",
    tasks: "tasks",
  },
  type: "memory",
};

/** Supplies the canonical workspace schema target. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};

test("parses a complete role contract and rejects semantic capability conflicts", () => {
  /** Captures the validated contract produced by the parser. */
  const parsed = parseAgentDefinitionManifest(manifest());
  assert.equal(parsed.name, "Security Auditor");
  assert.equal(parsed.invocation.mode, "manual");
  assert.throws(
    () =>
      parseAgentDefinitionManifest({
        ...manifest(),
        prohibitedCapabilities: ["repository.read"],
      }),
    /both granted and prohibited/,
  );
});

test("parses optional outcome-specific required intent sequences", () => {
  /** Parses a manifest carrying an outcome-specific intent sequence. */
  const parsed = parseAgentDefinitionManifest({
    ...manifest(),
    requiredIntentSequenceByOutcome: {
      succeeded: ["task.status.transition"],
    },
    schema: "agent-definition-v1",
  });
  assert.deepEqual(parsed.requiredIntentSequenceByOutcome, {
    succeeded: ["task.status.transition"],
  });

  assert.throws(
    () =>
      parseAgentDefinitionManifest({
        ...manifest(),
        requiredIntentSequenceByOutcome: {
          succeeded: ["publication.draft_pr"],
        },
        schema: "agent-definition-v1",
      }),
    /Required intent publication\.draft_pr is not allowed/u,
  );
  assert.throws(
    () =>
      parseAgentDefinitionManifest({
        ...manifest(),
        requiredIntentSequenceByOutcome: {
          unknown: ["task.status.transition"],
        },
        schema: "agent-definition-v1",
      }),
    /Required intent sequence outcome unknown has no transition/u,
  );
});

test("resolves an active immutable Resource graph and closed output schemas", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Supplies the Agent contract exercised by the scenario. */
  const definition = parseAgentDefinitionManifest(manifest());
  provider.seedDefinition(definition);
  for (const resource of resources()) await provider.putResource(resource);
  provider.seedTaskStatusOptions(["Testing", "Needs Human Resolution"]);
  /** Captures the immutable Agent definition graph after resolution. */
  const resolved = await resolveDefinition(provider, definition.id);
  assert.equal(resolved.taskQuery?.limit, 5);
  assert.deepEqual(
    resolved.resources.map((resource) => resource.key),
    [
      "policy/base",
      "prompt/security",
      "query/security",
      "schema/selection",
      "schema/work",
    ],
  );
  assert.match(resolved.digest, /^[a-f0-9]{64}$/u);
  /** Captures the validated definition ready for dispatch. */
  const [activated] = await activateDefinitions({
    installedCapabilities: ["repository.read"],
    installedIntents: ["error.upsert", "task.status.transition"],
    installedRunnerProfiles: [definition.runnerProfile],
    provider,
    supportedModels: { [definition.model]: [definition.reasoning] },
  });
  assert.equal(activated?.resolved.definition.id, "security-auditor");
});

test("blocks activation when a provider-defined route has no Task status", async () => {
  /** Provides isolated provider state for the scenario. */
  const provider = new InMemoryProvider(environment, target);
  /** Supplies the Agent contract exercised by the scenario. */
  const definition = parseAgentDefinitionManifest(manifest());
  provider.seedDefinition(definition);
  for (const resource of resources()) await provider.putResource(resource);
  provider.seedTaskStatusOptions(["Testing"]);
  await assert.rejects(
    activateDefinitions({
      installedCapabilities: ["repository.read"],
      installedIntents: definition.allowedIntents,
      installedRunnerProfiles: [definition.runnerProfile],
      provider,
      supportedModels: { [definition.model]: [definition.reasoning] },
    }),
    /Needs Human Resolution/,
  );
});

test("builds bounded candidate sets, least-privilege grants, and data-defined routes", () => {
  /** Supplies the Agent contract exercised by the scenario. */
  const definition = parseAgentDefinitionManifest(manifest());
  /** Decodes the Notion query request under simulation. */
  const query = parseTaskQueryContract(taskQueryBody());
  assert.deepEqual(taskQueryForDefinition(query, definition), {
    cursor: null,
    dependencySatisfiedStatuses: ["Done"],
    limit: 5,
    predicate: { status: "Security Review" },
  });
  /** Supplies the bounded tasks considered for selection. */
  const candidateSet = finalizeCandidateSet(query, [
    {
      archived: false,
      id: "b",
      priority: 2,
      status: "Security Review",
      title: "B",
      version: "2",
    },
    {
      archived: false,
      id: "a",
      priority: 1,
      status: "Security Review",
      title: "A",
      version: "1",
    },
  ]);
  assert.deepEqual(
    candidateSet.summaries.map((task) => task.id),
    ["a", "b"],
  );
  /** Supplies the capability grant bound to the Agent definition. */
  const grant = compileCapabilityGrant({
    definition,
    installedCapabilities: ["repository.read"],
    providerCapabilities: {
      archive: true,
      attachments: true,
      conditionalWrites: "atomic",
      deterministicPagination: true,
      idempotencyLookup: true,
      leases: "atomic",
      managedContent: true,
      relations: true,
      schemaDiscovery: true,
      schemaMutation: true,
      stableRecordIds: true,
    },
  });
  assert.deepEqual(grant.capabilities, ["repository.read"]);
  assert.equal(
    routeOutcome({
      currentStatus: "Security Review",
      definition,
      outcome: "succeeded",
      validStatuses: ["Testing"],
    }),
    "Testing",
  );
  assert.equal(
    routeOutcome({
      currentStatus: "Security Review",
      definition,
      outcome: "partial",
      validStatuses: ["Testing"],
    }),
    "Security Review",
  );
});

test("accepts bounded multi-status Task queries", () => {
  /** Defines a Task query spanning only human-authorized workflow stages. */
  const query = parseTaskQueryContract(
    JSON.stringify({
      dependencySatisfiedStatuses: ["Completed"],
      limit: 25,
      predicate: { status: ["Ready", "Planned"] },
      schema: "task-query-v1",
    }),
  );
  /** Defines a representative Ready Task candidate. */
  const readyTask = {
    archived: false,
    id: "ready-task",
    priority: 1,
    status: "Ready",
    title: "Ready Task",
    version: "1",
  };

  assert.equal(taskSummaryMatchesPredicate(readyTask, query.predicate), true);
  assert.equal(
    taskSummaryMatchesPredicate(
      { ...readyTask, id: "backlog-task", status: "Backlog" },
      query.predicate,
    ),
    false,
  );
  assert.throws(
    () =>
      parseTaskQueryContract(
        JSON.stringify({
          ...query,
          predicate: { status: [] },
        }),
      ),
    /at least one value/,
  );
  assert.throws(
    () =>
      parseTaskQueryContract(
        JSON.stringify({
          ...query,
          predicate: { status: ["Ready", "Ready"] },
        }),
      ),
    /contains duplicates/,
  );
  assert.throws(
    () => taskSummaryMatchesPredicate(readyTask, { status: [] }),
    /Unsupported task predicate: status/,
  );
});

test("supports arbitrary provider-defined role names without core changes", () => {
  /** Supplies the provider-defined security policy Resource. */
  const security = parseAgentDefinitionManifest(manifest());
  /** Supplies a provider-defined localization Resource. */
  const localization = parseAgentDefinitionManifest({
    ...manifest(),
    humanResolutionOutcomes: [],
    id: "localization-curator",
    name: "Localization Curator",
    promptResources: ["prompt/localization"],
    transitions: { partial: "$current", succeeded: "Editorial QA" },
  });
  assert.deepEqual(
    [security.id, localization.id],
    ["security-auditor", "localization-curator"],
  );
});

/** Builds a complete provider-defined Agent manifest. */
function manifest(): JsonObject {
  return {
    allowedIntents: ["task.status.transition", "error.upsert"],
    capabilities: ["repository.read"],
    maxConcurrency: 1,
    maxAssignmentsPerRun: 1,
    contextBudgetBytes: 100000,
    deadlineSeconds: 600,
    enabled: true,
    humanResolutionOutcomes: ["blocked"],
    id: "security-auditor",
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    priority: 40,
    maxAssignmentDepth: 2,
    model: "gpt-5.6-sol",
    name: "Security Auditor",
    prohibitedCapabilities: ["repository.write"],
    promptResources: ["prompt/security"],
    reasoning: "high",
    requiredProviderCapabilities: [
      "conditionalWrites=atomic",
      "stableRecordIds",
    ],
    retry: { maxAttempts: 2, noVerdict: "retry" },
    revision: 3,
    runnerProfile: "codex-readonly",
    schema: "agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: ["self", "coordinator", "explicit"],
      maxCandidateSummaries: 25,
      mode: "self",
      resultSchema: "schema/selection",
      taskQueryResource: "query/security",
    },
    transitions: {
      blocked: "Needs Human Resolution",
      partial: "$current",
      succeeded: "Testing",
    },
    outputSchema: "schema/work",
  };
}

/** Builds the Resource graph referenced by the manifest. */
function resources(): ResourceMutation[] {
  return [
    resource("policy/base", "policy", "Base policy"),
    resource("prompt/security", "prompt", "Review security", [
      { digest: null, key: "policy/base", version: "v1" },
    ]),
    resource("query/security", "task-query", taskQueryBody()),
    resource("schema/selection", "json-schema", closedSchema()),
    resource("schema/work", "json-schema", closedSchema()),
  ];
}

/** Builds a digest-bound Resource mutation for a dynamic-definition fixture. */
function resource(
  key: string,
  kind: string,
  body: string,
  dependencies: ResourceMutation["dependencies"] = [],
): ResourceMutation {
  return {
    body,
    dependencies,
    digest: sha256(body),
    idempotencyKey: `seed:${key}`,
    key,
    kind,
    state: "active",
    version: "v1",
  };
}

/** Builds query body. */
function taskQueryBody(): string {
  return JSON.stringify({
    dependencySatisfiedStatuses: ["Done"],
    limit: 5,
    predicate: { status: "Security Review" },
    schema: "task-query-v1",
  });
}

/** Returns a minimal closed JSON Schema. */
function closedSchema(): string {
  return JSON.stringify({
    additionalProperties: false,
    properties: {},
    required: [],
    type: "object",
  });
}
