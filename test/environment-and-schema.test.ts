/** Strict configuration, schema, identifier, and payload parsing coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EnvironmentConfigError,
  parseEnvironmentConfig,
} from "../src/config/environment.js";
import { toJsonValue } from "../src/domain/json.js";
import {
  parseAgentDefinition,
  parseReportErrorInput,
  validateAgentTransitions,
} from "../src/domain/records.js";
import { normalizeNotionId } from "../src/provider/notion/notion-id.js";
import { NOTION_TABLES } from "../src/provider/notion/notion-schema.js";

test("Notion identifiers share one strict normalization boundary", () => {
  const compact = "6269a6efcd5882168fb5016fb99ff102";
  assert.equal(normalizeNotionId(compact.toUpperCase()), compact);
  assert.equal(
    normalizeNotionId("6269a6ef-cd58-8216-8fb5-016fb99ff102"),
    compact,
  );
  assert.equal(
    normalizeNotionId(
      "https://app.notion.com/p/Code-Reviewer-6269a6efcd5882168fb5016fb99ff102",
    ),
    compact,
  );
  assert.throws(
    () => normalizeNotionId("agent-0"),
    /Invalid Notion identifier/u,
  );
});

test("decoded Agent transitions validate without a JSON round trip", () => {
  assert.deepEqual(
    validateAgentTransitions({ blocked: "Blocked", succeeded: "Completed" }),
    { blocked: "Blocked", succeeded: "Completed" },
  );
  assert.throws(
    () => validateAgentTransitions({ blocked: null }),
    /Invalid Task status/u,
  );
});

test("v2 environment accepts only the five simplified tables", () => {
  const value = parseEnvironmentConfig(
    toJsonValue({
      environmentId: "management-v2",
      provider: {
        bootstrapParent: "parent",
        connection: { tokenEnv: "NOTION_TOKEN" },
        tables: {
          activeAgents: null,
          agents: "a",
          errors: "e",
          resources: "r",
          tasks: "t",
        },
        type: "notion",
      },
      schema: "agent-task-manager-environment-v2",
    }),
  );
  assert.deepEqual(Object.keys(value.provider.tables).sort(), [
    "activeAgents",
    "agents",
    "errors",
    "resources",
    "tasks",
  ]);
  assert.throws(
    () => parseEnvironmentConfig(toJsonValue({ ...value.raw, runtime: {} })),
    EnvironmentConfigError,
  );
});

test("Notion schema has only Tasks, Agents, Resources, Active Agents, and Errors", () => {
  assert.deepEqual(NOTION_TABLES.map((table) => table.kind).sort(), [
    "activeAgents",
    "agents",
    "errors",
    "resources",
    "tasks",
  ]);
  const agents = NOTION_TABLES.find((table) => table.kind === "agents")!;
  assert.deepEqual(
    agents.properties.map((property) => property.name),
    ["Name"],
  );
  const active = NOTION_TABLES.find((table) => table.kind === "activeAgents")!;
  assert.equal(
    active.properties.find((property) => property.name === "Task")?.syncedName,
    "Active Agents",
  );
  assert.deepEqual(
    NOTION_TABLES.find((table) => table.kind === "tasks")?.properties.find(
      (property) => property.name === "Status",
    )?.options,
    [
      "Backlog",
      "Ready",
      "Planned",
      "In progress",
      "Blocked",
      "In review",
      "Completed",
      "Cancelled",
      "Duplicate",
      "Not reproducible",
      "Superseded",
    ],
  );
});

test("Agent configuration is parsed from the page body", () => {
  const definition = parseAgentDefinition(`## Agent definition

\`\`\`json
{
  "schema": "agent-definition-v2",
  "enabled": true,
  "commands": {"inclusion": ["git", "pnpm.cmd"]},
  "id": "code-reviewer",
  "model": "gpt-5.6-sol",
  "reasoning": "high",
  "inputResourceSelectors": ["policy/review", "schema/result-v1"],
  "promptResources": ["prompt/code-reviewer"],
  "transitions": {"succeeded": "In progress", "blocked": "Blocked"}
}
\`\`\`
`);
  assert.equal(definition.id, "code-reviewer");
  assert.equal(definition.model, "gpt-5.6-sol");
  assert.deepEqual(definition.commands, { inclusion: ["git", "pnpm"] });
  assert.deepEqual(definition.resourceKeys, [
    "prompt/code-reviewer",
    "policy/review",
  ]);
  assert.deepEqual(definition.transitions, {
    blocked: "Blocked",
    succeeded: "In progress",
  });
});

test("Agent definitions read v1 as deny-all and reject unsupported schemas", () => {
  const valid = {
    commands: { exclusion: [] },
    enabled: true,
    id: "code-reviewer",
    inputResourceSelectors: ["policy/review"],
    model: "gpt-5.6-sol",
    promptResources: ["prompt/code-reviewer"],
    reasoning: "high",
    schema: "agent-definition-v2",
    transitions: { succeeded: "In progress" },
  };
  const markdown = (definition: object): string =>
    `## Agent definition\n\n\`\`\`json\n${JSON.stringify(definition)}\n\`\`\`\n`;

  assert.deepEqual(
    parseAgentDefinition(
      markdown({
        ...valid,
        commands: undefined,
        schema: "agent-definition-v1",
      }),
    ).commands,
    { inclusion: [] },
  );
  assert.throws(
    () => parseAgentDefinition(markdown({ ...valid, schema: "unknown" })),
    /schema must equal agent-definition-v1 or agent-definition-v2/u,
  );
  assert.throws(
    () =>
      parseAgentDefinition(
        markdown({ ...valid, schema: "agent-definition-v1" }),
      ),
    /unsupported fields: commands/u,
  );
  assert.throws(
    () => parseAgentDefinition(markdown({ ...valid, prohibitedCommand: "rm" })),
    /unsupported fields: prohibitedCommand/u,
  );
});

test("Agent definitions require explicit Prompt and Policy resources", () => {
  const valid = {
    commands: { exclusion: [] },
    enabled: true,
    id: "code-reviewer",
    inputResourceSelectors: ["policy/review", "schema/result-v1"],
    model: "gpt-5.6-sol",
    promptResources: ["prompt/code-reviewer"],
    reasoning: "high",
    schema: "agent-definition-v2",
    transitions: { succeeded: "In progress" },
  };
  const markdown = (definition: object): string =>
    `## Agent definition\n\n\`\`\`json\n${JSON.stringify(definition)}\n\`\`\`\n`;

  assert.throws(
    () =>
      parseAgentDefinition(
        markdown({ ...valid, promptResources: ["promtp/code-reviewer"] }),
      ),
    /promptResources must contain prompt\/\*/u,
  );
  assert.throws(
    () =>
      parseAgentDefinition(
        markdown({
          ...valid,
          inputResourceSelectors: ["polciy/review", "schema/result-v1"],
        }),
      ),
    /inputResourceSelectors must contain a policy\/\*/u,
  );
});

test("Error report input rejects unknown fields and invalid enums", () => {
  const valid = {
    activeAgentId: null,
    agentId: "agent",
    description: "Failure details",
    errorKey: "failure-key",
    resolution: "",
    severity: "high",
    source: "system",
    taskId: "task",
    title: "Failure",
  };
  assert.deepEqual(parseReportErrorInput(valid), valid);
  assert.throws(
    () => parseReportErrorInput({ ...valid, severity: "urgent" }),
    /severity is invalid/u,
  );
  assert.throws(
    () => parseReportErrorInput({ ...valid, unexpected: true }),
    /unsupported fields: unexpected/u,
  );
  const { title: _title, ...missingTitle } = valid;
  assert.throws(
    () => parseReportErrorInput(missingTitle),
    /title must be a string/u,
  );
});
