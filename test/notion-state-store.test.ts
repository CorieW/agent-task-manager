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

/** Maps logical tables to stable fake provider identifiers. */
const TABLES = {
  errors: "errors",
  operations: "operations",
  resources: "resources",
  agents: "agents",
  tasks: "tasks",
};

/** Maps logical tables to stable fake Notion identifiers. */
const NOTION_TABLES = {
  errors: "11111111-1111-1111-1111-111111111111",
  operations: "55555555-5555-5555-5555-555555555555",
  resources: "22222222-2222-2222-2222-222222222222",
  agents: "33333333-3333-3333-3333-333333333333",
  tasks: "44444444-4444-4444-4444-444444444444",
};

test("persists replayable leases and restart-visible intent outcomes", async () => {
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new ResourceTransport();
  /** Controls the simulated provider clock deterministically. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Stores the in-memory Notion rows returned by the transport. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Captures the first operation result for replay comparison. */
  const first = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Supplies the operation input under test. */
  const request = {
    expiresAt: "2026-01-01T01:00:00.000Z",
    idempotencyKey: "acquire-one",
    ownerId: "run-1",
    scope: "agent_run" as const,
    agentId: "agent-1",
    taskId: null,
  };
  /** Captures the lease granted by the provider. */
  const acquired = await first.acquireLease(request);
  assert.equal(acquired.acquired, true);

  /** Reopens persisted state through a new provider instance. */
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

  /** Captures the lease acquired by the concurrent contender. */
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

test("persists restart-visible logical operation plans and results", async () => {
  /** Retains Resource rows across simulated provider restarts. */
  const transport = new ResourceTransport();
  /** Freezes timestamps so persisted records compare deterministically. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Creates the provider instance that starts and completes the operation. */
  const first = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `operation-${randomUUID()}`,
    now,
    transport,
  });
  /** Represents the immutable logical transition plan. */
  const payload = { mutation: { taskId: "task-1" }, schema: "plan-v1" };

  /** Captures the durable intent before its result exists. */
  const pending = await first.beginOperationIntent(
    "logical-operation",
    "transition",
    payload,
  );
  assert.equal(pending.state, "pending");
  /** Captures the completed durable operation record. */
  const completed = await first.completeOperationIntent(
    "logical-operation",
    "transition",
    payload,
    { targetStatus: "Review" },
  );
  assert.equal(completed.state, "applied");

  /** Reopens the same persisted state through a new provider instance. */
  const restarted = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `operation-${randomUUID()}`,
    now,
    transport,
  });
  assert.deepEqual(
    (await restarted.getOperationIntent("logical-operation"))?.result,
    { targetStatus: "Review" },
  );
});

test("rejects an invalid Resource before persisting its intent", async () => {
  /** Captures provider writes made during Resource validation. */
  const transport = new ResourceTransport();
  /** Performs the Resource preflight under test. */
  const provider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `resource-preflight-${randomUUID()}`,
    transport,
  });
  /** Carries a digest computed from noncanonical body text. */
  const record: ResourceMutation = {
    body: "Line one\r\nLine two",
    dependencies: [],
    digest: sha256("Line one\r\nLine two"),
    idempotencyKey: "resource-preflight",
    key: "prompt/preflight",
    kind: "prompt",
    state: "active",
    version: "v1",
  };

  await assert.rejects(
    provider.putResource(record),
    /Digest must match its canonical body/u,
  );
  assert.equal(
    (await provider.reconcileIntent(record.idempotencyKey)).state,
    "not_applied",
  );
});

test("separates manager-owned Operations from content Resources", async () => {
  /** Simulated Notion transport that records Resource pages. */
  const transport = new ResourceTransport();
  /** Provider exposing separate caller and manager Resource boundaries. */
  const provider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `system-resource-${randomUUID()}`,
    transport,
  });
  /** Manager-owned assignment progress persisted through the reserved path. */
  const body = '{"schema":"assignment-intent-v1"}';
  /** Legacy system-shaped Resource used to verify the content boundary. */
  const record: ResourceMutation = {
    body,
    dependencies: [],
    digest: sha256(body),
    idempotencyKey: "system-resource-write",
    key: "assignment/test",
    kind: "assignment/intent",
    state: "active",
    version: "v1",
  };

  await assert.rejects(
    provider.putResource(record),
    /Resource kind is invalid/u,
  );
  await provider.putOperation({
    ...record,
    key: "assignment/test",
    kind: "assignment/intent",
  });
  assert.deepEqual(await provider.getOptionalOperation("assignment/test"), {
    body,
    dependencies: [],
    digest: record.digest,
    key: "assignment/test",
    kind: "assignment/intent",
    state: record.state,
    version: record.version,
  });
});

