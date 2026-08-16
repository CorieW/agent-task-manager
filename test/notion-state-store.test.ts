/** Verifies Resource-backed intent and lease state across provider object restarts. */
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
import type {
  NotionRequest,
  NotionTransport,
} from "../src/provider/notion/notion-transport.js";
import { SingleHostMutex } from "../src/provider/notion/single-host-mutex.js";

/** Defines the shared tables fixture for this test module. */
const TABLES = {
  errors: "errors",
  resources: "resources",
  agents: "agents",
  tasks: "tasks",
};
/** Defines the shared Notion tables fixture for this test module. */
const NOTION_TABLES = {
  errors: "11111111-1111-1111-1111-111111111111",
  resources: "22222222-2222-2222-2222-222222222222",
  agents: "33333333-3333-3333-3333-333333333333",
  tasks: "44444444-4444-4444-4444-444444444444",
};

test("persists replayable leases and restart-visible intent outcomes", async () => {
  /** Defines the transport fixture for “persists replayable leases and restart-visible intent outcomes”. */
  const transport = new ResourceTransport();
  /** Defines the now fixture for “persists replayable leases and restart-visible intent outcomes”. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Defines the pages fixture for “persists replayable leases and restart-visible intent outcomes”. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Defines the first fixture for “persists replayable leases and restart-visible intent outcomes”. */
  const first = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Defines the request fixture for “persists replayable leases and restart-visible intent outcomes”. */
  const request = {
    expiresAt: "2026-01-01T01:00:00.000Z",
    idempotencyKey: "acquire-one",
    ownerId: "run-1",
    scope: "agent_run" as const,
    agentId: "agent-1",
    taskId: null,
  };
  /** Defines the acquired fixture for “persists replayable leases and restart-visible intent outcomes”. */
  const acquired = await first.acquireLease(request);
  assert.equal(acquired.acquired, true);

  /** Defines the restarted fixture for “persists replayable leases and restart-visible intent outcomes”. */
  const restarted = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  assert.deepEqual(await restarted.acquireLease(request), acquired);
  assert.deepEqual(await restarted.activeLeaseIds("agent_run", "agent-1"), [
    acquired.leaseId,
  ]);
  assert.equal(
    (await restarted.reconcileIntent("acquire-one")).state,
    "applied",
  );

  /** Defines the concurrent fixture for “persists replayable leases and restart-visible intent outcomes”. */
  const concurrent = await restarted.acquireLease({
    ...request,
    idempotencyKey: "acquire-two",
    ownerId: "run-2",
  });
  assert.equal(concurrent.acquired, true);
  assert.deepEqual(
    await restarted.activeLeaseIds("agent_run", "agent-1"),
    [acquired.leaseId, concurrent.leaseId].sort(),
  );
  assert.equal(
    (await restarted.reconcileIntent("acquire-two")).state,
    "applied",
  );
});

test("does not strand stale lease release preconditions in a pending intent", async () => {
  /** Defines the current fixture for “does not strand stale lease release preconditions in a pending intent”. */
  let current = Date.parse("2026-01-01T00:00:00.000Z");
  /** Defines the transport fixture for “does not strand stale lease release preconditions in a pending intent”. */
  const transport = new ResourceTransport();
  /** Defines the now fixture for “does not strand stale lease release preconditions in a pending intent”. */
  const now = () => new Date(current);
  /** Defines the pages fixture for “does not strand stale lease release preconditions in a pending intent”. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Defines the state fixture for “does not strand stale lease release preconditions in a pending intent”. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Defines the acquired fixture for “does not strand stale lease release preconditions in a pending intent”. */
  const acquired = await state.acquireLease({
    expiresAt: "2026-01-01T00:10:00.000Z",
    idempotencyKey: "release-acquire",
    ownerId: "owner",
    scope: "agent_run",
    agentId: "agent-1",
    taskId: null,
  });
  /** Defines the before fixture for “does not strand stale lease release preconditions in a pending intent”. */
  const before = await state.leaseSnapshot(acquired.leaseId!);
  assert.notEqual(before, null);
  current += 1_000;
  await state.renewLease({
    expectedExpiresAt: before!.expiresAt,
    idempotencyKey: "release-renew",
    leaseId: acquired.leaseId!,
    nextExpiresAt: "2026-01-01T00:20:00.000Z",
    ownerId: "owner",
  });
  await assert.rejects(
    state.releaseLease({
      expectedVersion: before!.version,
      leaseId: acquired.leaseId!,
      ownerId: "owner",
    }),
    /release conflict/u,
  );
  /** Defines the after fixture for “does not strand stale lease release preconditions in a pending intent”. */
  const after = await state.leaseSnapshot(acquired.leaseId!);
  assert.notEqual(after, null);
  await state.releaseLease({
    expectedVersion: after!.version,
    leaseId: acquired.leaseId!,
    ownerId: "owner",
  });
  assert.equal((await state.leaseSnapshot(acquired.leaseId!))?.released, true);
});

