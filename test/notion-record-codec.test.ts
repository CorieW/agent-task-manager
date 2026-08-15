// Exercises exhaustive Notion row decoding and closed managed-content contracts.
import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/core/digest.js";
import type { JsonObject } from "../src/domain/json.js";
import { NotionRecordReader } from "../src/provider/notion/notion-record-codec.js";
import type { NotionRequest, NotionTransport } from "../src/provider/notion/notion-transport.js";

const TABLES = { errors: "errors", resources: "resources", subAgents: "agents", tasks: "tasks" };

class RecordsTransport implements NotionTransport {
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === "/v1/data_sources/tasks/query") {
      return { has_more: false, next_cursor: null, results: [taskPage()] };
    }
    if (request.path === "/v1/data_sources/agents/query") {
      return { has_more: false, next_cursor: null, results: [agentPage()] };
    }
    if (request.path === "/v1/data_sources/resources/query") {
      return { has_more: false, next_cursor: null, results: [resourcePage()] };
    }
    if (request.path === "/v1/pages/task-1") return taskPage();
    if (request.path === "/v1/pages/outside-task") return { ...taskPage(), id: "outside-task", parent: { data_source_id: "other" } };
    if (request.path === "/v1/pages/agent-1") return agentPage();
    if (request.path === "/v1/pages/task-1/properties/blocked") {
      return request.query?.start_cursor === null
        ? { has_more: true, next_cursor: "two", results: [{ relation: { id: "dep-1" } }] }
        : { has_more: false, next_cursor: null, results: [{ relation: { id: "dep-2" } }] };
    }
    if (request.path === "/v1/blocks/task-1/children") return blocks([{ paragraph: rich("Task details"), type: "paragraph" }]);
    if (request.path === "/v1/blocks/agent-1/children") return blocks(managed("Sub-agent definition", JSON.stringify(definition())));
    if (request.path === "/v1/blocks/resource-1/children") return blocks(managed("Resource body", "resource text"));
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  }
}

test("decodes task summaries and exhausts relation property pagination", async () => {
  const reader = new NotionRecordReader(TABLES, new RecordsTransport());
  const summaries = await reader.listTaskSummaries({ cursor: null, limit: 10, predicate: { status: "Todo" } });
  assert.equal(summaries.length, 1);
  const task = await reader.getTaskSnapshot("task-1");
  assert.deepEqual(task.dependencies, ["dep-1", "dep-2"]);
  assert.equal(task.body, "Task details");
  await assert.rejects(reader.getTaskSnapshot("outside-task"), /configured table/);
});

test("loads strict Sub-agent definitions from their managed range", async () => {
  const reader = new NotionRecordReader(TABLES, new RecordsTransport());
  const [agent] = await reader.listSubAgentDefinitions();
  assert.equal(agent?.name, "Coordinator");
  assert.equal(agent?.selection.mode, "coordinator");
  assert.deepEqual(agent?.promptResources, ["prompt/coordinator"]);
  assert.equal((await reader.getSubAgentDefinition("coordinator")).id, "coordinator");
  assert.equal(await reader.getSubAgentPageId("coordinator"), "agent-1");
});

test("verifies Resources against their content digest", async () => {
  const reader = new NotionRecordReader(TABLES, new RecordsTransport());
  const [resource] = await reader.getResources([{ digest: sha256("resource text"), key: "prompt/coordinator", version: "v1" }]);
  assert.equal(resource?.body, "resource text");
});

function taskPage(): JsonObject {
  return {
    archived: false,
    id: "task-1",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    object: "page",
    parent: { data_source_id: "tasks", type: "data_source_id" },
    properties: {
      "Blocked By": { has_more: true, id: "blocked", relation: [{ id: "dep-inline" }], type: "relation" },
      Priority: { id: "priority", number: 1, type: "number" },
      Status: { id: "status", status: { name: "Todo" }, type: "status" },
      Task: { id: "title", title: [{ plain_text: "First task" }], type: "title" },
    },
  };
}

function agentPage(): JsonObject {
  return {
    id: "agent-1",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    object: "page",
    parent: { data_source_id: "agents", type: "data_source_id" },
    properties: {
      Enabled: { checkbox: true, id: "enabled", type: "checkbox" },
      Model: { id: "model", rich_text: [{ plain_text: "gpt-5.6-sol" }], type: "rich_text" },
      Name: { id: "title", title: [{ plain_text: "Coordinator" }], type: "title" },
      Revision: { id: "revision", number: 1, type: "number" },
    },
  };
}

function resourcePage(): JsonObject {
  return {
    id: "resource-1",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    object: "page",
    properties: {
      Dependencies: { id: "dependencies", rich_text: [], type: "rich_text" },
      Digest: { id: "digest", rich_text: [{ plain_text: sha256("resource text") }], type: "rich_text" },
      Kind: { id: "kind", select: { name: "prompt" }, type: "select" },
      Resource: { id: "title", title: [{ plain_text: "prompt/coordinator" }], type: "title" },
      State: { id: "state", select: { name: "active" }, type: "select" },
      Version: { id: "version", rich_text: [{ plain_text: "v1" }], type: "rich_text" },
    },
  };
}

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
    schema: "sub-agent-definition-v1",
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

function blocks(results: JsonObject[]): JsonObject {
  return { has_more: false, next_cursor: null, results };
}

function managed(heading: string, body: string): JsonObject[] {
  return [
    { heading_2: rich(heading), id: "heading", type: "heading_2" },
    { code: { ...rich(body), language: "json" }, id: "code", type: "code" },
  ];
}

function rich(value: string): JsonObject {
  return { rich_text: [{ plain_text: value }] };
}