test("does not strand stale lease release preconditions in a pending intent", async () => {
  /** Tracks the mutable simulated clock or current record state. */
  let current = Date.parse("2026-01-01T00:00:00.000Z");
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new ResourceTransport();
  /** Controls the simulated provider clock deterministically. */
  const now = () => new Date(current);
  /** Stores the in-memory Notion rows returned by the transport. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Tracks mutable simulated state across the operation. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Captures the lease granted by the provider. */
  const acquired = await state.acquireLease({
    expiresAt: "2026-01-01T00:10:00.000Z",
    idempotencyKey: "release-acquire",
    ownerId: "owner",
    scope: "agent_run",
    agentId: "agent-1",
    taskId: null,
  });
  /** Snapshots provider state before the operation. */
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
  /** Snapshots provider state after the operation. */
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
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new ResourceTransport();
  /** Controls the simulated provider clock deterministically. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Stores the in-memory Notion rows returned by the transport. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Tracks mutable simulated state across the operation. */
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
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new ResourceTransport();
  transport.seedTask(NOTION_TABLES.tasks);
  /** Controls the simulated provider clock deterministically. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Stores the in-memory Notion rows returned by the transport. */
  const pages = new NotionPageStore(NOTION_TABLES, transport, now);
  /** Tracks mutable simulated state across the operation. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Provides isolated provider state for the scenario. */
  const provider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `recovery-${randomUUID()}`,
    now,
    transport,
  });
  /** Represents the Task state exercised by the scenario. */
  const task = await provider.getTaskSnapshot("task-1");
  assert.equal(Object.hasOwn(task.properties, "Manager Mutation"), false);
  /** Describes the provider mutation exercised by the scenario. */
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

  /** Provides an independent transport state for contention testing. */
  const another = new ResourceTransport();
  another.seedTask(NOTION_TABLES.tasks);
  /** Stores rows owned by the competing transport instance. */
  const anotherPages = new NotionPageStore(NOTION_TABLES, another, now);
  /** Stores intents owned by the competing provider instance. */
  const anotherState = new NotionStateStore(
    anotherPages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Creates a competing provider over independent local state. */
  const anotherProvider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `recovery-${randomUUID()}`,
    now,
    transport: another,
  });
  /** Preserves the pre-update record for comparison. */
  const original = await anotherProvider.getTaskSnapshot("task-1");
  /** Captures durable state before the operation completes. */
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

  /** Injects and records Task body transport behavior. */
  const bodyTransport = new ResourceTransport();
  bodyTransport.seedTask(NOTION_TABLES.tasks);
  bodyTransport.failNextTaskPropertyPatch = true;
  /** Exercises the provider during Task body reconciliation. */
  const bodyProvider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `recovery-${randomUUID()}`,
    now,
    transport: bodyTransport,
  });
  /** Represents the Task whose body is reconciled. */
  const bodyTask = await bodyProvider.getTaskSnapshot("task-1");
  /** Describes the Task body change under reconciliation. */
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
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new ResourceTransport();
  /** Controls the simulated provider clock deterministically. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Stores the in-memory Notion rows returned by the transport. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Tracks mutable simulated state across the operation. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Decodes the request body consumed by the fake transport. */
  const body = '{"schema":"test-resource-v1"}';
  /** Represents the provider record inspected by the scenario. */
  const record: ResourceMutation = {
    body,
    dependencies: [],
    digest: sha256(body),
    idempotencyKey: "resource-interrupted",
    key: "test/recovered",
    kind: "json-schema",
    state: "active",
    version: "v1",
  };
  await state.beginIntent(record.idempotencyKey, "resource", record);
  /** Provides isolated provider state for the scenario. */
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

