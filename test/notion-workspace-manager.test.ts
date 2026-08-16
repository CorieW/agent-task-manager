/** Verifies bootstrap planning is read-only, ordered, and digest-authorized. */
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "../src/domain/json.js";
import type { ProviderEnvironment } from "../src/domain/provider.js";
import { createNotionWorkspaceSchema } from "../src/provider/notion/notion-schema.js";
import type {
  NotionRequest,
  NotionTransport,
} from "../src/provider/notion/notion-transport.js";
import { NotionWorkspaceManager } from "../src/provider/notion/notion-workspace-manager.js";

/** Identifies the fake Notion parent page used during provisioning. */
const PARENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/** Implements empty workspace transport. */
class EmptyWorkspaceTransport implements NotionTransport {
  /** Records provisioning requests sent to the empty fake workspace. */
  readonly requests: NotionRequest[] = [];

  /** Executes one provider request. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    this.requests.push(request);
    if (request.path === "/v1/search")
      return { has_more: false, next_cursor: null, results: [] };
    if (request.path === "/v1/users/me") return { id: "bot", object: "user" };
    throw new Error(
      `Read-only plan attempted ${request.method} ${request.path}`,
    );
  }
}

test("plans Operations-first bootstrap with deferred relations and no writes", async () => {
  /** Captures and simulates Notion requests for the scenario. */
  const transport = new EmptyWorkspaceTransport();
  /** Supplies the canonical workspace schema target. */
  const target = createNotionWorkspaceSchema();
  /** Coordinates the human-recovery workflow under test. */
  const manager = new NotionWorkspaceManager(
    "demo",
    environment(),
    target,
    transport,
    () => new Date(0),
  );
  /** Captures observed state used as the assertion oracle. */
  const observed = await manager.inspectWorkspaceSchema();
  /** Captures the workspace changes proposed by the provider. */
  const plan = await manager.planWorkspaceChanges({
    environmentId: "demo",
    mode: "bootstrap",
    observed,
    target,
  });
  assert.deepEqual(
    plan.steps
      .filter((step) => step.kind === "create_table")
      .map((step) => step.payload.kind),
    ["operations", "resources", "errors", "tasks", "agents"],
  );
  /** Tracks the last page-creation request for assertions. */
  const lastCreate = plan.steps.findLastIndex(
    (step) => step.kind === "create_table",
  );
  /** Captures the first page of a paginated relation. */
  const firstRelation = plan.steps.findIndex(
    (step) => step.kind === "add_relation",
  );
  assert.ok(firstRelation > lastCreate);
  assert.equal(plan.steps.at(-1)?.kind, "record_schema_state");
  assert.equal(plan.steps[0]?.expectedPreSchemaDigest, observed.digest);
  assert.equal(
    plan.steps[1]?.expectedPreSchemaDigest,
    plan.steps[0]?.expectedPostSchemaDigest,
  );
  assert.equal(
    transport.requests.every(
      (request) => request.method === "GET" || request.path === "/v1/search",
    ),
    true,
  );
});

test("rediscovers current data-source search results under the configured parent", async () => {
  /** Captures and simulates Notion requests for the scenario. */
  const transport: NotionTransport = {
    /** Simulates one provider transport request. */
    async request(request) {
      if (request.path === "/v1/search") {
        /** Decodes the request body consumed by the fake transport. */
        const body =
          request.body !== null &&
          typeof request.body === "object" &&
          !Array.isArray(request.body)
            ? request.body
            : {};
        return body.query === "Resources"
          ? {
              has_more: false,
              next_cursor: null,
              results: [
                {
                  id: "11111111-1111-1111-1111-111111111111",
                  object: "data_source",
                  parent: {
                    database_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    type: "database_id",
                  },
                  title: [{ plain_text: "Resources" }],
                },
              ],
            }
          : { has_more: false, next_cursor: null, results: [] };
      }
      if (
        request.path === "/v1/databases/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
      ) {
        return {
          id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          object: "database",
          parent: { page_id: PARENT, type: "page_id" },
        };
      }
      if (request.path === "/v1/users/me") return { id: "bot", object: "user" };
      if (
        request.path === "/v1/data_sources/11111111-1111-1111-1111-111111111111"
      ) {
        return {
          id: "11111111-1111-1111-1111-111111111111",
          object: "data_source",
          properties: {},
          title: [{ plain_text: "Resources" }],
        };
      }
      throw new Error(`Unexpected ${request.method} ${request.path}`);
    },
  };
  /** Coordinates the human-recovery workflow under test. */
  const manager = new NotionWorkspaceManager(
    "demo",
    environment(),
    createNotionWorkspaceSchema(),
    transport,
    () => new Date(0),
  );
  /** Captures the canonical workspace state used as the oracle. */
  const snapshot = await manager.inspectWorkspaceSchema();
  assert.equal(snapshot.tables[0]?.kind, "resources");
});

/** Creates a provider environment fixture. */
function environment(): ProviderEnvironment {
  return {
    bootstrapParent: PARENT,
    connection: { authEnvironmentVariable: "NOTION_TOKEN" },
    tables: { errors: null, resources: null, agents: null, tasks: null },
    type: "notion",
  };
}
