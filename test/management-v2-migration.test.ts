/** Deterministic Management v2 migration planning and transport coverage. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalize } from "../src/core/canonical-json.js";
import { parseAgentDefinition } from "../src/domain/records.js";
import {
  replaceMarkdown,
  resolveActiveAgentsId,
} from "../scripts/migrate-management-v2.js";
import {
  ARCHIVED_RESOURCE_KEYS,
  EXPECTED_AGENT_NAMES,
  EXPECTED_ERROR_KEYS,
  MANAGEMENT_V2_DATABASES,
  MANAGEMENT_V2_PARENT,
  RETAINED_RESOURCE_KEYS,
  agentDefinitionMarkdown,
  auditManagedResourceContract,
  parseLegacyAgentManifest,
  planManagementV2Migration,
  retainedManifestResourceKeys,
  renderManagedResourceMarkdown,
  type ManagementInventory,
  type MigrationRow,
  type MigrationTable,
} from "../src/migration/management-v2.js";
import type {
  NotionRequest,
  NotionTransport,
} from "../src/provider/notion/notion-transport.js";

/** Test fixture for outcomes. */
const outcomes: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "Code Reviewer": {
    succeeded: "In progress",
    changes_requested: "Planned",
    blocked: "Blocked",
  },
  "Code Tester": {
    succeeded: "Completed",
    failed: "Planned",
    blocked: "Blocked",
  },
  Coder: { succeeded: "In review", blocked: "Blocked" },
  "Issue Reviewer": {
    triaged: "$current",
    duplicate: "Duplicate",
    not_reproducible: "Not reproducible",
    blocked: "Blocked",
  },
  "Project Manager": {
    succeeded: "$current",
    no_work: "$current",
    blocked: "Blocked",
  },
  Researcher: { succeeded: "In review", blocked: "Blocked" },
  "Task Master": {
    succeeded: "$current",
    no_work: "$current",
    blocked: "Blocked",
  },
  "Task Planner": {
    succeeded: "Planned",
    needs_human: "Blocked",
    blocked: "Blocked",
  },
};

test("expected Management v2 baseline produces a deterministic complete plan", () => {
  /** Test fixture for inventory. */
  const inventory = expectedLegacyInventory();
  /** First Active Agent record used to verify relation consistency. */
  const first = planManagementV2Migration(inventory);
  /** Test fixture for second. */
  const second = planManagementV2Migration(inventory);
  assert.equal(first.digest, second.digest);
  assert.equal(
    first.actions.filter((entry) => entry.kind === "convert_agent").length,
    8,
  );
  assert.equal(
    first.actions.filter((entry) => entry.kind === "rewrite_resource").length,
    18,
  );
  assert.equal(
    first.actions.filter((entry) => entry.kind === "archive_resource").length,
    10,
  );
  assert.equal(
    first.actions.filter((entry) => entry.kind === "archive_error").length,
    5,
  );
  assert.ok(
    first.actions.some((entry) => entry.kind === "create_active_agents"),
  );
});

test("incomplete Agent bodies still schedule persisted v1 conversion", () => {
  /** Test fixture for original. */
  const original = expectedLegacyInventory();
  /** First Active Agent record used to verify relation consistency. */
  const first = original.agents.rows[0]!;
  /** Strict legacy Agent manifest parsed from the managed section. */
  const manifest = parseLegacyAgentManifest(first.body);
  /** Test fixture for converted. */
  const converted = parseAgentDefinition(
    agentDefinitionMarkdown(
      {
        ...first,
        properties: { ...first.properties, Enabled: true, Model: "gpt" },
      },
      retainedManifestResourceKeys(manifest),
    ),
  );
  /** Test fixture for v1 body. */
  const v1Body = `## Agent definition\n\n\`\`\`json\n${JSON.stringify({
    calledBy: converted.calledBy,
    enabled: converted.enabled,
    id: converted.id,
    inputResourceSelectors: converted.resourceKeys.filter((key) =>
      key.startsWith("policy/"),
    ),
    model: converted.model,
    promptResources: converted.resourceKeys.filter((key) =>
      key.startsWith("prompt/"),
    ),
    reasoning: converted.reasoning,
    schema: "agent-definition-v1",
    transitions: converted.transitions,
  })}\n\`\`\`\n`;
  /** Test fixture for inventory. */
  const inventory: ManagementInventory = {
    ...original,
    agents: {
      ...original.agents,
      rows: [{ ...first, body: v1Body }, ...original.agents.rows.slice(1)],
    },
  };

  assert.throws(() => parseAgentDefinition(v1Body), /allowedStatuses/u);
  assert.equal(
    planManagementV2Migration(inventory).actions.filter(
      (entry) => entry.kind === "convert_agent",
    ).length,
    8,
  );
});

