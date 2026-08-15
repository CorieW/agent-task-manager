// Verifies Resource-backed intent and lease state across provider object restarts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { JsonObject } from "../src/domain/json.js";
import { NotionPageStore } from "../src/provider/notion/notion-page-store.js";
import { NotionStateStore } from "../src/provider/notion/notion-state-store.js";
import type { NotionRequest, NotionTransport } from "../src/provider/notion/notion-transport.js";
import { SingleHostMutex } from "../src/provider/notion/single-host-mutex.js";

const TABLES = { errors: "errors", resources: "resources", subAgents: "agents", tasks: "tasks" };

test("persists replayable leases and restart-visible intent outcomes", async () => {
  const transport = new ResourceTransport();
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const pages = new NotionPageStore(TABLES, transport, now);
  const first = new NotionStateStore(pages, new SingleHostMutex(`state-${randomUUID()}`), now);
  const request = {
    expiresAt: "2026-01-01T01:00:00.000Z",
    idempotencyKey: "acquire-one",
    ownerId: "run-1",
    scope: "agent_run" as const,
    subAgentId: "agent-1",
    taskId: null,
  };
  const acquired = await first.acquireLease(request);
  assert.equal(acquired.acquired, true);

  const restarted = new NotionStateStore(pages, new SingleHostMutex(`state-${randomUUID()}`), now);
  assert.deepEqual(await restarted.acquireLease(request), acquired);
  assert.deepEqual(await restarted.activeLeaseIds("agent_run", "agent-1"), [acquired.leaseId]);
  assert.equal((await restarted.reconcileIntent("acquire-one")).state, "applied");

  const concurrent = await restarted.acquireLease({ ...request, idempotencyKey: "acquire-two", ownerId: "run-2" });
  assert.equal(concurrent.acquired, true);
  assert.deepEqual(await restarted.activeLeaseIds("agent_run", "agent-1"), [acquired.leaseId, concurrent.leaseId].sort());
  assert.equal((await restarted.reconcileIntent("acquire-two")).state, "applied");
});

class ResourceTransport implements NotionTransport {
  readonly #blocks = new Map<string, JsonObject[]>();
  readonly #pages = new Map<string, JsonObject>();
  #clock = 0;

  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === "/v1/data_sources/resources/query") {
      const filter = objectValue(objectValue(request.body).filter);
      const property = String(filter.property);
      const expected = String(objectValue(filter.title).equals ?? objectValue(filter.select).equals);
      const results = [...this.#pages.values()].filter((page) => propertyValue(page, property) === expected);
      return { has_more: false, next_cursor: null, results };
    }
    if (request.method === "POST" && request.path === "/v1/pages") {
      const body = objectValue(request.body);
      const id = `resource-${this.#pages.size + 1}`;
      const page = this.page(id, objectValue(body.properties));
      this.#pages.set(id, page);
      this.#blocks.set(id, (body.children as JsonObject[]).map((block, index) => ({ ...block, id: `${id}-${index}` })));
      return page;
    }
    const pageMatch = /^\/v1\/pages\/(.+)$/u.exec(request.path);
    if (pageMatch?.[1] !== undefined) {
      const current = required(this.#pages.get(pageMatch[1]));
      if (request.method === "GET") return current;
      const body = objectValue(request.body);
      const next = this.page(pageMatch[1], mergeProperties(objectValue(current.properties), objectValue(body.properties)));
      this.#pages.set(pageMatch[1], next);
      return next;
    }
    const children = /^\/v1\/blocks\/(.+)\/children$/u.exec(request.path);
    if (children?.[1] !== undefined && request.method === "GET") {
      return { has_more: false, next_cursor: null, results: this.#blocks.get(children[1]) ?? [] };
    }
    const block = /^\/v1\/blocks\/(.+)$/u.exec(request.path);
    if (block?.[1] !== undefined && request.method === "PATCH") {
      for (const [pageId, blocks] of this.#blocks) {
        const index = blocks.findIndex((candidate) => candidate.id === block[1]);
        if (index >= 0) {
          blocks[index] = { ...required(blocks[index]), ...objectValue(request.body) };
          const current = required(this.#pages.get(pageId));
          this.#pages.set(pageId, this.page(pageId, objectValue(current.properties)));
          return required(blocks[index]);
        }
      }
    }
    throw new Error(`Unexpected ${request.method} ${request.path}`);
  }

  private page(id: string, properties: JsonObject): JsonObject {
    this.#clock += 1;
    return { id, last_edited_time: `2026-01-01T00:00:${String(this.#clock).padStart(2, "0")}.000Z`, object: "page", properties };
  }
}

function mergeProperties(prior: JsonObject, updates: JsonObject): JsonObject {
  return {
    ...prior,
    ...Object.fromEntries(Object.entries(updates).map(([name, value]) => {
      const before = objectValue(prior[name]);
      const after = objectValue(value);
      return [name, { ...before, ...after, type: before.type ?? Object.keys(after)[0] ?? "unknown" }];
    })),
  };
}

function propertyValue(page: JsonObject, name: string): string {
  const property = objectValue(objectValue(page.properties)[name]);
  const values = property.title;
  if (Array.isArray(values)) return values.map((item) => String(objectValue(objectValue(item).text).content)).join("");
  return String(objectValue(property.select).name ?? "");
}

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture value missing");
  return value;
}