test("repairs an exact Resource target after its body rebuild is interrupted", async () => {
  /** Injects one failure while appending replacement Resource blocks. */
  const transport = new ResourceTransport();
  /** Reconciles the interrupted Notion Resource operation. */
  const provider = new NotionProvider({
    environment: notionEnvironment(),
    environmentId: `resource-rebuild-${randomUUID()}`,
    transport,
  });
  /** Seeds the original canonical machine-readable body. */
  const firstBody = '{"type":"string"}';
  await provider.putResource({
    body: firstBody,
    dependencies: [],
    digest: sha256(firstBody),
    idempotencyKey: "resource-rebuild-first",
    key: "schema/rebuild",
    kind: "json-schema",
    state: "active",
    version: "v1",
  });
  /** Supplies the replacement canonical body. */
  const nextBody = '{"type":"number"}';
  /** Describes the exact Resource target retried after interruption. */
  const update: ResourceMutation = {
    body: nextBody,
    dependencies: [],
    digest: sha256(nextBody),
    idempotencyKey: "resource-rebuild-update",
    key: "schema/rebuild",
    kind: "json-schema",
    state: "active",
    version: "v2",
  };
  transport.failNextResourceBlockAppend = true;

  await assert.rejects(
    provider.putResource(update),
    /simulated Resource body interruption/u,
  );
  await provider.putResource(update);

  assert.deepEqual(await provider.getOptionalResource(update.key), {
    body: nextBody,
    dependencies: [],
    digest: update.digest,
    key: update.key,
    kind: update.kind,
    state: update.state,
    version: update.version,
  });
});