test("does not persist an intent when its known precondition fails", async () => {
  /** Defines the transport fixture for “does not persist an intent when its known precondition fails”. */
  const transport = new ResourceTransport();
  /** Defines the now fixture for “does not persist an intent when its known precondition fails”. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Defines the pages fixture for “does not persist an intent when its known precondition fails”. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Defines the state fixture for “does not persist an intent when its known precondition fails”. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  await assert.rejects(
    state.beginIntent(
      "precondition",
      "task",
      { taskId: "task-1" },
      async () => {
        throw new Error("Task version conflict");
      },
    ),
    /version conflict/u,
  );
  assert.equal(
    (await state.reconcileIntent("precondition")).state,
    "not_applied",
  );
});

test("repairs only the exact marked pending Notion Task mutation", async () => {
  /** Defines the transport fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const transport = new ResourceTransport();
  transport.seedTask(NOTION_TABLES.tasks);
  /** Defines the now fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Defines the pages fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const pages = new NotionPageStore(NOTION_TABLES, transport, now);
  /** Defines the state fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Defines the provider fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const provider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `recovery-${randomUUID()}`,
    now,
    transport,
  });
  /** Defines the task fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const task = await provider.getTaskSnapshot("task-1");
  assert.equal(Object.hasOwn(task.properties, "Manager Mutation"), false);
  /** Defines the mutation fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const mutation = {
    expectedVersion: task.version,
    idempotencyKey: "task-interrupted",
    nextBody: null,
    nextProperties: task.properties,
    nextStatus: "Done",
    taskId: task.id,
  };
  await state.beginIntent(mutation.idempotencyKey, "task", mutation);
  await pages.applyTaskMutation(mutation);
  assert.equal(
    (await provider.applyTaskMutation(mutation)).providerRecord.id,
    task.id,
  );
  assert.equal(
    (await provider.reconcileIntent(mutation.idempotencyKey)).state,
    "applied",
  );

  /** Defines the another fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const another = new ResourceTransport();
  another.seedTask(NOTION_TABLES.tasks);
  /** Defines the another pages fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const anotherPages = new NotionPageStore(NOTION_TABLES, another, now);
  /** Defines the another state fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const anotherState = new NotionStateStore(
    anotherPages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Defines the another provider fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const anotherProvider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `recovery-${randomUUID()}`,
    now,
    transport: another,
  });
  /** Defines the original fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const original = await anotherProvider.getTaskSnapshot("task-1");
  /** Defines the pending fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const pending = {
    expectedVersion: original.version,
    idempotencyKey: "task-pending",
    nextBody: null,
    nextProperties: original.properties,
    nextStatus: "Done",
    taskId: original.id,
  };
  await anotherState.beginIntent(pending.idempotencyKey, "task", pending);
  await anotherPages.applyTaskMutation({
    ...pending,
    idempotencyKey: "unrelated-same-target",
  });
  await assert.rejects(
    anotherProvider.applyTaskMutation(pending),
    /conflicts with newer state/u,
  );

  /** Defines the body transport fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const bodyTransport = new ResourceTransport();
  bodyTransport.seedTask(NOTION_TABLES.tasks);
  bodyTransport.failNextTaskPropertyPatch = true;
  /** Defines the body provider fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const bodyProvider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `recovery-${randomUUID()}`,
    now,
    transport: bodyTransport,
  });
  /** Defines the body task fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const bodyTask = await bodyProvider.getTaskSnapshot("task-1");
  /** Defines the body mutation fixture for “repairs only the exact marked pending Notion Task mutation”. */
  const bodyMutation = {
    expectedVersion: bodyTask.version,
    idempotencyKey: "task-body-pending",
    nextBody: "Updated body",
    nextProperties: bodyTask.properties,
    nextStatus: "Done",
    taskId: bodyTask.id,
  };
  await assert.rejects(
    bodyProvider.applyTaskMutation(bodyMutation),
    /simulated Task property interruption/u,
  );
  assert.equal(
    (await bodyProvider.applyTaskMutation(bodyMutation)).providerRecord.id,
    bodyTask.id,
  );
  assert.equal(
    (await bodyProvider.getTaskSnapshot(bodyTask.id)).body,
    "Updated body",
  );
});

