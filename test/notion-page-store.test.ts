// Verifies provider-owned Notion writes are uniquely addressed and post-verified.
import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/core/digest.js";
import type { JsonObject } from "../src/domain/json.js";
import { NotionPageStore } from "../src/provider/notion/notion-page-store.js";
import type { NotionRequest, NotionTransport } from "../src/provider/notion/notion-transport.js";

const TABLES = { errors: "errors", resources: "resources", subAgents: "agents", tasks: "tasks" };

class MutableTransport implements NotionTransport {
  public readonly blocks = new Map<string, JsonObject[]>();
  public readonly pages = new Map<string, JsonObject>();
  public readonly requests: NotionRequest[] = [];
  #version = 0;

  public async request(request: NotionRequest): Promise<JsonObject> {
    this.requests.push(request);
    const query = /^\/v1\/data_sources\/(\w+)\/query$/u.exec(request.path);
    if (query?.[1] !== undefined) {
      const filter = objectValue(request.body).filter;
      const filterObject = objectValue(filter);
      const property = String(filterObject.property);
      const titleEquals = objectValue(filterObject.title).equals;
      const richTextEquals = objectValue(filterObject.rich_text).equals;
      const selectEquals = objectValue(filterObject.select).equals;
      const equals = typeof titleEquals === "string" ? titleEquals : typeof richTextEquals === "string" ? richTextEquals : String(selectEquals);
      const results = [...this.pages.values()].filter((page) =>
        objectValue(page.parent).data_source_id === query[1] && propertyValue(page, property) === equals,
      );
      return { has_more: false, next_cursor: null, results };
    }
    if (request.method === "POST" && request.path === "/v1/pages") {
      const body = objectValue(request.body);
      const id = `page-${this.pages.size + 1}`;
      const page = this.newPage(id, String(objectValue(body.parent).data_source_id), objectValue(body.properties));
      this.pages.set(id, page);
      this.blocks.set(id, (body.children as JsonObject[]).map((block, index) => ({ ...block, id: `${id}-block-${index}` })));
      return page;
    }
    const pageMatch = /^\/v1\/pages\/(.+)$/u.exec(request.path);
    if (pageMatch?.[1] !== undefined) {
      const page = required(this.pages.get(pageMatch[1]));
      if (request.method === "GET") return page;
      const body = objectValue(request.body);
      const priorProperties = objectValue(page.properties);
      const updates = Object.fromEntries(
        Object.entries(objectValue(body.properties)).map(([name, value]) => {
          const update = objectValue(value);
          const prior = objectValue(priorProperties[name]);
          const type = typeof prior.type === "string" ? prior.type : Object.keys(update)[0] ?? "unknown";
          return [name, { ...prior, ...update, type }];
        }),
      );
      const next = this.newPage(pageMatch[1], String(objectValue(page.parent).data_source_id), { ...priorProperties, ...updates });
      this.pages.set(pageMatch[1], next);
      return next;
    }
    const children = /^\/v1\/blocks\/(.+)\/children$/u.exec(request.path);
    if (children?.[1] !== undefined && request.method === "GET") {
      return { has_more: false, next_cursor: null, results: this.blocks.get(children[1]) ?? [] };
    }
    if (children?.[1] !== undefined && request.method === "PATCH") {
      const existing = this.blocks.get(children[1]) ?? []; const added = (objectValue(request.body).children as JsonObject[]).map((item, index) => ({ ...item, id: `${children[1]}-block-${existing.length + index}` }));
      this.blocks.set(children[1], [...existing, ...added]);
      const page = required(this.pages.get(children[1])); this.pages.set(children[1], this.newPage(children[1], String(objectValue(page.parent).data_source_id), objectValue(page.properties)));
      return { results: added };
    }
    const block = /^\/v1\/blocks\/(.+)$/u.exec(request.path);
    if (block?.[1] !== undefined && request.method === "PATCH") {
      for (const [pageId, blocks] of this.blocks) {
        const index = blocks.findIndex((candidate) => candidate.id === block[1]);
        if (index >= 0) {
          const current = required(blocks[index]);
          blocks[index] = { ...current, ...objectValue(request.body) };
          const page = required(this.pages.get(pageId));
          this.pages.set(pageId, this.newPage(pageId, String(page.parent), objectValue(page.properties)));
          return blocks[index] ?? {};
        }
      }
    }
    throw new Error(`Unexpected ${request.method} ${request.path}`);
  }

