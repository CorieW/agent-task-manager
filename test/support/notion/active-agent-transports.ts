/** Active Agent lifecycle transport fixtures. */
import assert from "node:assert/strict";

import type { JsonObject } from "../../../src/domain/json.js";
import {
  type NotionRequest,
  type NotionTransport,
} from "../../../src/provider/notion/notion-transport.js";
import {
  activeAgentLifecyclePage,
  activeAgentWorkingDirectory,
  dateProperty,
  ids,
  pageResults,
  richTextProperty,
  selectProperty,
} from "./common.js";

export class ActiveAgentLifecycleTransport implements NotionTransport {
  /** Active Agent property patches received by the transport. */
  public readonly patches: JsonObject[] = [];
  /** Whether the served Active Agent no longer relates to its Task. */
  private detached = false;
  /** Whether the served row is retained as an archived Run-ID tombstone. */
  private archived = false;

  /** Routes lifecycle query and patch requests for one Active Agent. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`)
      return pageResults([
        activeAgentLifecyclePage(
          this.detached ? [] : [ids.task],
          this.archived,
        ),
      ]);
    if (
      request.method === "PATCH" &&
      request.path === `/v1/pages/${ids.childRun}`
    ) {
      assert.ok(
        request.body !== undefined &&
          request.body !== null &&
          typeof request.body === "object" &&
          !Array.isArray(request.body),
      );
      this.patches.push(request.body);
      this.detached = true;
      /** Active Agent property payload captured from the terminal update. */
      const properties = request.body.properties;
      if (
        properties !== null &&
        typeof properties === "object" &&
        !Array.isArray(properties)
      ) {
        /** Archived checkbox payload inspected independently from Task detachment. */
        const archived = properties.Archived;
        if (
          archived !== null &&
          typeof archived === "object" &&
          !Array.isArray(archived) &&
          archived.checkbox === true
        )
          this.archived = true;
      }
      return activeAgentLifecyclePage([], this.archived);
    }
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Returns an authoritative update while indexed Active Agent queries stay stale. */
export class StaleActiveAgentUpdateTransport implements NotionTransport {
  /** Number of indexed Active Agent lookups made by the provider. */
  public queryCount = 0;

  /** Routes one stale pre-read and one authoritative update response. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`) {
      this.queryCount += 1;
      return pageResults([activeAgentLifecyclePage([ids.task])]);
    }
    if (
      request.method === "PATCH" &&
      request.path === `/v1/pages/${ids.childRun}`
    )
      return {
        ...activeAgentLifecyclePage([], false, {
          "Finished At": dateProperty("2026-08-17T12:01:00.000Z"),
          Outcome: richTextProperty("rich_text", "completed work"),
          Status: selectProperty("Completed"),
        }),
        last_edited_time: "2026-08-17T12:01:00.000Z",
      };
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Captures the properties used to create an Active Agent page. */
export class ActiveAgentCreationTransport implements NotionTransport {
  /** Properties from the most recent Active Agent creation request. */
  public createdProperties: JsonObject | null = null;
  /** Number of indexed Active Agent lookups made by the provider. */
  public queryCount = 0;

  /** Routes Active Agent lookup and creation requests. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`) {
      this.queryCount += 1;
      return pageResults([]);
    }
    if (request.method === "POST" && request.path === "/v1/pages") {
      assert.ok(
        request.body !== undefined &&
          request.body !== null &&
          typeof request.body === "object" &&
          !Array.isArray(request.body),
      );
      /** Properties captured by the request fixture. */
      const properties = request.body.properties;
      assert.ok(
        properties !== undefined &&
          properties !== null &&
          typeof properties === "object" &&
          !Array.isArray(properties),
      );
      this.createdProperties = properties;
      return activeAgentLifecyclePage([ids.task], false, {
        "Working Directory": richTextProperty(
          "rich_text",
          activeAgentWorkingDirectory,
        ),
      });
    }
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Captures optimistic Task-property and Markdown-body updates. */