test("repairs a pending Notion Resource intent from its exact target state", async () => {
  /** Defines the transport fixture for “repairs a pending Notion Resource intent from its exact target state”. */
  const transport = new ResourceTransport();
  /** Defines the now fixture for “repairs a pending Notion Resource intent from its exact target state”. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Defines the pages fixture for “repairs a pending Notion Resource intent from its exact target state”. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Defines the state fixture for “repairs a pending Notion Resource intent from its exact target state”. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Defines the body fixture for “repairs a pending Notion Resource intent from its exact target state”. */
  const body = '{"schema":"test-resource-v1"}';
  /** Defines the record fixture for “repairs a pending Notion Resource intent from its exact target state”. */
  const record: ResourceMutation = {
    body,
    dependencies: [],
    digest: sha256(body),
    idempotencyKey: "resource-interrupted",
    key: "test/recovered",
    kind: "test",
    state: "active",
    version: "v1",
  };
  await state.beginIntent(record.idempotencyKey, "resource", record);
  /** Defines the provider fixture for “repairs a pending Notion Resource intent from its exact target state”. */
  const provider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `recovery-${randomUUID()}`,
    now,
    transport,
  });
  await provider.putResource(record);
  assert.deepEqual(await provider.getOptionalResource(record.key), {
    body,
    dependencies: [],
    digest: record.digest,
    key: record.key,
    kind: record.kind,
    state: record.state,
    version: record.version,
  });
  assert.equal(
    (await provider.reconcileIntent(record.idempotencyKey)).state,
    "applied",
  );
});

test("does not repair an old pending Resource intent over newer state", async () => {
  /** Defines the transport fixture for “does not repair an old pending Resource intent over newer state”. */
  const transport = new ResourceTransport();
  /** Defines the now fixture for “does not repair an old pending Resource intent over newer state”. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Defines the pages fixture for “does not repair an old pending Resource intent over newer state”. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Defines the state fixture for “does not repair an old pending Resource intent over newer state”. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Defines the old body fixture for “does not repair an old pending Resource intent over newer state”. */
  const oldBody = '{"revision":1}';
  /** Defines the newer body fixture for “does not repair an old pending Resource intent over newer state”. */
  const newerBody = '{"revision":2}';
  /** Defines the old fixture for “does not repair an old pending Resource intent over newer state”. */
  const old: ResourceMutation = {
    body: oldBody,
    dependencies: [],
    digest: sha256(oldBody),
    idempotencyKey: "resource-old",
    key: "test/conflict",
    kind: "test",
    state: "active",
    version: "v1",
  };
  /** Defines the newer fixture for “does not repair an old pending Resource intent over newer state”. */
  const newer: ResourceMutation = {
    ...old,
    body: newerBody,
    digest: sha256(newerBody),
    idempotencyKey: "resource-newer",
    version: "v2",
  };
  await state.beginIntent(old.idempotencyKey, "resource", old);
  await pages.createResource(newer);
  /** Defines the provider fixture for “does not repair an old pending Resource intent over newer state”. */
  const provider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `recovery-${randomUUID()}`,
    now,
    transport,
  });
  await assert.rejects(provider.putResource(old), /conflicts with newer state/);
  assert.equal(
    (await provider.getOptionalResource(old.key))?.digest,
    newer.digest,
  );
});

