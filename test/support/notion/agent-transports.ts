/** Agent loading and workspace transport fixtures. */
import assert from "node:assert/strict";

import type { JsonObject } from "../../../src/domain/json.js";
import type { NotionTableKind } from "../../../src/provider/notion/notion-schema.js";
import { NOTION_TABLES } from "../../../src/provider/notion/notion-schema.js";
import {
  NotionApiError,
  type NotionRequest,
  type NotionTransport,
} from "../../../src/provider/notion/notion-transport.js";
import {
  activeAgentPage,
  agentMarkdown,
  ids,
  page,
  pageResults,
  resourcePage,
  richTextProperty,
  selectProperty,
} from "./common.js";

/** Rejects every Notion request with one stable error instance. */
export class FailingTransport implements NotionTransport {
  /** Creates a transport around the failure expected by the scenario. */
  public constructor(
    /** Exact error propagated by every request. */
    private readonly failure: Error,
  ) {}

  /** Rejects without wrapping so tests can assert error identity. */
  public async request(_request: NotionRequest): Promise<JsonObject> {
    throw this.failure;
  }
}

/** Serves deterministic Agent metadata, body, and Resource responses. */
export class AgentBodyTransport implements NotionTransport {
  /** Creates an instance with its required collaborators. */
  public constructor(
    /** Optional schema property mutation applied to one managed table fixture. */
    private readonly propertyOverride?: {
      /** Name captured by the record fixture. */
      readonly name: string;
      /** Canonical managed-table descriptor for the current operation. */
      readonly table: NotionTableKind;
      /** Type captured by the record fixture. */
      readonly type: string | null;
    },
  ) {}

  /** Routes the Notion requests used to hydrate an Agent record. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (
      request.method === "GET" &&
      request.path.startsWith("/v1/data_sources/")
    ) {
      /** Source ID captured by the request fixture. */
      const sourceId = request.path.split("/").at(-1);
      /** Canonical managed-table descriptor for the current operation. */
      const table = NOTION_TABLES.find((entry) => ids[entry.kind] === sourceId);
      if (table !== undefined) {
        /** Properties captured by the request fixture. */
        const properties: JsonObject = Object.fromEntries(
          table.properties.map((property) => [
            property.name,
            {
              type: property.type,
              ...(property.relation === null
                ? {}
                : {
                    relation: {
                      data_source_id: ids[property.relation],
                      ...(property.syncedName === undefined
                        ? { single_property: {} }
                        : {
                            dual_property: {
                              synced_property_name: property.syncedName,
                            },
                          }),
                    },
                  }),
              ...(property.type === "select" && property.options.length > 0
                ? {
                    select: {
                      options: property.options.map((name) => ({ name })),
                    },
                  }
                : {}),
            },
          ]),
        );
        if (this.propertyOverride?.table === table.kind) {
          if (this.propertyOverride.type === null)
            delete properties[this.propertyOverride.name];
          else
            properties[this.propertyOverride.name] = {
              type: this.propertyOverride.type,
            };
        }
        return { properties };
      }
    }
    if (request.path === `/v1/data_sources/${ids.agents}/query`)
      return pageResults([
        page(
          ids.agent,
          {
            Name: richTextProperty("title", "Code Reviewer"),
          },
          ids.agents,
        ),
        page(
          ids.badAgent,
          {
            Name: richTextProperty("title", "Broken Draft"),
          },
          ids.agents,
        ),
      ]);
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`)
      return pageResults([
        activeAgentPage(ids.childRun, "child", ids.parentRun, ids.restartRun),
      ]);
    if (request.path === `/v1/data_sources/${ids.resources}/query`)
      return pageResults([
        resourcePage(ids.prompt, "prompt/code-reviewer", "Prompt"),
        resourcePage(ids.policy, "agent-policy/review", "Policy"),
        resourcePage(ids.schema, "schema/result-v1", "Schema"),
      ]);
    if (request.path === `/v1/pages/${ids.agent}/markdown`)
      return {
        markdown: agentMarkdown('{"exclusion":[]}'),
        truncated: false,
        unknown_block_ids: [],
      };
    if (request.path === `/v1/pages/${ids.agent}`)
      return page(
        ids.agent,
        {
          Name: richTextProperty("title", "Code Reviewer"),
        },
        ids.agents,
      );
    if (request.path === `/v1/pages/${ids.badAgent}/markdown`)
      return {
        markdown: "## Agent definition\n\n```json\nnot json\n```",
        truncated: false,
        unknown_block_ids: [],
      };
    if (request.path === `/v1/pages/${ids.badAgent}`)
      return page(
        ids.badAgent,
        {
          Name: richTextProperty("title", "Broken Draft"),
        },
        ids.agents,
      );
    if (request.path === "/v1/pages/88888888888888888888888888888888")
      throw new NotionApiError("gone", 404, "object_not_found", null);
    if (request.path === `/v1/pages/${ids.parentRun}`)
      return activeAgentPage(ids.parentRun, "root");
    if (request.path === `/v1/pages/${ids.restartRun}`)
      return activeAgentPage(ids.restartRun, "failed");
    if (request.path === `/v1/pages/${ids.prompt}/markdown`)
      return {
        markdown: "Review the code.",
        truncated: false,
        unknown_block_ids: [],
      };
    if (request.path === `/v1/pages/${ids.policy}/markdown`)
      return {
        markdown: "Apply review policy.",
        truncated: false,
        unknown_block_ids: [],
      };
    if (request.path === `/v1/pages/${ids.schema}/markdown`)
      return {
        markdown: "Use result schema v1.",
        truncated: false,
        unknown_block_ids: [],
      };
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Serves a structurally complete Active Agent with an invalid status. */
export class InvalidActiveAgentTransport extends AgentBodyTransport {
  /** Overrides only the Active Agents query used by the regression. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`) {
      /** Complete fixture whose status is replaced with an unknown label. */
      const run = activeAgentPage(ids.childRun, "child");
      assert.ok(
        run.properties !== null &&
          typeof run.properties === "object" &&
          !Array.isArray(run.properties),
      );
      return pageResults([
        {
          ...run,
          properties: {
            ...run.properties,
            Status: selectProperty("Paused"),
          },
        },
      ]);
    }
    return super.request(request);
  }
}

