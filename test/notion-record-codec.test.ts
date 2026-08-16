/** Exercises exhaustive Notion row decoding and closed managed-content contracts. */
import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/core/digest.js";
import type { JsonObject } from "../src/domain/json.js";
import { NotionRecordReader } from "../src/provider/notion/notion-record-codec.js";
import type {
  NotionRequest,
  NotionTransport,
} from "../src/provider/notion/notion-transport.js";

/** Maps logical tables to stable fake provider identifiers. */
const TABLES = {
  errors: "errors",
  resources: "resources",
  agents: "agents",
  tasks: "tasks",
};

/** Implements records transport. */
class RecordsTransport implements NotionTransport {
  /** Status returned for both prerequisite Task pages. */
  public dependencyStatus = "Done";

  /** Most recent Tasks query observed by the transport fixture. */
  public lastTaskQuery: NotionRequest | null = null;

  /** Executes one provider request. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === "/v1/data_sources/tasks/query") {
      this.lastTaskQuery = request;
      return { has_more: false, next_cursor: null, results: [taskPage()] };
    }
    if (request.path === "/v1/data_sources/agents/query") {
      return { has_more: false, next_cursor: null, results: [agentPage()] };
    }
    if (request.path === "/v1/data_sources/resources/query") {
      return { has_more: false, next_cursor: null, results: [resourcePage()] };
    }
    if (request.path === "/v1/pages/task-1") return taskPage();
    if (request.path === "/v1/pages/dep-1")
      return dependencyPage("dep-1", this.dependencyStatus);
    if (request.path === "/v1/pages/dep-2")
      return dependencyPage("dep-2", this.dependencyStatus);
    if (request.path === "/v1/pages/outside-task")
      return {
        ...taskPage(),
        id: "outside-task",
        parent: { data_source_id: "other" },
      };
    if (request.path === "/v1/pages/agent-1") return agentPage();
    if (request.path === "/v1/pages/task-1/properties/blocked") {
      return request.query?.start_cursor === null
        ? {
            has_more: true,
            next_cursor: "two",
            results: [{ relation: { id: "dep-1" } }],
          }
        : {
            has_more: false,
            next_cursor: null,
            results: [{ relation: { id: "dep-2" } }],
          };
    }
    if (request.path === "/v1/blocks/task-1/children")
      return blocks([{ paragraph: rich("Task details"), type: "paragraph" }]);
    if (request.path === "/v1/blocks/agent-1/children")
      return blocks(managed("Agent definition", JSON.stringify(definition())));
    if (request.path === "/v1/pages/resource-1/markdown") {
      return {
        markdown: "## Resource body\nresource text\nSecond paragraph",
        object: "page_markdown",
        truncated: false,
        unknown_block_ids: [],
      };
    }
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  }
}

test("decodes task summaries and exhausts relation property pagination", async () => {
  /** Reads provider records through the fake Notion transport. */
  const reader = new NotionRecordReader(TABLES, new RecordsTransport());
  /** Collects decoded Task summaries returned by the provider. */
  const summaries = await reader.listTaskSummaries({
    cursor: null,
    dependencySatisfiedStatuses: ["Done"],
    limit: 10,
    predicate: { status: "Todo" },
  });
  assert.equal(summaries.length, 1);
  /** Represents the Task state exercised by the scenario. */
  const task = await reader.getTaskSnapshot("task-1");
  assert.deepEqual(task.dependencies, ["dep-1", "dep-2"]);
  assert.equal(task.body, "Task details");
  await assert.rejects(
    reader.getTaskSnapshot("outside-task"),
    /configured table/,
  );
});

test("translates a multi-status Task query into a bounded Notion filter", async () => {
  /** Captures the exact Notion request produced by the reader. */
  const transport = new RecordsTransport();
  /** Reads Task summaries through the capturing transport. */
  const reader = new NotionRecordReader(TABLES, transport);

  /** Collects decoded summaries for the translated multi-status query. */
  const summaries = await reader.listTaskSummaries({
    cursor: null,
    dependencySatisfiedStatuses: ["Done"],
    limit: 10,
    predicate: { status: ["Todo", "Ready"] },
  });

  assert.equal(summaries.length, 1);
  /** Contains the JSON request body sent to Notion. */
  const requestBody = transport.lastTaskQuery?.body as JsonObject | undefined;
  assert.deepEqual(requestBody?.filter, {
    or: [
      { property: "Status", select: { equals: "Todo" } },
      { property: "Status", select: { equals: "Ready" } },
    ],
  });
});

test("excludes Task candidates with unresolved dependencies", async () => {
  /** Transport whose prerequisite Tasks are not in an accepted status. */
  const transport = new RecordsTransport();
  transport.dependencyStatus = "Ready";
  /** Reader applying the provider-neutral dependency policy before pagination. */
  const reader = new NotionRecordReader(TABLES, transport);

  /** Candidate page filtered out because its prerequisites remain Ready. */
  const summaries = await reader.listTaskSummaries({
    cursor: null,
    dependencySatisfiedStatuses: ["Done"],
    limit: 10,
    predicate: { status: "Todo" },
  });

  assert.deepEqual(summaries, []);
});

