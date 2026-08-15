// Verifies Resource-backed intent and lease state across provider object restarts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { sha256 } from "../src/core/digest.js";
import type { JsonObject } from "../src/domain/json.js";
import type { ProviderEnvironment } from "../src/domain/provider.js";
import type { ResourceMutation } from "../src/domain/records.js";
import { NotionPageStore } from "../src/provider/notion/notion-page-store.js";
import { NotionProvider } from "../src/provider/notion/notion-provider.js";
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

test("repairs a pending Notion Resource intent from its exact target state", async () => {
  const transport = new ResourceTransport(); const now = () => new Date("2026-01-01T00:00:00.000Z");
  const pages = new NotionPageStore(TABLES, transport, now); const state = new NotionStateStore(pages, new SingleHostMutex(`state-${randomUUID()}`), now);
  const body = '{"schema":"test-resource-v1"}';
  const record: ResourceMutation = { body, dependencies: [], digest: sha256(body), idempotencyKey: "resource-interrupted", key: "test/recovered", kind: "test", state: "active", version: "v1" };
  await state.beginIntent(record.idempotencyKey, "resource", record);
  const provider = new NotionProvider({ environment: notionEnvironment(), environmentId: `recovery-${randomUUID()}`, now, transport });
  await provider.putResource(record);
  assert.deepEqual(await provider.getOptionalResource(record.key), { body, dependencies: [], digest: record.digest, key: record.key, kind: record.kind, state: record.state, version: record.version });
  assert.equal((await provider.reconcileIntent(record.idempotencyKey)).state, "applied");
});

test("does not repair an old pending Resource intent over newer state", async () => {
  const transport = new ResourceTransport(); const now = () => new Date("2026-01-01T00:00:00.000Z");
  const pages = new NotionPageStore(TABLES, transport, now); const state = new NotionStateStore(pages, new SingleHostMutex(`state-${randomUUID()}`), now);
  const oldBody = '{"revision":1}'; const newerBody = '{"revision":2}';
  const old: ResourceMutation = { body: oldBody, dependencies: [], digest: sha256(oldBody), idempotencyKey: "resource-old", key: "test/conflict", kind: "test", state: "active", version: "v1" };
  const newer: ResourceMutation = { ...old, body: newerBody, digest: sha256(newerBody), idempotencyKey: "resource-newer", version: "v2" };
  await state.beginIntent(old.idempotencyKey, "resource", old); await pages.createResource(newer);
  const provider = new NotionProvider({ environment: notionEnvironment(), environmentId: `recovery-${randomUUID()}`, now, transport });
  await assert.rejects(provider.putResource(old), /conflicts with newer state/);
  assert.equal((await provider.getOptionalResource(old.key))?.digest, newer.digest);
});

test("repairs a pending Notion Error intent from its exact target state", async () => {
  const transport = new ResourceTransport(); const now = () => new Date("2026-01-01T00:00:00.000Z");
  const pages = new NotionPageStore(TABLES, transport, now); const state = new NotionStateStore(pages, new SingleHostMutex(`state-${randomUUID()}`), now);
  const error = { description: "Publication is unavailable.", errorKey: "publication/missing", idempotencyKey: "error-interrupted", relatedRunId: "run-1", relatedSubAgentId: null, relatedTaskId: null, resolution: "Configure publication.", severity: "high" as const, title: "Publication unavailable" };
  await state.beginIntent(error.idempotencyKey, "error", error); await pages.createOrUpdateError(error);
  const provider = new NotionProvider({ environment: notionEnvironment(), environmentId: `recovery-${randomUUID()}`, now, transport });
  assert.equal((await provider.createOrUpdateError(error)).providerRecord.table, "errors");
  assert.equal((await provider.reconcileIntent(error.idempotencyKey)).state, "applied");
});

class ResourceTransport implements NotionTransport {
  readonly #blocks = new Map<string, JsonObject[]>();
  readonly #pages = new Map<string, JsonObject>();
  #clock = 0;

  public async request(request: NotionRequest): Promise<JsonObject> {
    const dataSource = /^\/v1\/data_sources\/([^/]+)$/u.exec(request.path);
    if (request.method === "GET" && dataSource?.[1] !== undefined) return { id: dataSource[1], object: "data_source" };
    if (/^\/v1\/data_sources\/[^/]+\/query$/u.test(request.path)) {
      const filter = objectValue(objectValue(request.body).filter);
      const property = String(filter.property);
      const expected = String(objectValue(filter.title).equals ?? objectValue(filter.rich_text).equals ?? objectValue(filter.select).equals);
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
    const normalized = Object.fromEntries(Object.entries(properties).map(([name, value]) => { const property = objectValue(value); return [name, property.type === undefined ? { ...property, type: Object.keys(property)[0] ?? "unknown" } : property]; }));
    return { id, last_edited_time: `2026-01-01T00:00:${String(this.#clock).padStart(2, "0")}.000Z`, object: "page", properties: normalized };
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
  const values = property.title ?? property.rich_text;
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

function notionEnvironment(): ProviderEnvironment {
  return { bootstrapParent: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", connection: { authEnvironmentVariable: "NOTION_TOKEN" }, tables: { errors: "11111111-1111-1111-1111-111111111111", resources: "22222222-2222-2222-2222-222222222222", subAgents: "33333333-3333-3333-3333-333333333333", tasks: "44444444-4444-4444-4444-444444444444" }, type: "notion" };
}