test("repairs a pending Notion Error intent from its exact target state", async () => {
  /** Defines the transport fixture for “repairs a pending Notion Error intent from its exact target state”. */
  const transport = new ResourceTransport();
  /** Defines the now fixture for “repairs a pending Notion Error intent from its exact target state”. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Defines the pages fixture for “repairs a pending Notion Error intent from its exact target state”. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Defines the state fixture for “repairs a pending Notion Error intent from its exact target state”. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Defines the error fixture for “repairs a pending Notion Error intent from its exact target state”. */
  const error = {
    description: "Publication is unavailable.",
    errorKey: "publication/missing",
    idempotencyKey: "error-interrupted",
    relatedRunId: "run-1",
    relatedAgentId: null,
    relatedTaskId: null,
    resolution: "Configure publication.",
    severity: "high" as const,
    status: "Not Fixed" as const,
    title: "Publication unavailable",
  };
  await state.beginIntent(error.idempotencyKey, "error", error);
  await pages.createOrUpdateError(error);
  /** Defines the provider fixture for “repairs a pending Notion Error intent from its exact target state”. */
  const provider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `recovery-${randomUUID()}`,
    now,
    transport,
  });
  assert.equal(
    (await provider.createOrUpdateError(error)).providerRecord.table,
    "errors",
  );
  assert.equal(
    (await provider.reconcileIntent(error.idempotencyKey)).state,
    "applied",
  );
});

/** Implements resource transport. */
class ResourceTransport implements NotionTransport {
  /** Contains blocks for resource transport. */
  readonly #blocks = new Map<string, JsonObject[]>();
  /** Contains pages for resource transport. */
  readonly #pages = new Map<string, JsonObject>();
  /** Contains clock for resource transport. */
  #clock = 0;
  /** Contains fail next task property patch for resource transport. */
  public failNextTaskPropertyPatch = false;

  /** Seeds task. */
  public seedTask(parent = "tasks"): void {
    this.#pages.set(
      "task-1",
      this.page(
        "task-1",
        {
          Dependencies: {
            has_more: false,
            id: "blocked-by",
            relation: [],
            type: "relation",
          },
          "Manager Mutation": {
            id: "manager-mutation",
            rich_text: [],
            type: "rich_text",
          },
          Priority: { id: "priority", number: null, type: "number" },
          Status: { id: "status", select: { name: "Todo" }, type: "select" },
          Task: {
            id: "title",
            title: [{ text: { content: "Task" }, type: "text" }],
            type: "title",
          },
        },
        parent,
      ),
    );
    this.#blocks.set("task-1", []);
  }

  /** Executes one provider request. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    /** Defines the data source fixture used by request. */
    const dataSource = /^\/v1\/data_sources\/([^/]+)$/u.exec(request.path);
    if (request.method === "GET" && dataSource?.[1] !== undefined)
      return { id: dataSource[1], object: "data_source" };
    if (/^\/v1\/data_sources\/[^/]+\/query$/u.test(request.path)) {
      /** Defines the filter fixture used by request. */
      const filter = objectValue(objectValue(request.body).filter);
      /** Defines the property fixture used by request. */
      const property = String(filter.property);
      /** Defines the expected fixture used by request. */
      const expected = String(
        objectValue(filter.title).equals ??
          objectValue(filter.rich_text).equals ??
          objectValue(filter.select).equals,
      );
      /** Defines the results fixture used by request. */
      const results = [...this.#pages.values()].filter(
        (page) => propertyValue(page, property) === expected,
      );
      return { has_more: false, next_cursor: null, results };
    }
    if (request.method === "POST" && request.path === "/v1/pages") {
      /** Defines the body fixture used by request. */
      const body = objectValue(request.body);
      /** Defines the ID fixture used by request. */
      const id = `resource-${this.#pages.size + 1}`;
      /** Defines the page fixture used by request. */
      const page = this.page(
        id,
        objectValue(body.properties),
        String(objectValue(body.parent).data_source_id),
      );
      this.#pages.set(id, page);
      this.#blocks.set(
        id,
        (body.children as JsonObject[]).map((block, index) => ({
          ...block,
          id: `${id}-${index}`,
        })),
      );
      return page;
    }
    /** Defines the page match fixture used by request. */
    const pageMatch = /^\/v1\/pages\/(.+)$/u.exec(request.path);
    if (pageMatch?.[1] !== undefined) {
      /** Defines the current fixture used by request. */
      const current = required(this.#pages.get(pageMatch[1]));
      if (request.method === "GET") return current;
      if (pageMatch[1] === "task-1" && this.failNextTaskPropertyPatch) {
        this.failNextTaskPropertyPatch = false;
        throw new Error("simulated Task property interruption");
      }
      /** Defines the body fixture used by request. */
      const body = objectValue(request.body);
      /** Defines the next fixture used by request. */
      const next = this.page(
        pageMatch[1],
        mergeProperties(
          objectValue(current.properties),
          objectValue(body.properties),
        ),
        String(objectValue(current.parent).data_source_id),
      );
      this.#pages.set(pageMatch[1], next);
      return next;
    }
    /** Defines the children fixture used by request. */
    const children = /^\/v1\/blocks\/(.+)\/children$/u.exec(request.path);
    if (children?.[1] !== undefined && request.method === "GET") {
      return {
        has_more: false,
        next_cursor: null,
        results: this.#blocks.get(children[1]) ?? [],
      };
    }
    if (children?.[1] !== undefined && request.method === "PATCH") {
      /** Defines the existing fixture used by request. */
      const existing = this.#blocks.get(children[1]) ?? [];
      /** Defines the added fixture used by request. */
      const added = (objectValue(request.body).children as JsonObject[]).map(
        (item, index) => ({
          ...item,
          id: `${children[1]}-${existing.length + index}`,
        }),
      );
      this.#blocks.set(children[1], [...existing, ...added]);
      /** Defines the current fixture used by request. */
      const current = required(this.#pages.get(children[1]));
      this.#pages.set(
        children[1],
        this.page(
          children[1],
          objectValue(current.properties),
          String(objectValue(current.parent).data_source_id),
        ),
      );
      return { results: added };
    }
    /** Defines the block fixture used by request. */
    const block = /^\/v1\/blocks\/(.+)$/u.exec(request.path);
    if (block?.[1] !== undefined && request.method === "PATCH") {
      for (const [pageId, blocks] of this.#blocks) {
        /** Defines the index fixture used by request. */
        const index = blocks.findIndex(
          (candidate) => candidate.id === block[1],
        );
        if (index >= 0) {
          blocks[index] = {
            ...required(blocks[index]),
            ...objectValue(request.body),
          };
          /** Defines the current fixture used by request. */
          const current = required(this.#pages.get(pageId));
          this.#pages.set(
            pageId,
            this.page(
              pageId,
              objectValue(current.properties),
              String(objectValue(current.parent).data_source_id),
            ),
          );
          return required(blocks[index]);
        }
      }
    }
    throw new Error(`Unexpected ${request.method} ${request.path}`);
  }

  /** Builds a simulated Notion page returned by the transport. */
  private page(
    id: string,
    properties: JsonObject,
    parent = "resources",
  ): JsonObject {
    this.#clock += 1;
    /** Defines the normalized fixture used by page. */
    const normalized = Object.fromEntries(
      Object.entries(properties).map(([name, value]) => {
        /** Defines the property fixture used by page. */
        const property = objectValue(value);
        return [
          name,
          property.type === undefined
            ? { ...property, type: Object.keys(property)[0] ?? "unknown" }
            : property,
        ];
      }),
    );
    return {
      id,
      last_edited_time: `2026-01-01T00:00:${String(this.#clock).padStart(2, "0")}.000Z`,
      object: "page",
      parent: { data_source_id: parent, type: "data_source_id" },
      properties: normalized,
    };
  }
}