test("loads strict Agent definitions from their managed range", async () => {
  /** Reads provider records through the fake Notion transport. */
  const reader = new NotionRecordReader(TABLES, new RecordsTransport());
  /** Captures the decoded Agent record used as the oracle. */
  const [agent] = await reader.listAgentDefinitions();
  assert.equal(agent?.name, "Coordinator");
  assert.equal(agent?.selection.mode, "coordinator");
  assert.deepEqual(agent?.promptResources, ["prompt/coordinator"]);
  assert.equal(
    (await reader.getAgentDefinition("coordinator")).id,
    "coordinator",
  );
  assert.equal(await reader.getAgentPageId("coordinator"), "agent-1");
});

test("verifies Resources against their content digest", async () => {
  /** Reads provider records through the fake Notion transport. */
  const reader = new NotionRecordReader(TABLES, new RecordsTransport());
  /** Captures the Resource read model used as the oracle. */
  const [resource] = await reader.getResources([
    {
      digest: sha256("resource text\nSecond paragraph"),
      key: "prompt/coordinator",
      version: "v1",
    },
  ]);
  assert.equal(resource?.body, "resource text\nSecond paragraph");
});

/** Builds page. */
function taskPage(): JsonObject {
  return {
    archived: false,
    id: "task-1",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    object: "page",
    parent: { data_source_id: "tasks", type: "data_source_id" },
    properties: {
      Dependencies: {
        has_more: true,
        id: "blocked",
        relation: [{ id: "dep-inline" }],
        type: "relation",
      },
      Priority: { id: "priority", number: 1, type: "number" },
      Status: { id: "status", status: { name: "Todo" }, type: "status" },
      Task: {
        id: "title",
        title: [{ plain_text: "First task" }],
        type: "title",
      },
    },
  };
}

/** Builds a dependency Task with the status used by candidate filtering. */
function dependencyPage(id: string, status: string): JsonObject {
  return {
    archived: false,
    id,
    last_edited_time: "2026-01-01T00:00:00.000Z",
    object: "page",
    parent: { data_source_id: "tasks", type: "data_source_id" },
    properties: {
      Dependencies: {
        has_more: false,
        id: "dependencies",
        relation: [],
        type: "relation",
      },
      Priority: { id: "priority", number: 1, type: "number" },
      Status: { id: "status", status: { name: status }, type: "status" },
      Task: {
        id: "title",
        title: [{ plain_text: `Dependency ${id}` }],
        type: "title",
      },
    },
  };
}

/** Builds a fake Notion page containing a managed Agent definition. */
function agentPage(): JsonObject {
  return {
    id: "agent-1",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    object: "page",
    parent: { data_source_id: "agents", type: "data_source_id" },
    properties: {
      Enabled: { checkbox: true, id: "enabled", type: "checkbox" },
      Model: {
        id: "model",
        rich_text: [{ plain_text: "gpt-5.6-sol" }],
        type: "rich_text",
      },
      Name: {
        id: "title",
        title: [{ plain_text: "Coordinator" }],
        type: "title",
      },
      Revision: { id: "revision", number: 1, type: "number" },
    },
  };
}

/** Builds page. */
function resourcePage(): JsonObject {
  return {
    id: "resource-1",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    object: "page",
    properties: {
      Dependencies: { id: "dependencies", rich_text: [], type: "rich_text" },
      Digest: {
        id: "digest",
        rich_text: [{ plain_text: sha256("resource text\nSecond paragraph") }],
        type: "rich_text",
      },
      Kind: { id: "kind", select: { name: "Policy" }, type: "select" },
      Resource: {
        id: "title",
        title: [{ plain_text: "prompt/coordinator" }],
        type: "title",
      },
      State: { id: "state", select: { name: "Active" }, type: "select" },
      Version: {
        id: "version",
        rich_text: [{ plain_text: "v1" }],
        type: "rich_text",
      },
    },
  };
}

/** Creates an Agent definition fixture. */
function definition(): JsonObject {
  return {
    allowedIntents: ["task.update"],
    capabilities: ["dispatch.coordinate"],
    maxConcurrency: 1,
    maxAssignmentsPerRun: 1,
    contextBudgetBytes: 100000,
    deadlineSeconds: 300,
    enabled: true,
    humanResolutionOutcomes: [],
    id: "coordinator",
    inputResourceSelectors: [],
    invocation: { mode: "manual", scheduleResource: null },
    priority: 1,
    maxAssignmentDepth: 2,
    model: "gpt-5.6-sol",
    name: "Coordinator",
    promptResources: ["prompt/coordinator"],
    prohibitedCapabilities: [],
    reasoning: "medium",
    requiredProviderCapabilities: [],
    revision: 1,
    retry: { maxAttempts: 1, noVerdict: "block" },
    runnerProfile: "default",
    schema: "agent-definition-v1",
    selection: {
      acceptsAssignmentsFrom: ["coordinator"],
      maxCandidateSummaries: 10,
      mode: "coordinator",
      resultSchema: "schema/result",
      taskQueryResource: "query/coordinator",
    },
    transitions: { succeeded: "Done" },
    outputSchema: "schema/work",
  };
}

/** Wraps managed blocks in a Notion list response. */
function blocks(results: JsonObject[]): JsonObject {
  return { has_more: false, next_cursor: null, results };
}

/** Builds a simulated managed heading and code-block section. */
function managed(heading: string, body: string): JsonObject[] {
  return [
    { heading_2: rich(heading), id: "heading", type: "heading_2" },
    { code: { ...rich(body), language: "json" }, id: "code", type: "code" },
  ];
}

/** Converts rich. */
function rich(value: string): JsonObject {
  return { rich_text: [{ plain_text: value }] };
}
