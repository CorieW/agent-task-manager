import assert from "node:assert/strict";
import test from "node:test";

import {
  EnvironmentConfigError,
  parseEnvironmentConfig,
} from "../src/config/environment.js";
import { toJsonValue } from "../src/domain/json.js";
import { parseAgentDefinition } from "../src/domain/records.js";
import { NOTION_TABLES } from "../src/provider/notion/notion-schema.js";

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
  "schema": "agent-definition-v1",
  "enabled": true,
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
  assert.deepEqual(definition.resourceKeys, [
    "prompt/code-reviewer",
    "policy/review",
  ]);
  assert.deepEqual(definition.transitions, {
    blocked: "Blocked",
    succeeded: "In progress",
  });
});

test("Agent definitions reject unsupported schemas and fields", () => {
  const valid = {
    enabled: true,
    id: "code-reviewer",
    inputResourceSelectors: ["policy/review"],
    model: "gpt-5.6-sol",
    promptResources: ["prompt/code-reviewer"],
    reasoning: "high",
    schema: "agent-definition-v1",
    transitions: { succeeded: "In progress" },
  };
  const markdown = (definition: object): string =>
    `## Agent definition\n\n\`\`\`json\n${JSON.stringify(definition)}\n\`\`\`\n`;

  assert.throws(
    () =>
      parseAgentDefinition(
        markdown({ ...valid, schema: "agent-definition-v2" }),
      ),
    /schema must equal agent-definition-v1/u,
  );
  assert.throws(
    () => parseAgentDefinition(markdown({ ...valid, prohibitedCommand: "rm" })),
    /unsupported fields: prohibitedCommand/u,
  );
});

test("Agent definitions require explicit Prompt and Policy resources", () => {
  const valid = {
    enabled: true,
    id: "code-reviewer",
    inputResourceSelectors: ["policy/review", "schema/result-v1"],
    model: "gpt-5.6-sol",
    promptResources: ["prompt/code-reviewer"],
    reasoning: "high",
    schema: "agent-definition-v1",
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