test("Management v2 plan digest is independent of Notion row order", () => {
  /** Test fixture for original. */
  const original = expectedLegacyInventory();
  /** Test fixture for reversed. */
  const reversed: ManagementInventory = {
    ...original,
    agents: { ...original.agents, rows: [...original.agents.rows].reverse() },
    errors: { ...original.errors, rows: [...original.errors.rows].reverse() },
    operations:
      original.operations === null
        ? null
        : {
            ...original.operations,
            rows: [...original.operations.rows].reverse(),
          },
    resources: {
      ...original.resources,
      rows: [...original.resources.rows].reverse(),
    },
    tasks: { ...original.tasks, rows: [...original.tasks.rows].reverse() },
  };

  assert.deepEqual(
    planManagementV2Migration(reversed),
    planManagementV2Migration(original),
  );
});

test("legacy manifests retain exact outcome maps and only active Prompt/Policy Resources", () => {
  for (const row of expectedLegacyInventory().agents.rows) {
    /** Strict legacy Agent manifest parsed from the managed section. */
    const manifest = parseLegacyAgentManifest(row.body);
    assert.equal(
      canonicalize(manifest.transitions),
      canonicalize(outcomes[row.title]!),
    );
    assert.ok(
      retainedManifestResourceKeys(manifest).every(
        (key) => key.startsWith("prompt/") || key.startsWith("policy/"),
      ),
    );
  }
});

