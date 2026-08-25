/** Task body and relation transport fixtures. */
import assert from "node:assert/strict";

import type { JsonObject } from "../../../src/domain/json.js";
import {
  type NotionRequest,
  type NotionTransport,
} from "../../../src/provider/notion/notion-transport.js";
import {
  ids,
  page,
  relationProperty,
  richTextProperty,
  selectProperty,
} from "./common.js";

export class TaskBodyTransport implements NotionTransport {
  /** Task property patch received before the Markdown update. */
  public patch: JsonObject | null = null;
  /** Current Markdown body served by the transport. */
  private markdown = "## Context\n\nOriginal.\n";
  /** Creates a Task fixture under the requested data source. */
  public constructor(private readonly parentId: string = ids.tasks) {}

  /** Routes the reads and writes required by a Task body update. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.method === "GET" && request.path === `/v1/pages/${ids.task}`)
      return page(
        ids.task,
        {
          Dependencies: relationProperty([]),
          Priority: { number: 15, type: "number" },
          Status: selectProperty("In Planning (AI)"),
          Task: richTextProperty("title", "Plan work"),
          Type: selectProperty("Feature"),
        },
        this.parentId,
      );
    if (request.path === `/v1/pages/${ids.task}/markdown`) {
      if (request.method === "GET")
        return {
          markdown: this.markdown,
          truncated: false,
          unknown_block_ids: [],
        };
      assert.ok(
        request.method === "PATCH" &&
          request.body !== undefined &&
          request.body !== null &&
          typeof request.body === "object" &&
          !Array.isArray(request.body),
      );
      this.patch = request.body;
      /** Update captured by the request fixture. */
      const update = request.body.update_content;
      assert.ok(
        update !== undefined &&
          update !== null &&
          typeof update === "object" &&
          !Array.isArray(update),
      );
      /** Content updates captured by the request fixture. */
      const contentUpdates = update.content_updates;
      assert.ok(Array.isArray(contentUpdates) && contentUpdates.length === 1);
      /** Replacement captured by the request fixture. */
      const replacement = contentUpdates[0];
      assert.ok(
        replacement !== undefined &&
          replacement !== null &&
          typeof replacement === "object" &&
          !Array.isArray(replacement) &&
          replacement.old_str === this.markdown &&
          typeof replacement.new_str === "string",
      );
      this.markdown = replacement.new_str;
      return {};
    }
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Serves an empty but complete Markdown representation for a valid Task. */
export class EmptyTaskBodyTransport extends TaskBodyTransport {
  /** Overrides only the Task body read. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (
      request.method === "GET" &&
      request.path === `/v1/pages/${ids.task}/markdown`
    )
      return { markdown: "", truncated: false, unknown_block_ids: [] };
    return super.request(request);
  }
}

/** Marks the otherwise valid Task Dependencies relation as truncated. */
export class TruncatedTaskRelationTransport extends TaskBodyTransport {
  /** Overrides only the Task metadata read. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.method === "GET" && request.path === `/v1/pages/${ids.task}`)
      return page(ids.task, {
        Dependencies: { has_more: true, relation: [], type: "relation" },
        Priority: { number: 15, type: "number" },
        Status: selectProperty("In Planning (AI)"),
        Task: richTextProperty("title", "Plan work"),
        Type: selectProperty("Feature"),
      });
    return super.request(request);
  }
}

/** Fails Error Markdown replacement and records any premature status patch. */