test("does not repair an old pending Resource intent over newer state", async () => {
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new ResourceTransport();
  /** Controls the simulated provider clock deterministically. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Stores the in-memory Notion rows returned by the transport. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Tracks mutable simulated state across the operation. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Supplies the body associated with the stale Resource version. */
  const oldBody = '{"revision":1}';
  /** Supplies the body associated with the newer Resource version. */
  const newerBody = '{"revision":2}';
  /** Represents stale state that reconciliation must not restore. */
  const old: ResourceMutation = {
    body: oldBody,
    dependencies: [],
    digest: sha256(oldBody),
    idempotencyKey: "resource-old",
    key: "test/conflict",
    kind: "json-schema",
    state: "active",
    version: "v1",
  };
  /** Represents the newer competing state retained after reconciliation. */
  const newer: ResourceMutation = {
    ...old,
    body: newerBody,
    digest: sha256(newerBody),
    idempotencyKey: "resource-newer",
    version: "v2",
  };
  await state.beginIntent(old.idempotencyKey, "resource", old);
  await pages.createResource(newer);
  /** Provides isolated provider state for the scenario. */
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
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new ResourceTransport();
  /** Controls the simulated provider clock deterministically. */
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  /** Stores the in-memory Notion rows returned by the transport. */
  const pages = new NotionPageStore(TABLES, transport, now);
  /** Tracks mutable simulated state across the operation. */
  const state = new NotionStateStore(
    pages,
    new SingleHostMutex(`state-${randomUUID()}`),
    now,
  );
  /** Describes the Error mutation used to test reconciliation. */
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
  /** Provides isolated provider state for the scenario. */
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
  /** Stores managed child blocks by their parent Notion page. */
  readonly #blocks = new Map<string, JsonObject[]>();
  /** Stores fake Notion pages by identifier across provider restarts. */
  readonly #pages = new Map<string, JsonObject>();
  /** Advances edited timestamps for each simulated Notion mutation. */
  #clock = 0;
  /** Injects one interruption after a Task property update is committed. */
  public failNextTaskPropertyPatch = false;
  /** Simulates an interrupted machine Resource body append. */
  public failNextResourceBlockAppend = false;

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
    /** Captures the Notion data-source definition under inspection. */
    const dataSource = /^\/v1\/data_sources\/([^/]+)$/u.exec(request.path);
    if (request.method === "GET" && dataSource?.[1] !== undefined)
      return { id: dataSource[1], object: "data_source" };
    if (/^\/v1\/data_sources\/[^/]+\/query$/u.test(request.path)) {
      /** Decodes the Notion query filter under simulation. */
      const filter = objectValue(objectValue(request.body).filter);
      /** Identifies the Notion property constrained by the query. */
      const property = String(filter.property);
      /** Builds the canonical schema expected after provisioning. */
      const expected = String(
        objectValue(filter.title).equals ??
          objectValue(filter.rich_text).equals ??
          objectValue(filter.select).equals,
      );
      /** Collects operation outcomes used by assertions. */
      const results = [...this.#pages.values()].filter(
        (page) => propertyValue(page, property) === expected,
      );
      return { has_more: false, next_cursor: null, results };
    }
    if (request.method === "POST" && request.path === "/v1/pages") {
      /** Decodes the request body consumed by the fake transport. */
      const body = objectValue(request.body);
      /** Extracts the Notion page identifier targeted by the request. */
      const id = `resource-${this.#pages.size + 1}`;
      /** Reads the persisted Notion row used as the assertion oracle. */
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
    /** Parses a page endpoint in the fake Notion transport. */
    const pageMatch = /^\/v1\/pages\/(.+)$/u.exec(request.path);
    if (pageMatch?.[1] !== undefined) {
      /** Tracks the mutable simulated clock or current record state. */
      const current = required(this.#pages.get(pageMatch[1]));
      if (request.method === "GET") return current;
      if (pageMatch[1] === "task-1" && this.failNextTaskPropertyPatch) {
        this.failNextTaskPropertyPatch = false;
        throw new Error("simulated Task property interruption");
      }
      /** Decodes the request body consumed by the fake transport. */
      const body = objectValue(request.body);
      /** Builds the provider state expected after applying the update. */
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
    /** Collects child blocks returned or appended by the fake transport. */
    const children = /^\/v1\/blocks\/(.+)\/children$/u.exec(request.path);
    if (children?.[1] !== undefined && request.method === "GET") {
      return {
        has_more: false,
        next_cursor: null,
        results: this.#blocks.get(children[1]) ?? [],
      };
    }
    if (children?.[1] !== undefined && request.method === "PATCH") {
      if (this.failNextResourceBlockAppend) {
        this.failNextResourceBlockAppend = false;
        throw new Error("simulated Resource body interruption");
      }
      /** Reads the managed blocks present before replacement. */
      const existing = this.#blocks.get(children[1]) ?? [];
      /** Collects blocks appended by the simulated Notion request. */
      const added = (objectValue(request.body).children as JsonObject[]).map(
        (item, index) => ({
          ...item,
          id: `${children[1]}-${existing.length + index}`,
        }),
      );
      this.#blocks.set(children[1], [...existing, ...added]);
      /** Tracks the mutable simulated clock or current record state. */
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
    /** Identifies the managed block targeted by the fake request. */
    const block = /^\/v1\/blocks\/(.+)$/u.exec(request.path);
    if (block?.[1] !== undefined && request.method === "PATCH") {
      for (const [pageId, blocks] of this.#blocks) {
        /** Locates the managed block updated by the fake transport. */
        const index = blocks.findIndex(
          (candidate) => candidate.id === block[1],
        );
        if (index >= 0) {
          if (objectValue(request.body).in_trash === true) {
            blocks.splice(index, 1);
            return { id: block[1], in_trash: true };
          }
          blocks[index] = {
            ...required(blocks[index]),
            ...objectValue(request.body),
          };
          /** Tracks the mutable simulated clock or current record state. */
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
    /** Normalizes page properties before storing the fake row. */
    const normalized = Object.fromEntries(
      Object.entries(properties).map(([name, value]) => {
        /** Identifies the Notion property constrained by the query. */
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

/** Applies Notion-style property updates to an existing property map. */
function mergeProperties(prior: JsonObject, updates: JsonObject): JsonObject {
  return {
    ...prior,
    ...Object.fromEntries(
      Object.entries(updates).map(([name, value]) => {
        /** Snapshots provider state before the operation. */
        const before = objectValue(prior[name]);
        /** Snapshots provider state after the operation. */
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
  /** Identifies the Notion property constrained by the query. */
  const property = objectValue(objectValue(page.properties)[name]);
  /** Collects plain text extracted from a Notion property. */
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

/** Builds the canonical Notion provider environment. */
function notionEnvironment(): ProviderEnvironment {
  return {
    bootstrapParent: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    connection: { authEnvironmentVariable: "NOTION_TOKEN" },
    tables: NOTION_TABLES,
    type: "notion",
  };
}
