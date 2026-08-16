/** Verifies Notion transport and schema discovery without requiring a live workspace. */
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "../src/domain/json.js";
import type { ProviderEnvironment } from "../src/domain/provider.js";
import { createNotionWorkspaceSchema } from "../src/provider/notion/notion-schema.js";
import {
  NOTION_API_VERSION,
  NotionHttpTransport,
  collectNotionPages,
  type NotionRequest,
  type NotionTransport,
} from "../src/provider/notion/notion-transport.js";
import {
  NotionWorkspaceReader,
  normalizeNotionIdentifier,
} from "../src/provider/notion/notion-workspace-reader.js";

/** Supplies stable fake Notion data-source identifiers. */
const IDS = {
  errors: "22222222-2222-2222-2222-222222222222",
  resources: "11111111-1111-1111-1111-111111111111",
  agents: "44444444-4444-4444-4444-444444444444",
  tasks: "33333333-3333-3333-3333-333333333333",
} as const;

/** Implements fake transport. */
class FakeTransport implements NotionTransport {
  /** Records every request issued while inspecting the fake workspace. */
  public readonly requests: NotionRequest[] = [];

  /** Executes one provider request. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    this.requests.push(request);
    if (request.path === "/v1/users/me") {
      return { bot: { workspace_name: "Demo" }, id: "bot-1", object: "user" };
    }
    /** Parses the fake Notion endpoint requested by the reader. */
    const match = /^\/v1\/data_sources\/(.+)$/u.exec(request.path);
    if (match?.[1] !== undefined) {
      /** Extracts the Notion object kind routed by the fake transport. */
      const kind = Object.entries(IDS).find(([, id]) => id === match[1])?.[0];
      assert.ok(kind);
      return source(match[1], kind);
    }
    throw new Error(`Unexpected request: ${request.path}`);
  }
}

test("normalizes Notion URLs and collection identifiers", () => {
  assert.equal(
    normalizeNotionIdentifier(`collection://${IDS.tasks.replaceAll("-", "")}`),
    IDS.tasks,
  );
  assert.equal(
    normalizeNotionIdentifier(
      `https://notion.so/Tasks-${IDS.tasks.replaceAll("-", "")}?v=abc`,
    ),
    IDS.tasks,
  );
  assert.throws(() => normalizeNotionIdentifier("not-an-id"));
});

test("collects every Notion page and rejects broken cursors", async () => {
  /** Records cursors visited during pagination. */
  const seen: Array<string | null> = [];
  /** Collects all paginated Notion rows. */
  const rows = await collectNotionPages(async (cursor) => {
    seen.push(cursor);
    return cursor === null
      ? { has_more: true, next_cursor: "next", results: [{ id: "one" }] }
      : { has_more: false, next_cursor: null, results: [{ id: "two" }] };
  });
  assert.deepEqual(seen, [null, "next"]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["one", "two"],
  );
  await assert.rejects(
    collectNotionPages(async () => ({
      has_more: true,
      next_cursor: null,
      results: [],
    })),
    /omitted next_cursor/u,
  );
});

test("uses authenticated, versioned Notion HTTP requests without exposing tokens", async () => {
  /** Captures observed state used as the assertion oracle. */
  let observed: Request | undefined;
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new NotionHttpTransport({
    fetch: async (input, init) => {
      observed = new Request(input, init);
      return Response.json(
        { code: "object_not_found", message: "missing", object: "error" },
        { status: 404 },
      );
    },
    token: "secret-token",
  });
  await assert.rejects(
    transport.request({ method: "GET", path: "/v1/data_sources/missing" }),
    (error) => {
      assert.equal(String(error).includes("secret-token"), false);
      return true;
    },
  );
  assert.equal(observed?.headers.get("Notion-Version"), NOTION_API_VERSION);
  assert.equal(observed?.headers.get("Authorization"), "Bearer secret-token");
});

test("inspects all configured tables into a canonical snapshot", async () => {
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new FakeTransport();
  /** Reads provider records through the fake Notion transport. */
  const reader = new NotionWorkspaceReader(
    environment(),
    createNotionWorkspaceSchema(),
    transport,
    () => new Date(0),
  );
  /** Captures the canonical workspace state used as the oracle. */
  const snapshot = await reader.inspectWorkspaceSchema();
  assert.equal(snapshot.providerIdentity, "bot-1:Demo");
  assert.equal(snapshot.tables.length, 4);
  assert.equal(
    snapshot.tables
      .find((table) => table.kind === "agents")
      ?.properties.find((property) => property.name === "Last Run")?.writable,
    false,
  );
  assert.equal(
    snapshot.tables
      .find((table) => table.kind === "agents")
      ?.properties.find((property) => property.name === "Working On")
      ?.targetTableId,
    IDS.tasks,
  );
  assert.equal(transport.requests.length, 9);
});

test("rejects logical tables that alias one physical data source", async () => {
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new FakeTransport();
  /** Maps two logical tables to the same invalid data source. */
  const aliased = {
    ...environment(),
    tables: {
      errors: IDS.resources,
      resources: IDS.resources,
      agents: IDS.resources,
      tasks: IDS.resources,
    },
  };
  /** Reads provider records through the fake Notion transport. */
  const reader = new NotionWorkspaceReader(
    aliased,
    createNotionWorkspaceSchema(),
    transport,
  );
  await assert.rejects(
    reader.inspectWorkspaceSchema(),
    /must use distinct data sources/u,
  );
});

test("aborts Notion HTTP calls at the configured deadline", async () => {
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new NotionHttpTransport({
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
    timeoutMilliseconds: 5,
    token: "token",
  });
  await assert.rejects(
    transport.request({ method: "GET", path: "/v1/users/me" }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "request_timeout",
  );
});

/** Creates a provider environment fixture. */
function environment(): ProviderEnvironment {
  return {
    bootstrapParent: null,
    connection: { authEnvironmentVariable: "NOTION_TOKEN" },
    tables: IDS,
    type: "notion",
  };
}

/** Builds a fake Notion data-source response. */
function source(id: string, kind: string): JsonObject {
  /** Provides the shared Notion data-source metadata. */
  const common = {
    id,
    last_edited_time: "2026-01-01T00:00:00.000Z",
    object: "data_source",
    title: [{ plain_text: kind }],
  };
  if (kind === "agents") {
    return {
      ...common,
      properties: {
        Enabled: { checkbox: {}, id: "enabled", type: "checkbox" },
        "Last Run": {
          id: "last-run",
          last_edited_time: {},
          type: "last_edited_time",
        },
        Model: { id: "model", rich_text: {}, type: "rich_text" },
        Name: { id: "title", title: {}, type: "title" },
        Revision: { id: "revision", number: {}, type: "number" },
        Status: { id: "status", select: {}, type: "select" },
        "Working On": {
          id: "working",
          relation: { data_source_id: IDS.tasks },
          type: "relation",
        },
      },
    };
  }
  return {
    ...common,
    properties: { [kind]: { id: "title", title: {}, type: "title" } },
  };
}
