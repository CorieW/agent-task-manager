// Keeps the concrete Notion adapter aligned with the provider-neutral contract.
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "../src/domain/json.js";
import type { ProviderEnvironment } from "../src/domain/provider.js";
import type { AgentTaskProvider } from "../src/provider/agent-task-provider.js";
import { NotionProvider } from "../src/provider/notion/notion-provider.js";
import type { NotionRequest, NotionTransport } from "../src/provider/notion/notion-transport.js";

class NoNetworkTransport implements NotionTransport {
  public async request(_request: NotionRequest): Promise<JsonObject> {
    throw new Error("Network should not be used by static validation");
  }
}

test("implements the provider contract and validates Notion environment fields locally", async () => {
  const provider: AgentTaskProvider = new NotionProvider({
    environment: environment(),
    environmentId: "demo",
    transport: new NoNetworkTransport(),
  });
  assert.equal((await provider.getCapabilities()).conditionalWrites, "optimistic");
  assert.equal((await provider.validateEnvironment(environment())).valid, true);
  assert.equal((await provider.validateEnvironment({ ...environment(), type: "other" })).valid, false);
});

function environment(): ProviderEnvironment {
  return {
    bootstrapParent: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    connection: { authEnvironmentVariable: "NOTION_TOKEN" },
    tables: { errors: null, resources: null, subAgents: null, tasks: null },
    type: "notion",
  };
}