/** Serves one pre-existing canonical Tasks database under the bootstrap page. */
export class ExistingTableDiscoveryTransport extends AgentBodyTransport {
  /** Routes bootstrap discovery before delegating schema inspection. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (
      request.path ===
      `/v1/blocks/ffffffffffffffffffffffffffffffff/children?page_size=100`
    )
      return pageResults([
        {
          child_database: { title: "Tasks" },
          id: ids.parentRun,
          in_trash: false,
          type: "child_database",
        },
      ]);
    if (request.path === `/v1/databases/${ids.parentRun}`)
      return { data_sources: [{ id: ids.tasks }] };
    return super.request(request);
  }
}

/** Simulates metadata changing between the body read and consistency check. */
export class TornAgentBodyTransport extends AgentBodyTransport {
  /** Returns a changed Agent version after the first metadata read. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/pages/${ids.agent}`)
      return {
        ...page(ids.agent, {
          Name: richTextProperty("title", "Code Reviewer"),
        }),
        last_edited_time: "2026-08-17T13:00:00.000Z",
      };
    return super.request(request);
  }
}

/** Changes an Agent body without changing its Notion timestamp. */
export class SameTimestampAgentBodyTransport extends AgentBodyTransport {
  /** Whether subsequent body reads return the permissive command policy. */
  public permissive = false;

  /** Switches the served command policy while retaining metadata timestamps. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/pages/${ids.agent}/markdown`)
      return {
        markdown: agentMarkdown(
          this.permissive ? '{"exclusion":[]}' : '{"inclusion":["git"]}',
        ),
        truncated: false,
        unknown_block_ids: [],
      };
    return super.request(request);
  }
}

/** Serves an Agent body with Notion's explicit incompleteness marker. */
export class TruncatedAgentBodyTransport extends AgentBodyTransport {
  /** Returns incomplete Markdown for the otherwise valid Agent fixture. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/pages/${ids.agent}/markdown`)
      return {
        markdown: agentMarkdown('{"exclusion":[]}'),
        truncated: true,
        unknown_block_ids: [ids.prompt],
      };
    return super.request(request);
  }
}