  public seedAgent(): void {
    this.pages.set("agent-1", this.newPage("agent-1", "agents", {
      Status: { id: "status", select: { name: "Offline" }, type: "select" },
      "Working On": { id: "work", relation: [], type: "relation" },
    }));
  }

  public seedTask(): void {
    this.pages.set("task-1", this.newPage("task-1", "tasks", {
      "Manager Mutation": { id: "manager-mutation", rich_text: [], type: "rich_text" },
      Status: { id: "status", select: { name: "Todo" }, type: "select" },
      Task: { id: "title", title: [{ text: { content: "Task" }, type: "text" }], type: "title" },
    }));
    this.blocks.set("task-1", []);
  }

  private newPage(id: string, parent: string, properties: JsonObject): JsonObject {
    this.#version += 1;
    const normalized = Object.fromEntries(Object.entries(properties).map(([name, value]) => {
      const property = objectValue(value);
      return [name, property.type === undefined ? { ...property, type: Object.keys(property)[0] ?? "unknown" } : property];
    }));
    return { id, last_edited_time: `2026-01-01T00:00:${String(this.#version).padStart(2, "0")}.000Z`, object: "page", parent: { data_source_id: parent, type: "data_source_id" }, properties: normalized };
  }
}

test("creates one managed Resource row and verifies its content", async () => {
  const transport = new MutableTransport();
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  const receipt = await store.createResource({
    body: "prompt body",
    dependencies: [],
    digest: sha256("prompt body"),
    idempotencyKey: "write-1",
    key: "prompt/example",
    kind: "prompt",
    state: "active",
    version: "v1",
  });
  assert.equal(receipt.providerRecord.table, "resources");
  assert.equal(await store.managedText(receipt.providerRecord.id, "Resource body"), "prompt body");
  assert.equal(transport.pages.size, 1);
});

test("conditionally updates Status and Working On", async () => {
  const transport = new MutableTransport();
  transport.seedAgent();
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  const receipt = await store.updateSubAgentActivity({
    expectedRunLeaseIds: [],
    expectedTaskIds: [],
    idempotencyKey: "activity-1",
    nextRunLeaseIds: ["lease-1"],
    nextTaskIds: ["task-1"],
    subAgentId: "agent-1",
  });
  assert.equal(receipt.providerRecord.id, "agent-1");
  assert.equal((await store.getSubAgentActivity("agent-1")).status, "Online");
  await assert.rejects(
    store.updateSubAgentActivity({
      expectedRunLeaseIds: [],
      expectedTaskIds: [],
      idempotencyKey: "activity-2",
      nextRunLeaseIds: [],
      nextTaskIds: [],
      subAgentId: "agent-1",
    }),
    /Working On conflict/u,
  );
});

test("uses one canonical Status value for Task mutation and verification", async () => {
  const transport = new MutableTransport(); transport.seedTask();
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  await store.applyTaskMutation({ expectedVersion: "2026-01-01T00:00:01.000Z", idempotencyKey: "task-status", nextBody: null, nextProperties: { Status: "Todo" }, nextStatus: "Coding", taskId: "task-1" });
  const page = transport.pages.get("task-1");
  assert.equal(propertyValue(required(page), "Status"), "Coding");
  assert.match(propertyValue(required(page), "Manager Mutation"), /^[a-f0-9]{64}$/u);
});

test("recognizes the exact Error target after an interrupted intent", async () => {
  const transport = new MutableTransport(); const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  const error = { description: "Failure details", errorKey: "failure/stable", idempotencyKey: "error-write", relatedRunId: "run-1", relatedSubAgentId: null, relatedTaskId: null, resolution: "Repair the environment.", severity: "high" as const, status: "Not Fixed" as const, title: "Stable failure" };
  const created = await store.createOrUpdateError(error);
  assert.deepEqual(await store.errorTargetReceipt(error), created);
  assert.equal(propertyValue(required(transport.pages.get(created.providerRecord.id)), "Status"), "Not Fixed");
  await assert.rejects(store.errorTargetReceipt({ ...error, description: "Different details" }), /conflicts with newer state/u);
});

function propertyValue(page: JsonObject, name: string): string {
  const property = objectValue(objectValue(page.properties)[name]);
  const values = property.title ?? property.rich_text;
  if (Array.isArray(values)) {
    return values.map((item) => String(objectValue(objectValue(item).text).content)).join("");
  }
  return String(objectValue(property.select).name ?? "");
}

function objectValue(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture value missing");
  return value;
}
