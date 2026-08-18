import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "../src/domain/json.js";
import { NotionProvider } from "../src/provider/notion/notion-provider.js";
import { NOTION_TABLES } from "../src/provider/notion/notion-schema.js";
import type {
  NotionRequest,
  NotionTransport,
} from "../src/provider/notion/notion-transport.js";

const ids = {
  activeAgents: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  agent: "11111111111111111111111111111111",
  badAgent: "44444444444444444444444444444444",
  childRun: "55555555555555555555555555555555",
  agents: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  errors: "cccccccccccccccccccccccccccccccc",
  policy: "22222222222222222222222222222222",
  prompt: "33333333333333333333333333333333",
  parentRun: "66666666666666666666666666666666",
  restartRun: "77777777777777777777777777777777",
  resources: "dddddddddddddddddddddddddddddddd",
  tasks: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
} as const;

test("Notion Agent records derive configuration and Resources from the page body", async () => {
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: ids.activeAgents,
        agents: ids.agents,
        errors: ids.errors,
        resources: ids.resources,
        tasks: ids.tasks,
      },
      type: "notion",
    },
    new AgentBodyTransport(),
  );

  const agent = await provider.getAgentByKey("code-reviewer");
  assert.ok(agent);
  assert.equal(agent.enabled, true);
  assert.equal(agent.model, "gpt-5.6-sol");
  assert.equal(agent.reasoning, "high");
  assert.deepEqual(agent.resourceIds, [ids.prompt, ids.policy]);
  assert.deepEqual(agent.transitions, {
    blocked: "Blocked",
    succeeded: "In progress",
  });
  assert.deepEqual(Object.keys(agent.properties), ["Name"]);
});

test("Notion workspace validation reports malformed Agent bodies", async () => {
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: ids.activeAgents,
        agents: ids.agents,
        errors: ids.errors,
        resources: ids.resources,
        tasks: ids.tasks,
      },
      type: "notion",
    },
    new AgentBodyTransport(),
  );

  const report = await provider.validateWorkspace();
  assert.equal(report.valid, false);
  assert.ok(
    report.issues.some(
      (entry) =>
        entry.code === "agent_definition" &&
        entry.path === `Agents.${ids.badAgent}`,
    ),
  );
});

test("Notion Active Agent lookup preserves parent and restart Run IDs", async () => {
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: ids.activeAgents,
        agents: ids.agents,
        errors: ids.errors,
        resources: ids.resources,
        tasks: ids.tasks,
      },
      type: "notion",
    },
    new AgentBodyTransport(),
  );

  const run = await provider.getActiveAgent("child");
  assert.equal(run?.parentRunId, "root");
  assert.equal(run?.restartOfRunId, "failed");
});

class AgentBodyTransport implements NotionTransport {
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (
      request.method === "GET" &&
      request.path.startsWith("/v1/data_sources/")
    ) {
      const sourceId = request.path.split("/").at(-1);
      const table = NOTION_TABLES.find((entry) => ids[entry.kind] === sourceId);
      if (table !== undefined)
        return {
          properties: Object.fromEntries(
            table.properties.map((property) => [
              property.name,
              { type: property.type },
            ]),
          ),
        };
    }
    if (request.path === `/v1/data_sources/${ids.agents}/query`)
      return pageResults([
        page(ids.agent, {
          Name: richTextProperty("title", "Code Reviewer"),
        }),
        page(ids.badAgent, {
          Name: richTextProperty("title", "Broken Draft"),
        }),
      ]);
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`)
      return pageResults([
        activeAgentPage(ids.childRun, "child", ids.parentRun, ids.restartRun),
      ]);
    if (request.path === `/v1/data_sources/${ids.resources}/query`)
      return pageResults([
        resourcePage(ids.prompt, "prompt/code-reviewer", "Prompt"),
        resourcePage(ids.policy, "policy/review", "Policy"),
      ]);
    if (request.path === `/v1/pages/${ids.agent}/markdown`)
      return {
        markdown: `## Agent definition

\`\`\`json
{"schema":"agent-definition-v1","enabled":true,"id":"code-reviewer","model":"gpt-5.6-sol","reasoning":"high","inputResourceSelectors":["policy/review","schema/result-v1"],"promptResources":["prompt/code-reviewer"],"transitions":{"succeeded":"In progress","blocked":"Blocked"}}
\`\`\`
`,
      };
    if (request.path === `/v1/pages/${ids.badAgent}/markdown`)
      return { markdown: "## Agent definition\n\n```json\nnot json\n```" };
    if (request.path === `/v1/pages/${ids.parentRun}`)
      return activeAgentPage(ids.parentRun, "root");
    if (request.path === `/v1/pages/${ids.restartRun}`)
      return activeAgentPage(ids.restartRun, "failed");
    if (request.path === `/v1/pages/${ids.prompt}/markdown`)
      return { markdown: "Review the code." };
    if (request.path === `/v1/pages/${ids.policy}/markdown`)
      return { markdown: "Apply review policy." };
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

function activeAgentPage(
  id: string,
  runId: string,
  parentId?: string,
  restartId?: string,
): JsonObject {
  return page(id, {
    Parent: relationProperty(parentId === undefined ? [] : [parentId]),
    "Restart Of": relationProperty(restartId === undefined ? [] : [restartId]),
    "Run ID": richTextProperty("title", runId),
  });
}

function resourcePage(id: string, key: string, kind: string): JsonObject {
  return page(id, {
    Kind: selectProperty(kind),
    Resource: richTextProperty("title", key),
    State: selectProperty("Active"),
  });
}

function page(id: string, properties: JsonObject): JsonObject {
  return {
    archived: false,
    id,
    last_edited_time: "2026-08-17T12:00:00.000Z",
    properties,
  };
}

function pageResults(results: readonly JsonObject[]): JsonObject {
  return { has_more: false, next_cursor: null, results: [...results] };
}

function richTextProperty(
  type: "rich_text" | "title",
  value: string,
): JsonObject {
  return {
    [type]: [{ plain_text: value }],
    type,
  };
}

function selectProperty(value: string): JsonObject {
  return { select: { name: value }, type: "select" };
}

function relationProperty(ids: readonly string[]): JsonObject {
  return { relation: ids.map((id) => ({ id })), type: "relation" };
}
