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
      const selectEquals = objectValue(filterObject.select).equals;
      const equals = typeof titleEquals === "string" ? titleEquals : String(selectEquals);
      const results = [...this.pages.values()].filter((page) =>
        page.parent === query[1] && propertyValue(page, property) === equals,
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
      const next = this.newPage(pageMatch[1], String(page.parent), { ...priorProperties, ...updates });
      this.pages.set(pageMatch[1], next);
      return next;
    }
    const children = /^\/v1\/blocks\/(.+)\/children$/u.exec(request.path);
    if (children?.[1] !== undefined && request.method === "GET") {
      return { has_more: false, next_cursor: null, results: this.blocks.get(children[1]) ?? [] };
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

  private newPage(id: string, parent: string, properties: JsonObject): JsonObject {
    this.#version += 1;
    return { id, last_edited_time: `2026-01-01T00:00:${String(this.#version).padStart(2, "0")}.000Z`, object: "page", parent, properties };
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

function propertyValue(page: JsonObject, name: string): string {
  const property = objectValue(objectValue(page.properties)[name]);
  const values = property.title;
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
