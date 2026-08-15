// Verifies bootstrap planning is read-only, ordered, and digest-authorized.
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "../src/domain/json.js";
import type { ProviderEnvironment } from "../src/domain/provider.js";
import { createNotionWorkspaceSchema } from "../src/provider/notion/notion-schema.js";
import type { NotionRequest, NotionTransport } from "../src/provider/notion/notion-transport.js";
import { NotionWorkspaceManager } from "../src/provider/notion/notion-workspace-manager.js";

const PARENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

class EmptyWorkspaceTransport implements NotionTransport {
  readonly requests: NotionRequest[] = [];

  public async request(request: NotionRequest): Promise<JsonObject> {
    this.requests.push(request);
    if (request.path === "/v1/search") return { has_more: false, next_cursor: null, results: [] };
    if (request.path === "/v1/users/me") return { id: "bot", object: "user" };
    throw new Error(`Read-only plan attempted ${request.method} ${request.path}`);
  }
}

test("plans Resources-first bootstrap with deferred relations and no writes", async () => {
  const transport = new EmptyWorkspaceTransport();
  const target = createNotionWorkspaceSchema();
  const manager = new NotionWorkspaceManager("demo", environment(), target, transport, () => new Date(0));
  const observed = await manager.inspectWorkspaceSchema();
  const plan = await manager.planWorkspaceChanges({ environmentId: "demo", mode: "bootstrap", observed, target });
  assert.deepEqual(
    plan.steps.filter((step) => step.kind === "create_table").map((step) => step.payload.kind),
    ["resources", "errors", "tasks", "subAgents"],
  );
  const lastCreate = plan.steps.findLastIndex((step) => step.kind === "create_table");
  const firstRelation = plan.steps.findIndex((step) => step.kind === "add_relation");
  assert.ok(firstRelation > lastCreate);
  assert.equal(plan.steps.at(-1)?.kind, "record_schema_state");
  assert.equal(plan.steps[0]?.expectedPreSchemaDigest, observed.digest);
  assert.equal(plan.steps[1]?.expectedPreSchemaDigest, null);
  assert.equal(transport.requests.every((request) => request.method === "GET" || request.path === "/v1/search"), true);
});

function environment(): ProviderEnvironment {
  return {
    bootstrapParent: PARENT,
    connection: { authEnvironmentVariable: "NOTION_TOKEN" },
    tables: { errors: null, resources: null, subAgents: null, tasks: null },
    type: "notion",
  };
}
