/** Notion Agent-body loading, semantic validation, and relation coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "../src/domain/json.js";
import type { TableKind } from "../src/domain/provider.js";
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

test("Notion Agent record lookup isolates unrelated malformed bodies", async () => {
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

  assert.equal((await provider.getAgent(ids.agent))?.key, "code-reviewer");
  await assert.rejects(provider.getAgent(ids.badAgent), TypeError);
  assert.equal(
    await provider.getAgent("88888888888888888888888888888888"),
    null,
  );
});

test("Notion Agent loading retries a body and metadata torn read", async () => {
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
    new TornAgentBodyTransport(),
  );

  const agent = await provider.getAgentByKey("code-reviewer");
  assert.match(agent?.version ?? "", /^[0-9a-f]{64}$/u);
  assert.deepEqual(agent?.compatibleVersions, ["2026-08-17T13:00:00.000Z"]);
});

test("Notion Agent versions bind same-timestamp command policy changes", async () => {
  const transport = new SameTimestampAgentBodyTransport();
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
    transport,
  );

  const restricted = await provider.getAgentByKey("code-reviewer");
  transport.permissive = true;
  const permissive = await provider.getAgentByKey("code-reviewer");

  assert.notEqual(restricted?.version, permissive?.version);
  assert.deepEqual(restricted?.commands, { inclusion: ["git"] });
  assert.deepEqual(permissive?.commands, { exclusion: [] });
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

test("workspace planning rejects property types found invalid by validation", async () => {
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
    new AgentBodyTransport({
      name: "Status",
      table: "tasks",
      type: "rich_text",
    }),
  );

  const report = await provider.validateWorkspace();
  assert.ok(
    report.issues.some(
      (entry) =>
        entry.code === "property_type" && entry.path === "Tasks.Status",
    ),
  );
  await assert.rejects(
    provider.planWorkspace("management-v2"),
    /Cannot plan incompatible property Tasks\.Status/u,
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
  public constructor(
    private readonly propertyOverride?: {
      readonly name: string;
      readonly table: TableKind;
      readonly type: string;
    },
  ) {}

  public async request(request: NotionRequest): Promise<JsonObject> {
    if (
      request.method === "GET" &&
      request.path.startsWith("/v1/data_sources/")
    ) {
      const sourceId = request.path.split("/").at(-1);
      const table = NOTION_TABLES.find((entry) => ids[entry.kind] === sourceId);
      if (table !== undefined) {
        const properties: JsonObject = Object.fromEntries(
          table.properties.map((property) => [
            property.name,
            { type: property.type },
          ]),
        );
        if (this.propertyOverride?.table === table.kind)
          properties[this.propertyOverride.name] = {
            type: this.propertyOverride.type,
          };
        return { properties };
      }
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
      return { markdown: agentMarkdown('{"exclusion":[]}') };
    if (request.path === `/v1/pages/${ids.agent}`)
      return page(ids.agent, {
        Name: richTextProperty("title", "Code Reviewer"),
      });
    if (request.path === `/v1/pages/${ids.badAgent}/markdown`)
      return { markdown: "## Agent definition\n\n```json\nnot json\n```" };
    if (request.path === `/v1/pages/${ids.badAgent}`)
      return page(ids.badAgent, {
        Name: richTextProperty("title", "Broken Draft"),
      });
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

class TornAgentBodyTransport extends AgentBodyTransport {
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/pages/${ids.agent}`)
      return {
        ...page(ids.agent, {
          Name: richTextProperty("title", "Code Reviewer"),
        }),
        last_edited_time: "2026-08-17T13:00:00.000Z",
      };
    return super.request(request);
  }
}

class SameTimestampAgentBodyTransport extends AgentBodyTransport {
  public permissive = false;

  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/pages/${ids.agent}/markdown`)
      return {
        markdown: agentMarkdown(
          this.permissive ? '{"exclusion":[]}' : '{"inclusion":["git"]}',
        ),
      };
    return super.request(request);
  }
}

function agentMarkdown(commands: string): string {
  return `## Agent definition

\`\`\`json
{"schema":"agent-definition-v2","enabled":true,"commands":${commands},"id":"code-reviewer","model":"gpt-5.6-sol","reasoning":"high","inputResourceSelectors":["policy/review","schema/result-v1"],"promptResources":["prompt/code-reviewer"],"transitions":{"succeeded":"In progress","blocked":"Blocked"}}
\`\`\`
`;
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
