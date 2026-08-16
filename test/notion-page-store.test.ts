/** Verifies provider-owned Notion writes are uniquely addressed and post-verified. */
import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/core/digest.js";
import type { JsonObject } from "../src/domain/json.js";
import { NotionPageStore } from "../src/provider/notion/notion-page-store.js";
import type {
  NotionRequest,
  NotionTransport,
} from "../src/provider/notion/notion-transport.js";

/** Defines the shared tables fixture for this test module. */
const TABLES = {
  errors: "errors",
  resources: "resources",
  agents: "agents",
  tasks: "tasks",
};

/** Implements mutable transport. */
class MutableTransport implements NotionTransport {
  /** Contains blocks for mutable transport. */
  public readonly blocks = new Map<string, JsonObject[]>();
  /** Contains pages for mutable transport. */
  public readonly pages = new Map<string, JsonObject>();
  /** Contains requests for mutable transport. */
  public readonly requests: NotionRequest[] = [];
  /** Contains version for mutable transport. */
  #version = 0;

  /** Executes one provider request. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    this.requests.push(request);
    /** Defines the query fixture used by request. */
    const query = /^\/v1\/data_sources\/(\w+)\/query$/u.exec(request.path);
    if (query?.[1] !== undefined) {
      /** Defines the filter fixture used by request. */
      const filter = objectValue(request.body).filter;
      /** Defines the filter object fixture used by request. */
      const filterObject = objectValue(filter);
      /** Defines the property fixture used by request. */
      const property = String(filterObject.property);
      /** Defines the title equals fixture used by request. */
      const titleEquals = objectValue(filterObject.title).equals;
      /** Defines the rich text equals fixture used by request. */
      const richTextEquals = objectValue(filterObject.rich_text).equals;
      /** Defines the select equals fixture used by request. */
      const selectEquals = objectValue(filterObject.select).equals;
      /** Defines the equals fixture used by request. */
      const equals =
        typeof titleEquals === "string"
          ? titleEquals
          : typeof richTextEquals === "string"
            ? richTextEquals
            : String(selectEquals);
      /** Defines the results fixture used by request. */
      const results = [...this.pages.values()].filter(
        (page) =>
          objectValue(page.parent).data_source_id === query[1] &&
          propertyValue(page, property) === equals,
      );
      return { has_more: false, next_cursor: null, results };
    }
    if (request.method === "POST" && request.path === "/v1/pages") {
      /** Defines the body fixture used by request. */
      const body = objectValue(request.body);
      /** Defines the ID fixture used by request. */
      const id = `page-${this.pages.size + 1}`;
      /** Defines the page fixture used by request. */
      const page = this.newPage(
        id,
        String(objectValue(body.parent).data_source_id),
        objectValue(body.properties),
      );
      this.pages.set(id, page);
      this.blocks.set(
        id,
        (body.children as JsonObject[]).map((block, index) => ({
          ...block,
          id: `${id}-block-${index}`,
        })),
      );
      return page;
    }
    /** Defines the page match fixture used by request. */
    const pageMatch = /^\/v1\/pages\/(.+)$/u.exec(request.path);
    if (pageMatch?.[1] !== undefined) {
      /** Defines the page fixture used by request. */
      const page = required(this.pages.get(pageMatch[1]));
      if (request.method === "GET") return page;
      /** Defines the body fixture used by request. */
      const body = objectValue(request.body);
      /** Defines the prior properties fixture used by request. */
      const priorProperties = objectValue(page.properties);
      /** Defines the updates fixture used by request. */
      const updates = Object.fromEntries(
        Object.entries(objectValue(body.properties)).map(([name, value]) => {
          /** Defines the update fixture used by request. */
          const update = objectValue(value);
          /** Defines the prior fixture used by request. */
          const prior = objectValue(priorProperties[name]);
          /** Defines the type fixture used by request. */
          const type =
            typeof prior.type === "string"
              ? prior.type
              : (Object.keys(update)[0] ?? "unknown");
          return [name, { ...prior, ...update, type }];
        }),
      );
      /** Defines the next fixture used by request. */
      const next = this.newPage(
        pageMatch[1],
        String(objectValue(page.parent).data_source_id),
        { ...priorProperties, ...updates },
      );
      this.pages.set(pageMatch[1], next);
      return next;
    }
    /** Defines the children fixture used by request. */
    const children = /^\/v1\/blocks\/(.+)\/children$/u.exec(request.path);
    if (children?.[1] !== undefined && request.method === "GET") {
      return {
        has_more: false,
        next_cursor: null,
        results: this.blocks.get(children[1]) ?? [],
      };
    }
    if (children?.[1] !== undefined && request.method === "PATCH") {
      /** Defines the existing fixture used by request. */
      const existing = this.blocks.get(children[1]) ?? [];
      /** Defines the added fixture used by request. */
      const added = (objectValue(request.body).children as JsonObject[]).map(
        (item, index) => ({
          ...item,
          id: `${children[1]}-block-${existing.length + index}`,
        }),
      );
      /** Reads the optional positioned-insertion anchor. */
      const position = objectValue(request.body).position;
      /** Selects the insertion offset after the requested anchor, or at the end. */
      let insertionIndex = existing.length;
      if (
        position !== null &&
        typeof position === "object" &&
        !Array.isArray(position)
      ) {
        /** Reads the positioned insertion's block reference. */
        const afterId = objectValue(position.after_block).id;
        if (typeof afterId === "string") {
          insertionIndex =
            existing.findIndex((candidate) => candidate.id === afterId) + 1;
        }
      }
      this.blocks.set(children[1], [
        ...existing.slice(0, insertionIndex),
        ...added,
        ...existing.slice(insertionIndex),
      ]);
      /** Defines the page fixture used by request. */
      const page = required(this.pages.get(children[1]));
      this.pages.set(
        children[1],
        this.newPage(
          children[1],
          String(objectValue(page.parent).data_source_id),
          objectValue(page.properties),
        ),
      );
      return { results: added };
    }
    /** Defines the block fixture used by request. */
    const block = /^\/v1\/blocks\/(.+)$/u.exec(request.path);
    if (block?.[1] !== undefined && request.method === "DELETE") {
      for (const blocks of this.blocks.values()) {
        /** Locates the block moved to trash by this request. */
        const index = blocks.findIndex(
          (candidate) => candidate.id === block[1],
        );
        if (index >= 0) {
          blocks.splice(index, 1);
          return { id: block[1], object: "block" };
        }
      }
    }
    if (block?.[1] !== undefined && request.method === "PATCH") {
      for (const [pageId, blocks] of this.blocks) {
        /** Defines the index fixture used by request. */
        const index = blocks.findIndex(
          (candidate) => candidate.id === block[1],
        );
        if (index >= 0) {
          /** Defines the current fixture used by request. */
          const current = required(blocks[index]);
          blocks[index] = { ...current, ...objectValue(request.body) };
          /** Defines the page fixture used by request. */
          const page = required(this.pages.get(pageId));
          this.pages.set(
            pageId,
            this.newPage(
              pageId,
              String(page.parent),
              objectValue(page.properties),
            ),
          );
          return blocks[index] ?? {};
        }
      }
    }
    throw new Error(`Unexpected ${request.method} ${request.path}`);
  }

  /** Seeds agent. */
  public seedAgent(): void {
    this.pages.set(
      "agent-1",
      this.newPage("agent-1", "agents", {
        Status: { id: "status", select: { name: "Offline" }, type: "select" },
        "Working On": { id: "work", relation: [], type: "relation" },
      }),
    );
  }

  /** Seeds task. */
  public seedTask(): void {
    this.pages.set(
      "task-1",
      this.newPage("task-1", "tasks", {
        "Manager Mutation": {
          id: "manager-mutation",
          rich_text: [],
          type: "rich_text",
        },
        Status: { id: "status", select: { name: "Todo" }, type: "select" },
        Task: {
          id: "title",
          title: [{ text: { content: "Task" }, type: "text" }],
          type: "title",
        },
      }),
    );
    this.blocks.set("task-1", []);
  }

  /** Creates the new page test fixture. */
  private newPage(
    id: string,
    parent: string,
    properties: JsonObject,
  ): JsonObject {
    this.#version += 1;
    /** Defines the normalized fixture used by new page. */
    const normalized = Object.fromEntries(
      Object.entries(properties).map(([name, value]) => {
        /** Defines the property fixture used by new page. */
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
      last_edited_time: `2026-01-01T00:00:${String(this.#version).padStart(2, "0")}.000Z`,
      object: "page",
      parent: { data_source_id: parent, type: "data_source_id" },
      properties: normalized,
    };
  }
}

test("creates one managed Resource row and verifies its content", async () => {
  /** Defines the transport fixture for “creates one managed Resource row and verifies its content”. */
  const transport = new MutableTransport();
  /** Defines the store fixture for “creates one managed Resource row and verifies its content”. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  /** Defines the receipt fixture for “creates one managed Resource row and verifies its content”. */
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
  assert.equal(
    await store.managedText(receipt.providerRecord.id, "Resource body"),
    "prompt body",
  );
  assert.deepEqual(
    transport.blocks.get(receipt.providerRecord.id)?.map((block) => block.type),
    ["heading_2", "paragraph"],
  );
  assert.equal(transport.pages.size, 1);
});

test("migrates a legacy prompt snippet when the Resource is updated", async () => {
  /** Provides mutable Notion state for the legacy migration. */
  const transport = new MutableTransport();
  /** Writes Resources through the production page-store behavior. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  await store.createResource({
    body: "legacy prompt",
    dependencies: [],
    digest: sha256("legacy prompt"),
    idempotencyKey: "write-legacy",
    key: "prompt/example",
    kind: "schema",
    state: "active",
    version: "v1",
  });

  await store.createResource({
    body: "Readable first paragraph.\n\nReadable second paragraph.",
    dependencies: [],
    digest: sha256("Readable first paragraph.\n\nReadable second paragraph."),
    idempotencyKey: "write-readable",
    key: "prompt/example",
    kind: "prompt",
    state: "active",
    version: "v2",
  });

  assert.equal(
    await store.managedText("page-1", "Resource body"),
    "Readable first paragraph.\n\nReadable second paragraph.",
  );
  assert.deepEqual(
    transport.blocks.get("page-1")?.map((block) => block.type),
    ["heading_2", "paragraph", "paragraph"],
  );
});

test("conditionally updates Status and Working On", async () => {
  /** Defines the transport fixture for “conditionally updates Status and Working On”. */
  const transport = new MutableTransport();
  transport.seedAgent();
  /** Defines the store fixture for “conditionally updates Status and Working On”. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  /** Defines the receipt fixture for “conditionally updates Status and Working On”. */
  const receipt = await store.updateAgentActivity({
    expectedRunLeaseIds: [],
    expectedTaskIds: [],
    idempotencyKey: "activity-1",
    nextRunLeaseIds: ["lease-1"],
    nextTaskIds: ["task-1"],
    agentId: "agent-1",
  });
  assert.equal(receipt.providerRecord.id, "agent-1");
  assert.equal((await store.getAgentActivity("agent-1")).status, "Online");
  await assert.rejects(
    store.updateAgentActivity({
      expectedRunLeaseIds: [],
      expectedTaskIds: [],
      idempotencyKey: "activity-2",
      nextRunLeaseIds: [],
      nextTaskIds: [],
      agentId: "agent-1",
    }),
    /Working On conflict/u,
  );
});

test("uses one canonical Status value for Task mutation and verification", async () => {
  /** Defines the transport fixture for “uses one canonical Status value for Task mutation and verification”. */
  const transport = new MutableTransport();
  transport.seedTask();
  /** Defines the store fixture for “uses one canonical Status value for Task mutation and verification”. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  await store.applyTaskMutation({
    expectedVersion: "2026-01-01T00:00:01.000Z",
    idempotencyKey: "task-status",
    nextBody: null,
    nextProperties: { Status: "Todo" },
    nextStatus: "Coding",
    taskId: "task-1",
  });
  /** Defines the page fixture for “uses one canonical Status value for Task mutation and verification”. */
  const page = transport.pages.get("task-1");
  assert.equal(propertyValue(required(page), "Status"), "Coding");
  assert.match(
    propertyValue(required(page), "Manager Mutation"),
    /^[a-f0-9]{64}$/u,
  );
});

test("recognizes the exact Error target after an interrupted intent", async () => {
  /** Defines the transport fixture for “recognizes the exact Error target after an interrupted intent”. */
  const transport = new MutableTransport();
  /** Defines the store fixture for “recognizes the exact Error target after an interrupted intent”. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  /** Defines the error fixture for “recognizes the exact Error target after an interrupted intent”. */
  const error = {
    description: "Failure details",
    errorKey: "failure/stable",
    idempotencyKey: "error-write",
    relatedRunId: "run-1",
    relatedAgentId: null,
    relatedTaskId: null,
    resolution: "Repair the environment.",
    severity: "high" as const,
    status: "Not Fixed" as const,
    title: "Stable failure",
  };
  /** Defines the created fixture for “recognizes the exact Error target after an interrupted intent”. */
  const created = await store.createOrUpdateError(error);
  assert.deepEqual(await store.errorTargetReceipt(error), created);
  assert.equal(
    propertyValue(
      required(transport.pages.get(created.providerRecord.id)),
      "Status",
    ),
    "Not Fixed",
  );
  await assert.rejects(
    store.errorTargetReceipt({ ...error, description: "Different details" }),
    /conflicts with newer state/u,
  );
});

/** Extracts a textual property value from a simulated Notion page. */
function propertyValue(page: JsonObject, name: string): string {
  /** Defines the property fixture used by property value. */
  const property = objectValue(objectValue(page.properties)[name]);
  /** Defines the values fixture used by property value. */
  const values = property.title ?? property.rich_text;
  if (Array.isArray(values)) {
    return values
      .map((item) => String(objectValue(objectValue(item).text).content))
      .join("");
  }
  return String(objectValue(property.select).name ?? "");
}

/** Returns a validated JSON object. */
function objectValue(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  return value as JsonObject;
}

/** Returns a fixture value or fails the test. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture value missing");
  return value;
}
