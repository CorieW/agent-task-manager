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

const PARENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

class EmptyWorkspaceTransport implements NotionTransport {
  readonly requests: NotionRequest[] = [];

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

test("plans Resources-first bootstrap with deferred relations and no writes", async () => {
  const transport = new EmptyWorkspaceTransport();
  const target = createNotionWorkspaceSchema();
  const manager = new NotionWorkspaceManager(
    "demo",
    environment(),
    target,
    transport,
    () => new Date(0),
  );
  const observed = await manager.inspectWorkspaceSchema();
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
    ["resources", "errors", "tasks", "subAgents"],
  );
  const lastCreate = plan.steps.findLastIndex(
    (step) => step.kind === "create_table",
  );
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
  const transport: NotionTransport = {
    async request(request) {
      if (request.path === "/v1/search") {
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
  const manager = new NotionWorkspaceManager(
    "demo",
    environment(),
    createNotionWorkspaceSchema(),
    transport,
    () => new Date(0),
  );
  const snapshot = await manager.inspectWorkspaceSchema();
  assert.equal(snapshot.tables[0]?.kind, "resources");
});

function environment(): ProviderEnvironment {
  return {
    bootstrapParent: PARENT,
    connection: { authEnvironmentVariable: "NOTION_TOKEN" },
    tables: { errors: null, resources: null, subAgents: null, tasks: null },
    type: "notion",
  };
}
