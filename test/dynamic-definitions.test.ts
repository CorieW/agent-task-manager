/** Verifies provider-defined roles, Resource resolution, grants, queries, and routes. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  compileCapabilityGrant,
  activateDefinitions,
  finalizeCandidateSet,
  InMemoryProvider,
  parseSubAgentDefinitionManifest,
  parseTaskQueryContract,
  resolveDefinition,
  routeOutcome,
  taskQueryForDefinition,
  type ProviderEnvironment,
  type JsonObject,
  type ResourceMutation,
  type WorkspaceSchemaDescriptor,
} from "../src/index.js";
import { sha256 } from "../src/core/digest.js";

/** Defines the shared environment fixture for this test module. */
const environment: ProviderEnvironment = {
  bootstrapParent: null,
  connection: {},
  tables: {
    errors: "errors",
    resources: "resources",
    subAgents: "agents",
    tasks: "tasks",
  },
  type: "memory",
};
/** Defines the shared target fixture for this test module. */
const target: WorkspaceSchemaDescriptor = {
  digest: "target",
  providerType: "memory",
  tables: [],
  version: "v1",
};

test("parses a complete role contract and rejects semantic capability conflicts", () => {
  /** Defines the parsed fixture for “parses a complete role contract and rejects semantic capability conflicts”. */
  const parsed = parseSubAgentDefinitionManifest(manifest());
  assert.equal(parsed.name, "Security Auditor");
  assert.equal(parsed.invocation.mode, "manual");
  assert.throws(
    () =>
      parseSubAgentDefinitionManifest({
        ...manifest(),
        prohibitedCapabilities: ["repository.read"],
      }),
    /both granted and prohibited/,
  );
});

test("resolves an active immutable Resource graph and closed output schemas", async () => {
  /** Defines the provider fixture for “resolves an active immutable Resource graph and closed output schemas”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the definition fixture for “resolves an active immutable Resource graph and closed output schemas”. */
  const definition = parseSubAgentDefinitionManifest(manifest());
  provider.seedDefinition(definition);
  for (const resource of resources()) await provider.putResource(resource);
  provider.seedTaskStatusOptions(["Testing", "Needs Human Resolution"]);
  /** Defines the resolved fixture for “resolves an active immutable Resource graph and closed output schemas”. */
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
  /** Defines the activated fixture for “resolves an active immutable Resource graph and closed output schemas”. */
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
  /** Defines the provider fixture for “blocks activation when a provider-defined route has no Task status”. */
  const provider = new InMemoryProvider(environment, target);
  /** Defines the definition fixture for “blocks activation when a provider-defined route has no Task status”. */
  const definition = parseSubAgentDefinitionManifest(manifest());
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
  /** Defines the definition fixture for “builds bounded candidate sets, least-privilege grants, and data-defined routes”. */
  const definition = parseSubAgentDefinitionManifest(manifest());
  /** Defines the query fixture for “builds bounded candidate sets, least-privilege grants, and data-defined routes”. */
  const query = parseTaskQueryContract(taskQueryBody());
  assert.deepEqual(taskQueryForDefinition(query, definition), {
    cursor: null,
    limit: 5,
    predicate: { status: "Security Review" },
  });
  /** Defines the candidate set fixture for “builds bounded candidate sets, least-privilege grants, and data-defined routes”. */
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
  /** Defines the grant fixture for “builds bounded candidate sets, least-privilege grants, and data-defined routes”. */
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

test("supports arbitrary provider-defined role names without core changes", () => {
  /** Defines the security fixture for “supports arbitrary provider-defined role names without core changes”. */
  const security = parseSubAgentDefinitionManifest(manifest());
  /** Defines the localization fixture for “supports arbitrary provider-defined role names without core changes”. */
  const localization = parseSubAgentDefinitionManifest({
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

/** Creates the manifest test fixture. */
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
    schema: "sub-agent-definition-v1",
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

/** Creates the resources test fixture. */
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
/** Builds resource. */
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
/** Creates the closed schema test fixture. */
function closedSchema(): string {
  return JSON.stringify({
    additionalProperties: false,
    properties: {},
    required: [],
    type: "object",
  });
}
