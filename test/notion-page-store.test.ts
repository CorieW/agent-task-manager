/** Verifies provider-owned Notion writes are uniquely addressed and post-verified. */
import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/core/digest.js";
import type { JsonObject } from "../src/domain/json.js";
import { NotionPageStore } from "../src/provider/notion/notion-page-store.js";
import {
  decodeResourceKindOption,
  encodeResourceKindOption,
  ERROR_SEVERITY_OPTIONS,
  RESOURCE_KIND_OPTIONS,
  RESOURCE_STATE_OPTIONS,
} from "../src/provider/notion/notion-option-codec.js";
import type {
  NotionRequest,
  NotionTransport,
} from "../src/provider/notion/notion-transport.js";

/** Maps logical tables to stable fake provider identifiers. */
const TABLES = {
  errors: "errors",
  operations: "operations",
  resources: "resources",
  agents: "agents",
  tasks: "tasks",
};

/** Implements mutable transport. */
class MutableTransport implements NotionTransport {
  /** Stores managed child blocks by their parent Notion page. */
  public readonly blocks = new Map<string, JsonObject[]>();
  /** Stores complete native Markdown replacements by Notion page. */
  public readonly markdown = new Map<string, string>();
  /** Stores mutable fake Notion pages by identifier. */
  public readonly pages = new Map<string, JsonObject>();
  /** Records every page-store request for preflight assertions. */
  public readonly requests: NotionRequest[] = [];
  /** Keeps a patched Task at its prior opaque version to model Notion timestamp coalescing. */
  public freezeTaskVersion = false;
  /** Advances fake Notion versions after each mutation. */
  #version = 0;