/** Creates the merge properties test fixture. */
function mergeProperties(prior: JsonObject, updates: JsonObject): JsonObject {
  return {
    ...prior,
    ...Object.fromEntries(
      Object.entries(updates).map(([name, value]) => {
        /** Defines the before fixture used by merge properties. */
        const before = objectValue(prior[name]);
        /** Defines the after fixture used by merge properties. */
        const after = objectValue(value);
        return [
          name,
          {
            ...before,
            ...after,
            type: before.type ?? Object.keys(after)[0] ?? "unknown",
          },
        ];
      }),
    ),
  };
}

/** Extracts a textual property value from a simulated Notion page. */
function propertyValue(page: JsonObject, name: string): string {
  /** Defines the property fixture used by property value. */
  const property = objectValue(objectValue(page.properties)[name]);
  /** Defines the values fixture used by property value. */
  const values = property.title ?? property.rich_text;
  if (Array.isArray(values))
    return values
      .map((item) => String(objectValue(objectValue(item).text).content))
      .join("");
  return String(objectValue(property.select).name ?? "");
}

/** Returns a validated JSON object. */
function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** Returns a fixture value or fails the test. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture value missing");
  return value;
}

/** Creates the Notion environment test fixture. */
function notionEnvironment(): ProviderEnvironment {
  return {
    bootstrapParent: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    connection: { authEnvironmentVariable: "NOTION_TOKEN" },
    tables: NOTION_TABLES,
    type: "notion",
  };
}