test("column-backed Agent descriptions migrate into body definitions", () => {
  /** Test fixture for body. */
  const body = agentDefinitionMarkdown(
    row(
      "agent",
      "Code Reviewer",
      {
        "Agent Key": "code-reviewer",
        "Called By": "external harness",
        Enabled: true,
        Model: "gpt-5.6-sol",
        Notes: "Review changes",
        Reasoning: "high",
        Transitions: JSON.stringify(outcomes["Code Reviewer"]),
      },
      '## Agent description\n\nReview the code.\n\n```json\n{"example":true}\n```\n',
    ),
    ["prompt/code-reviewer", "policy/review/code-cleanliness"],
  );
  /** Strict Agent definition parsed from authoritative Markdown. */
  const definition = parseAgentDefinition(body);
  assert.equal(definition.id, "code-reviewer");
  assert.equal(definition.enabled, true);
  assert.deepEqual(definition.commands, { inclusion: [] });
  assert.deepEqual(definition.allowedTaskTypes, []);
  assert.deepEqual(definition.allowedStatuses, []);
  assert.deepEqual(definition.resourceKeys, [
    "prompt/code-reviewer",
    "policy/review/code-cleanliness",
  ]);
  assert.deepEqual(definition.transitions, outcomes["Code Reviewer"]);
  assert.match(body, /## Agent description\n\nReview the code\./u);
});

test("Agent definition conversion preserves content outside the managed section", () => {
  /** Test fixture for original. */
  const original = expectedLegacyInventory().agents.rows[0]!;
  /** Test fixture for decoy. */
  const decoy = JSON.stringify({
    id: "wrong-agent",
    inputResourceSelectors: ["policy/project-governance"],
    promptResources: ["prompt/wrong-agent"],
    reasoning: "low",
    transitions: { wrong: "Wrong" },
  });
  /** Test fixture for body. */
  const body = agentDefinitionMarkdown({
    ...original,
    body: `## JSON example\n\n\`\`\`json\n${decoy}\n\`\`\`\n\n${original.body}\n## Operator guidance\n\nKeep this prose verbatim.\n`,
    properties: { ...original.properties, Enabled: true, Model: "gpt" },
  });
  assert.equal(parseAgentDefinition(body).id, "code-reviewer");
  assert.match(body, /## Operator guidance\n\nKeep this prose verbatim\./u);
  assert.equal(body.match(/## Agent definition/gu)?.length, 1);
});

test("managed Resource contracts explain the harness boundary", () => {
  /** Legacy Agent manifest retained for parity conversion. */
  const legacy =
    "# Coder\nAcquire a lease.\n\n```sh\n# Keep this exact\necho 'Operations database'\n```";
  /** Test fixture for value. */
  const value = renderManagedResourceMarkdown("prompt/coder", legacy);
  assert.match(value, /external harness owns conversation history/);
  assert.match(value, /heartbeat at least once every five minutes/);
  assert.equal(value.endsWith(legacy), true);
  assert.deepEqual(auditManagedResourceContract(value), []);
});

test("planning after partial additive progress is safe and omits completed actions", () => {
  /** Test fixture for original. */
  const original = expectedLegacyInventory();
  /** Test fixture for retained. */
  const retained = original.resources.rows
    .filter((row) => RETAINED_RESOURCE_KEYS.includes(row.title as never))
    .map((row) => ({
      ...row,
      body: renderManagedResourceMarkdown(row.title, row.body),
    }));
  /** Initial Agent records for the in-memory provider. */
  const agents = original.agents.rows.map((row) => ({
    ...row,
    body: agentDefinitionMarkdown({
      ...row,
      properties: { ...row.properties, Enabled: true, Model: "gpt-5.6-sol" },
    }),
  }));
  /** Test fixture for partial. */
  const partial: ManagementInventory = {
    ...original,
    activeAgents: table(
      testNotionId("active"),
      { "Run ID": "title", Agent: "relation", Task: "relation" },
      [],
    ),
    agents: table(MANAGEMENT_V2_DATABASES.agents, { Name: "title" }, agents),
    errors: table(
      MANAGEMENT_V2_DATABASES.errors,
      {
        Agent: "relation",
        "Active Agent": "relation",
        Error: "title",
        "Error Key": "rich_text",
        Severity: "select",
        Source: "select",
        Status: "select",
        Task: "relation",
      },
      [],
    ),
    operations: null,
    resources: table(
      MANAGEMENT_V2_DATABASES.resources,
      { Kind: "select", Resource: "title", State: "select" },
      retained,
    ),
    tasks: table(
      MANAGEMENT_V2_DATABASES.tasks,
      {
        Dependencies: "relation",
        Status: "select",
        Task: "title",
        Type: "select",
      },
      [],
    ),
  };
  /** Test fixture for plan. */
  const plan = planManagementV2Migration(partial);
  assert.deepEqual(
    plan.actions.map((entry) => entry.kind),
    ["verify"],
  );
});

test("every legacy Task property authorizes legacy schema cleanup", () => {
  /** Test fixture for original. */
  const original = expectedLegacyInventory();
  /** Test fixture for partial. */
  const partial = {
    ...original,
    tasks: {
      ...original.tasks,
      properties: {
        Dependencies: "relation",
        "Review Round": "number",
        Status: "select",
        Task: "title",
      },
    },
  };

  assert.ok(
    planManagementV2Migration(partial).actions.some(
      (action) => action.kind === "drop_legacy_schema",
    ),
  );
});

test("migration preflight rejects duplicate Resource keys", () => {
  /** Test fixture for original. */
  const original = expectedLegacyInventory();
  /** Test fixture for duplicate. */
  const duplicate = {
    ...original.resources.rows[0]!,
    id: testNotionId("duplicate-resource"),
  };

  assert.throws(
    () =>
      planManagementV2Migration({
        ...original,
        resources: {
          ...original.resources,
          rows: [...original.resources.rows, duplicate],
        },
      }),
    /duplicate Resource key/u,
  );
});

test("migration body updates require the inventoried Markdown to match", async () => {
  /** Test fixture for requests. */
  const requests: NotionRequest[] = [];
  /** Test fixture for transport. */
  const transport: NotionTransport = {
    /** Captures schema mutation requests. */
    request(request) {
      requests.push(request);
      return Promise.resolve({});
    },
  };

  await replaceMarkdown(
    transport,
    "11111111111111111111111111111111",
    "original body",
    "migrated body",
  );
  assert.deepEqual(requests, [
    {
      body: {
        type: "update_content",
        update_content: {
          new_str: "migrated body",
          old_str: "original body",
        },
      },
      method: "PATCH",
      path: "/v1/pages/11111111111111111111111111111111/markdown",
    },
  ]);
});

test("migration preflight rejects conflicting Agent bodies and columns", () => {
  /** Test fixture for original. */
  const original = expectedLegacyInventory();
  /** First Active Agent record used to verify relation consistency. */
  const first = original.agents.rows[0]!;
  /** Test fixture for converted. */
  const converted = agentDefinitionMarkdown({
    ...first,
    properties: { ...first.properties, Enabled: true, Model: "body-model" },
  });
  /** Initial Agent records for the in-memory provider. */
  const agents = original.agents.rows.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          body: converted,
          properties: {
            ...entry.properties,
            Enabled: true,
            Model: "legacy-model",
          },
        }
      : entry,
  );

  assert.throws(
    () =>
      planManagementV2Migration({
        ...original,
        agents: { ...original.agents, rows: agents },
      }),
    /body conflicts with legacy Model/u,
  );
});

test("migration preflight rejects incompatible additive schema", () => {
  /** Test fixture for original. */
  const original = expectedLegacyInventory();
  assert.throws(
    () =>
      planManagementV2Migration({
        ...original,
        errors: {
          ...original.errors,
          properties: { ...original.errors.properties, Source: "rich_text" },
        },
      }),
    /\.Source expected select, observed rich_text/u,
  );

  assert.throws(
    () =>
      planManagementV2Migration({
        ...original,
        activeAgents: table(
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          { "Run ID": "title", Agent: "relation" },
          [row("active-run", "run", {}, "")],
        ),
      }),
    /Active Agents must contain 0 live rows/u,
  );
});

test("migration discovers and verifies the exact Active Agents database", async () => {
  /** Test fixture for database ID. */
  const databaseId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  /** Test fixture for source ID. */
  const sourceId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  /** Test fixture for transport. */
  const transport: NotionTransport = {
    /** Routes discovery requests for the legacy Active Agents database. */
    request(request) {
      if (
        request.path.startsWith(`/v1/blocks/${MANAGEMENT_V2_PARENT}/children`)
      )
        return Promise.resolve({
          has_more: false,
          next_cursor: null,
          results: [
            {
              child_database: { title: "Active Agents" },
              id: databaseId,
              type: "child_database",
            },
          ],
        });
      if (request.path === `/v1/databases/${databaseId}`)
        return Promise.resolve({
          data_sources: [{ id: sourceId }],
          parent: { page_id: MANAGEMENT_V2_PARENT, type: "page_id" },
          title: [{ plain_text: "Active Agents" }],
        });
      if (request.path === `/v1/data_sources/${sourceId}`)
        return Promise.resolve({
          parent: { database_id: databaseId, type: "database_id" },
        });
      return Promise.reject(new Error(`Unexpected request: ${request.path}`));
    },
  };

  assert.equal(await resolveActiveAgentsId(transport, null), sourceId);
});

/** Builds the complete authorized legacy inventory baseline. */
function expectedLegacyInventory(): ManagementInventory {
  /** Prompt by agent captured by the expected legacy inventory fixture. */
  const promptByAgent = (name: string) =>
    `prompt/${name.toLowerCase().replace(/ /gu, "-")}`;
  /** Agent rows captured by the expected legacy inventory fixture. */
  const agentRows = EXPECTED_AGENT_NAMES.map((name, index) =>
    row(
      `agent-${index}`,
      name,
      {
        "Called By": "external harness",
        Notes: "",
        "Error Key": null,
      },
      `## Agent definition\n\n\`\`\`json\n${JSON.stringify({ id: name.toLowerCase().replace(/ /gu, "-"), inputResourceSelectors: ["policy/project-governance", "query/planned", "schema/role-result-v1"], promptResources: [promptByAgent(name)], reasoning: name === "Coder" ? "high" : "medium", transitions: outcomes[name] })}\n\`\`\`\n`,
    ),
  );
  /** Resources captured by the expected legacy inventory fixture. */
  const resources = [...RETAINED_RESOURCE_KEYS, ...ARCHIVED_RESOURCE_KEYS].map(
    (key, index) =>
      row(
        `resource-${index}`,
        key,
        {},
        `# ${key}\nLegacy role responsibilities.`,
      ),
  );
  /** Initial Error records for the in-memory provider. */
  const errors = EXPECTED_ERROR_KEYS.map((key, index) =>
    row(`error-${index}`, `Error ${index}`, { "Error Key": key }, "Error"),
  );
  return {
    activeAgents: null,
    agents: table(
      MANAGEMENT_V2_DATABASES.agents,
      {
        "Called By": "rich_text",
        Enabled: "checkbox",
        "Last Run": "last_edited_time",
        Model: "rich_text",
        Name: "title",
        Notes: "rich_text",
        Revision: "number",
        Status: "select",
        "Working On": "relation",
      },
      agentRows,
    ),
    errors: table(
      MANAGEMENT_V2_DATABASES.errors,
      {
        Agent: "relation",
        Error: "title",
        "Error Key": "rich_text",
        "Run ID": "rich_text",
        Severity: "select",
        Status: "select",
        Task: "relation",
      },
      errors,
    ),
    operations: table(
      MANAGEMENT_V2_DATABASES.operations,
      { Operation: "title" },
      [row("operation", "", {}, "")],
    ),
    parentId: MANAGEMENT_V2_PARENT,
    resources: table(
      MANAGEMENT_V2_DATABASES.resources,
      {
        Dependencies: "rich_text",
        Digest: "rich_text",
        Kind: "select",
        Resource: "title",
        State: "select",
        Version: "rich_text",
      },
      resources,
    ),
    tasks: table(
      MANAGEMENT_V2_DATABASES.tasks,
      {
        "Manager Mutation": "rich_text",
        Dependencies: "relation",
        Status: "select",
        Task: "title",
      },
      [],
    ),
  };
}
/** Returns the configured data-source ID for a managed table. */
function table(
  id: string,
  properties: Readonly<Record<string, string>>,
  rows: readonly MigrationRow[],
): MigrationTable {
  return { id, properties, rows };
}
/** Builds one migration row fixture. */
function row(
  id: string,
  title: string,
  properties: MigrationRow["properties"],
  body: string,
): MigrationRow {
  return {
    body,
    id: testNotionId(id),
    properties,
    title,
  };
}

/** Derives a deterministic 32-character Notion ID from a fixture seed. */
function testNotionId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}