  /** Executes one provider request. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    this.requests.push(request);
    /** Decodes the Notion query request under simulation. */
    const query = /^\/v1\/data_sources\/(\w+)\/query$/u.exec(request.path);
    if (query?.[1] !== undefined) {
      /** Decodes the Notion query filter under simulation. */
      const filter = objectValue(request.body).filter;
      /** Normalizes the filter payload for predicate matching. */
      const filterObject = objectValue(filter);
      /** Identifies the Notion property constrained by the query. */
      const property = String(filterObject.property);
      /** Extracts the title equality operand from the filter. */
      const titleEquals = objectValue(filterObject.title).equals;
      /** Extracts the rich-text equality operand from the filter. */
      const richTextEquals = objectValue(filterObject.rich_text).equals;
      /** Extracts the select equality operand from the filter. */
      const selectEquals = objectValue(filterObject.select).equals;
      /** Extracts the scalar value from the simulated Notion filter. */
      const equals =
        typeof titleEquals === "string"
          ? titleEquals
          : typeof richTextEquals === "string"
            ? richTextEquals
            : String(selectEquals);
      /** Collects operation outcomes used by assertions. */
      const results = [...this.pages.values()].filter(
        (page) =>
          objectValue(page.parent).data_source_id === query[1] &&
          propertyValue(page, property) === equals,
      );
      return { has_more: false, next_cursor: null, results };
    }
    if (request.method === "POST" && request.path === "/v1/pages") {
      /** Decodes the request body consumed by the fake transport. */
      const body = objectValue(request.body);
      /** Extracts the Notion page identifier targeted by the request. */
      const id = `page-${this.pages.size + 1}`;
      /** Reads the persisted Notion row used as the assertion oracle. */
      const page = this.newPage(
        id,
        String(objectValue(body.parent).data_source_id),
        objectValue(body.properties),
      );
      this.pages.set(id, page);
      this.blocks.set(
        id,
        Array.isArray(body.children)
          ? (body.children as JsonObject[]).map((block, index) => ({
              ...block,
              id: `${id}-block-${index}`,
            }))
          : [],
      );
      if (typeof body.markdown === "string") {
        this.markdown.set(id, body.markdown);
      }
      return page;
    }
    /** Defines the native Markdown endpoint match. */
    const markdownMatch = /^\/v1\/pages\/(.+)\/markdown$/u.exec(request.path);
    if (markdownMatch?.[1] !== undefined) {
      /** Identifies the page read or updated through native Markdown. */
      const pageId = markdownMatch[1];
      if (request.method === "PATCH") {
        /** Reads the replacement Markdown command. */
        const body = objectValue(request.body);
        /** Reads the complete replacement page Markdown. */
        const newString = objectValue(body.replace_content).new_str;
        if (body.type !== "replace_content" || typeof newString !== "string") {
          throw new TypeError("Invalid Markdown replacement fixture");
        }
        this.markdown.set(pageId, newString);
      }
      /** Reads the current canonical page Markdown. */
      const markdown = this.markdown.get(pageId);
      if (markdown === undefined) {
        throw new Error(`Markdown fixture is missing for ${pageId}`);
      }
      return {
        id: pageId,
        markdown,
        object: "page_markdown",
        truncated: false,
        unknown_block_ids: [],
      };
    }
    /** Parses a page endpoint in the fake Notion transport. */
    const pageMatch = /^\/v1\/pages\/(.+)$/u.exec(request.path);
    if (pageMatch?.[1] !== undefined) {
      /** Reads the persisted Notion row used as the assertion oracle. */
      const page = required(this.pages.get(pageMatch[1]));
      if (request.method === "GET") return page;
      /** Decodes the request body consumed by the fake transport. */
      const body = objectValue(request.body);
      /** Preserves the page properties before applying updates. */
      const priorProperties = objectValue(page.properties);
      /** Collects normalized Notion property updates. */
      const updates = Object.fromEntries(
        Object.entries(objectValue(body.properties)).map(([name, value]) => {
          /** Decodes one Notion property update. */
          const update = objectValue(value);
          /** Reads the prior value of one Notion property. */
          const prior = objectValue(priorProperties[name]);
          /** Identifies the Notion property type being updated. */
          const type =
            typeof prior.type === "string"
              ? prior.type
              : (Object.keys(update)[0] ?? "unknown");
          return [name, { ...prior, ...update, type }];
        }),
      );
      /** Builds the provider state expected after applying the update. */
      const next = this.newPage(
        pageMatch[1],
        String(objectValue(page.parent).data_source_id),
        { ...priorProperties, ...updates },
      );
      if (this.freezeTaskVersion && pageMatch[1] === "task-1")
        next.last_edited_time = String(page.last_edited_time);
      this.pages.set(pageMatch[1], next);
      return next;
    }
    /** Collects child blocks returned or appended by the fake transport. */
    const children = /^\/v1\/blocks\/(.+)\/children$/u.exec(request.path);
    if (children?.[1] !== undefined && request.method === "GET") {
      return {
        has_more: false,
        next_cursor: null,
        results: this.blocks.get(children[1]) ?? [],
      };
    }
    if (children?.[1] !== undefined && request.method === "PATCH") {
      /** Reads the managed blocks present before replacement. */
      const existing = this.blocks.get(children[1]) ?? [];
      /** Collects blocks appended by the simulated Notion request. */
      const added = (objectValue(request.body).children as JsonObject[]).map(
        (item, index) => ({
          ...item,
          id: `${children[1]}-block-${existing.length + index}`,
        }),
      );
      this.blocks.set(children[1], [...existing, ...added]);
      /** Reads the persisted Notion row used as the assertion oracle. */
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
    /** Identifies the managed block targeted by the fake request. */
    const block = /^\/v1\/blocks\/(.+)$/u.exec(request.path);
    if (block?.[1] !== undefined && request.method === "PATCH") {
      for (const [pageId, blocks] of this.blocks) {
        /** Locates the managed block updated by the fake transport. */
        const index = blocks.findIndex(
          (candidate) => candidate.id === block[1],
        );
        if (index >= 0) {
          if (objectValue(request.body).in_trash === true) {
            blocks.splice(index, 1);
            return { id: block[1], in_trash: true };
          }
          /** Tracks the mutable simulated clock or current record state. */
          const current = required(blocks[index]);
          blocks[index] = { ...current, ...objectValue(request.body) };
          /** Reads the persisted Notion row used as the assertion oracle. */
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
        Labels: {
          id: "labels",
          multi_select: [{ name: "Product" }, { name: "Planning" }],
          type: "multi_select",
        },
        "Created At": {
          created_time: "2026-01-01T00:00:00.000Z",
          id: "created-at",
          type: "created_time",
        },
        Owner: { id: "owner", people: [], type: "people" },
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

  /** Builds and stores a fake Notion page with normalized properties. */
  private newPage(
    id: string,
    parent: string,
    properties: JsonObject,
  ): JsonObject {
    this.#version += 1;
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
      last_edited_time: `2026-01-01T00:00:${String(this.#version).padStart(2, "0")}.000Z`,
      object: "page",
      parent: { data_source_id: parent, type: "data_source_id" },
      properties: normalized,
    };
  }
}

test("creates one managed Resource row and verifies its content", async () => {
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new MutableTransport();
  /** Exercises provider-backed persistence for the scenario. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  /** Captures the durable write or effect result used as the oracle. */
  const receipt = await store.createResource({
    body: "### Policy\n- First rule",
    dependencies: [],
    digest: sha256("### Policy\n- First rule"),
    idempotencyKey: "write-1",
    key: "policy/example",
    kind: "policy",
    state: "active",
    version: "v1",
  });
  assert.equal(receipt.providerRecord.table, "resources");
  assert.equal(
    transport.markdown.get(receipt.providerRecord.id),
    "## Resource body\n### Policy\n- First rule",
  );
  assert.equal(transport.pages.size, 1);
  /** Reads the created row to verify its canonical option values. */
  const page = required(transport.pages.get(receipt.providerRecord.id));
  assert.equal(propertyValue(page, "Kind"), "Policy");
  assert.equal(propertyValue(page, "State"), "Active");
});

test("supports the child-agent context Resource kind", () => {
  assert.equal(encodeResourceKindOption("agent/context"), "Agent / Context");
  assert.equal(decodeResourceKindOption("Agent / Context"), "agent/context");
  assert.deepEqual(RESOURCE_KIND_OPTIONS, [
    "Prompt",
    "Policy",
    "Task Query",
    "JSON Schema",
    "Invocation Schedule",
    "Agent / Context",
  ]);
  assert.deepEqual(RESOURCE_STATE_OPTIONS, ["Active", "Draft", "Retired"]);
  assert.deepEqual(ERROR_SEVERITY_OPTIONS, [
    "Critical",
    "High",
    "Medium",
    "Low",
  ]);
});

test("rejects a noncanonical Resource before provider mutation", async () => {
  /** Captures Notion requests to prove rejection happens preflight. */
  const transport = new MutableTransport();
  /** Applies Resource validation before reaching the fake transport. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  await assert.rejects(
    store.createResource({
      body: "Line one\r\nLine two",
      dependencies: [],
      digest: sha256("Line one\r\nLine two"),
      idempotencyKey: "bad-digest",
      key: "prompt/bad",
      kind: "prompt",
      state: "active",
      version: "v1",
    }),
    /body and Digest must be canonical/u,
  );
  assert.equal(transport.requests.length, 0);
});

test("rebuilds readable Resources into machine-readable bodies", async () => {
  /** Stores both readable Markdown and machine-managed block forms. */
  const transport = new MutableTransport();
  /** Exercises representation-aware Resource replacement. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  await store.createResource({
    body: "Readable policy.",
    dependencies: [],
    digest: sha256("Readable policy."),
    idempotencyKey: "readable",
    key: "policy/conversion",
    kind: "policy",
    state: "active",
    version: "v1",
  });
  /** Supplies canonical JSON for the replacement machine Resource. */
  const machineBody = '{"type":"object"}';
  await store.createResource({
    body: machineBody,
    dependencies: [],
    digest: sha256(machineBody),
    idempotencyKey: "machine",
    key: "policy/conversion",
    kind: "json-schema",
    state: "active",
    version: "v2",
  });

  /** Reads the final managed blocks used as the replacement oracle. */
  const blocks = transport.blocks.get("page-1") ?? [];
  assert.equal(blocks.length, 2);
  assert.equal(
    propertyValue(required(transport.pages.get("page-1")), "Kind"),
    "JSON Schema",
  );
});

test("rebuilds a machine Resource into readable Markdown", async () => {
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
    kind: "json-schema",
    state: "active",
    version: "v1",
  });

  await store.createResource({
    body: "Readable first paragraph.\nReadable second paragraph.",
    dependencies: [],
    digest: sha256("Readable first paragraph.\nReadable second paragraph."),
    idempotencyKey: "write-readable",
    key: "prompt/example",
    kind: "prompt",
    state: "active",
    version: "v2",
  });

  assert.equal(
    transport.markdown.get("page-1"),
    "## Resource body\nReadable first paragraph.\nReadable second paragraph.",
  );
});

test("conditionally updates Status and Working On", async () => {
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new MutableTransport();
  transport.seedAgent();
  /** Exercises provider-backed persistence for the scenario. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  /** Captures the durable write or effect result used as the oracle. */
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
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new MutableTransport();
  transport.seedTask();
  transport.freezeTaskVersion = true;
  /** Exercises provider-backed persistence for the scenario. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  await store.applyTaskMutation({
    expectedVersion: "2026-01-01T00:00:01.000Z",
    idempotencyKey: "task-status",
    nextBody: null,
    nextProperties: {
      "Created At": "2026-01-01T00:00:00.000Z",
      Labels: [
        { color: "default", id: "product", name: "Product" },
        { color: "default", id: "planning", name: "Planning" },
      ],
      Owner: [],
      Status: "Todo",
    },
    nextStatus: "Coding",
    taskId: "task-1",
  });
  /** Reads the persisted Notion row used as the assertion oracle. */
  const page = transport.pages.get("task-1");
  assert.equal(propertyValue(required(page), "Status"), "Coding");
  assert.deepEqual(
    objectValue(objectValue(required(page).properties).Labels).multi_select,
    [{ name: "Product" }, { name: "Planning" }],
  );
  assert.match(
    propertyValue(required(page), "Manager Mutation"),
    /^[a-f0-9]{64}$/u,
  );
});

test("recognizes the exact Error target after an interrupted intent", async () => {
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new MutableTransport();
  /** Exercises provider-backed persistence for the scenario. */
  const store = new NotionPageStore(TABLES, transport, () => new Date(0));
  /** Describes the Error mutation used to test reconciliation. */
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
  /** Captures the Error row created before interrupted reconciliation. */
  const created = await store.createOrUpdateError(error);
  assert.deepEqual(await store.errorTargetReceipt(error), created);
  assert.equal(
    propertyValue(
      required(transport.pages.get(created.providerRecord.id)),
      "Status",
    ),
    "Not Fixed",
  );
  assert.equal(
    propertyValue(
      required(transport.pages.get(created.providerRecord.id)),
      "Severity",
    ),
    "High",
  );
  await assert.rejects(
    store.errorTargetReceipt({ ...error, description: "Different details" }),
    /conflicts with newer state/u,
  );
});

/** Extracts a textual property value from a simulated Notion page. */
function propertyValue(page: JsonObject, name: string): string {
  /** Identifies the Notion property constrained by the query. */
  const property = objectValue(objectValue(page.properties)[name]);
  /** Collects plain text extracted from a Notion property. */
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
