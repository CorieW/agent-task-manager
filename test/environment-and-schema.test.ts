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
  /** Dash-free Notion identifier used for strict validation. */
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
  assert.equal(
    normalizeNotionId(
      "https://app.notion.com/p/Code-Reviewer-6269a6efcd5882168fb5016fb99ff102?v=25e9a6efcd5882e5939c08d945cc76f5&source=copy_link",
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
  assert.deepEqual(
    NOTION_TABLES.find((table) => table.kind === "tasks")?.properties.find(
      (property) => property.name === "Type",
    )?.options,
    [],
  );
});

test("v1 environment contains provider configuration only", () => {
  /** Parsed provider-only environment compared with the source JSON. */
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
      schema: "agent-task-manager-environment-v1",
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
  assert.throws(
    () =>
      parseEnvironmentConfig(
        toJsonValue({
          ...value.raw,
          lifecycleCommands: {},
        }),
      ),
    /lifecycleCommands is not allowed/u,
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
  /** Canonical Agents-table descriptor inspected for relation targets. */
  const agents = NOTION_TABLES.find((table) => table.kind === "agents")!;
  assert.deepEqual(
    agents.properties.map((property) => property.name),
    ["Name"],
  );
  /** Active Agent snapshot used to determine the protected run set. */
  const active = NOTION_TABLES.find((table) => table.kind === "activeAgents")!;
  assert.equal(
    active.properties.find((property) => property.name === "Task")?.syncedName,
    "Active Agents",
  );
  assert.equal(
    active.properties.find((property) => property.name === "Task ID")?.type,
    "rich_text",
  );
  assert.equal(
    active.properties.find((property) => property.name === "Working Directory")
      ?.type,
    "rich_text",
  );
  assert.deepEqual(
    NOTION_TABLES.find((table) => table.kind === "tasks")?.properties.find(
      (property) => property.name === "Status",
    )?.options,
    [],
  );
});

test("Agent configuration is parsed from the page body", () => {
  /** Strict Agent definition parsed from authoritative Markdown. */
  const definition = parseAgentDefinition(`## Agent definition

\`\`\`json
{
  "schema": "agent-definition-v1",
  "enabled": true,
  "commands": {"inclusion": ["git", "pnpm.cmd"]},
  "allowedTaskTypes": ["Bug", "Vulnerability"],
  "allowedStatuses": ["In progress", "Blocked"],
  "id": "code-reviewer",
  "model": "gpt-5.6-sol",
  "reasoning": "high",
  "lifecycleCommands": {
    "workingDirectory": "C:\\\\runs\\\\{{runId}}",
    "beforeAgent": [{
      "executable": "prepare",
      "arguments": ["{{workingDirectory}}"],
      "workingDirectory": "C:\\\\project",
      "environment": {"TASK_ID": "{{taskId}}"},
      "inheritEnvironment": [],
      "timeoutMilliseconds": 30000
    }],
    "afterAgent": []
  },
  "inputResourceSelectors": ["agent-policy/review", "schema/result-v1"],
  "promptResources": ["prompt/code-reviewer"],
  "taskDescription": {
    "writableSections": ["Planning"],
    "requiredSectionsByOutcome": {"succeeded": ["Planning"]}
  },
  "transitions": {"succeeded": "In progress", "blocked": "Blocked"}
}
\`\`\`
`);
  assert.equal(definition.id, "code-reviewer");
  assert.equal(definition.model, "gpt-5.6-sol");
  assert.deepEqual(definition.commands, { inclusion: ["git", "pnpm"] });
  assert.deepEqual(definition.allowedTaskTypes, ["Bug", "Vulnerability"]);
  assert.deepEqual(definition.allowedStatuses, ["In progress", "Blocked"]);
  assert.equal(
    definition.lifecycleCommands.beforeAgent[0]?.executable,
    "prepare",
  );
  assert.equal(
    definition.lifecycleCommands.workingDirectory,
    "C:\\runs\\{{runId}}",
  );
  assert.deepEqual(definition.resourceKeys, [
    "prompt/code-reviewer",
    "agent-policy/review",
  ]);
  assert.deepEqual(definition.transitions, {
    blocked: "Blocked",
    succeeded: "In progress",
  });
  assert.deepEqual(definition.taskDescription, {
    requiredSectionsByOutcome: { succeeded: ["Planning"] },
    writableSections: ["Planning"],
  });
});

test("Agent definitions accept only the complete v1 schema", () => {
  /** Valid case exercised by "Agent definitions accept only the complete v1 schema". */
  const valid = {
    allowedStatuses: ["In progress"],
    allowedTaskTypes: ["Feature"],
    commands: { exclusion: [] },
    enabled: true,
    id: "code-reviewer",
    inputResourceSelectors: ["agent-policy/review"],
    model: "gpt-5.6-sol",
    promptResources: ["prompt/code-reviewer"],
    reasoning: "high",
    schema: "agent-definition-v1",
    transitions: { succeeded: "In progress" },
  };
  /** Markdown supplied to "Agent definitions accept only the complete v1 schema". */
  const markdown = (definition: object): string =>
    `## Agent definition\n\n\`\`\`json\n${JSON.stringify(definition)}\n\`\`\`\n`;

  assert.deepEqual(parseAgentDefinition(markdown(valid)).commands, {
    exclusion: [],
  });
  assert.deepEqual(parseAgentDefinition(markdown(valid)).taskDescription, {
    requiredSectionsByOutcome: {},
    writableSections: [],
  });
  assert.throws(
    () => parseAgentDefinition(markdown({ ...valid, schema: "unsupported" })),
    /schema must equal agent-definition-v1/u,
  );
  assert.throws(
    () => parseAgentDefinition(markdown({ ...valid, commands: undefined })),
    /commands must be an object/u,
  );
  assert.throws(
    () => parseAgentDefinition(markdown({ ...valid, prohibitedCommand: "rm" })),
    /unsupported fields: prohibitedCommand/u,
  );
  assert.throws(
    () =>
      parseAgentDefinition(
        markdown({
          ...valid,
          taskDescription: {
            requiredSectionsByOutcome: { missing: ["Planning"] },
            writableSections: ["Planning"],
          },
        }),
      ),
    /unknown outcome/u,
  );
});

test("Agent v1 requires unique user-defined Task type and status allowlists", () => {
  /** Strict Agent definition parsed from authoritative Markdown. */
  const definition = {
    allowedStatuses: ["Planning"],
    allowedTaskTypes: ["Bug"],
    commands: { inclusion: [] },
    enabled: true,
    id: "coder",
    inputResourceSelectors: ["agent-policy/review"],
    model: "gpt",
    promptResources: ["prompt/coder"],
    reasoning: "high",
    schema: "agent-definition-v1",
    transitions: { succeeded: "Planning" },
  };
  /** Markdown supplied to "Agent v1 requires unique user-defined Task type and status allowlists". */
  const markdown = (value: object): string =>
    `## Agent definition\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;

  assert.throws(
    () =>
      parseAgentDefinition(
        markdown({ ...definition, allowedTaskTypes: ["Bug", "Bug"] }),
      ),
    /allowedTaskTypes must not contain duplicates/u,
  );
  assert.throws(
    () =>
      parseAgentDefinition(
        markdown({ ...definition, allowedStatuses: ["Planning", ""] }),
      ),
    /allowedStatuses must not contain empty values/u,
  );
});

test("Agent definitions require explicit Prompt and Agent Policy resources", () => {
  /** Valid case exercised by "Agent definitions require explicit Prompt and Agent Policy resources". */
  const valid = {
    allowedStatuses: ["In progress"],
    allowedTaskTypes: ["Feature"],
    commands: { exclusion: [] },
    enabled: true,
    id: "code-reviewer",
    inputResourceSelectors: ["agent-policy/review", "schema/result-v1"],
    model: "gpt-5.6-sol",
    promptResources: ["prompt/code-reviewer"],
    reasoning: "high",
    schema: "agent-definition-v1",
    transitions: { succeeded: "In progress" },
  };
  /** Markdown supplied to "Agent definitions require explicit Prompt and Agent Policy resources". */
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
          inputResourceSelectors: ["agent-polciy/review", "schema/result-v1"],
        }),
      ),
    /inputResourceSelectors must contain an agent-policy\/\*/u,
  );
});

test("Error report input rejects unknown fields and invalid enums", () => {
  /** Valid case exercised by "Error report input rejects unknown fields and invalid enums". */
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
  /** Invalid task-properties fixture with no title property. */
  const { title: _title, ...missingTitle } = valid;
  assert.throws(
    () => parseReportErrorInput(missingTitle),
    /title must be a string/u,
  );
});
