/** Error Markdown and resolution transport fixtures. */
import assert from "node:assert/strict";

import type { JsonObject } from "../../../src/domain/json.js";
import {
  type NotionRequest,
  type NotionTransport,
} from "../../../src/provider/notion/notion-transport.js";
import {
  dateProperty,
  ids,
  page,
  pageResults,
  relationProperty,
  richTextProperty,
  selectProperty,
} from "./common.js";

/** Fails Error Markdown replacement while recording premature status updates. */
export class FailingErrorResolutionTransport implements NotionTransport {
  /** Number of Error property patches attempted by the provider. */
  public statusPatches = 0;

  /** Routes the reads and failed write required by Error resolution. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.errors}/query`)
      return pageResults([
        page(ids.badAgent, {
          "Active Agent": relationProperty([]),
          Agent: relationProperty([]),
          Error: richTextProperty("title", "Retry blocked"),
          "Error Key": richTextProperty("rich_text", "retry-chain"),
          "Fixed At": dateProperty(null),
          Severity: selectProperty("High"),
          Source: selectProperty("System"),
          Status: selectProperty("Open"),
          Task: relationProperty([]),
        }),
      ]);
    if (request.path === `/v1/pages/${ids.badAgent}/markdown`) {
      if (request.method === "GET")
        return {
          markdown:
            "## Error Description\n\nRetry limit reached.\n\n## Error Resolution\n\n",
          truncated: false,
          unknown_block_ids: [],
        };
      throw new Error("Markdown update failed");
    }
    if (request.path === `/v1/pages/${ids.badAgent}`) {
      this.statusPatches += 1;
      return {};
    }
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Captures newly created Error Markdown and serves it back for decoding. */
export class ErrorRoundTripTransport implements NotionTransport {
  /** Source select label captured from the create-page request. */
  public createdSource: string | null = null;
  /** Text-fragment lengths captured from the Error title payload. */
  public createdTitleFragmentLengths: number[] = [];
  /** Canonical Markdown captured from the create-page request. */
  private markdown: string | null = null;

  /** Routes the create/read sequence used by Error reporting. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.errors}/query`)
      return pageResults(
        this.markdown === null
          ? []
          : [
              page(ids.badAgent, {
                "Active Agent": relationProperty([]),
                Agent: relationProperty([]),
                Error: richTextProperty("title", "Heading-safe Error"),
                "Error Key": richTextProperty(
                  "rich_text",
                  "heading-round-trip",
                ),
                "Fixed At": dateProperty(null),
                Severity: selectProperty("Medium"),
                Source: selectProperty("AI"),
                Status: selectProperty("Open"),
                Task: relationProperty([]),
              }),
            ],
      );
    if (request.method === "POST" && request.path === "/v1/pages") {
      assert.ok(
        request.body !== undefined &&
          request.body !== null &&
          typeof request.body === "object" &&
          !Array.isArray(request.body) &&
          typeof request.body.markdown === "string",
      );
      this.markdown = request.body.markdown;
      /** Created Error properties captured to verify canonical select labels. */
      const properties = request.body.properties;
      assert.ok(
        properties !== null &&
          typeof properties === "object" &&
          !Array.isArray(properties),
      );
      /** Source property captured from the create payload. */
      const source = properties.Source;
      assert.ok(
        source !== null && typeof source === "object" && !Array.isArray(source),
      );
      /** Selected Source option captured from the property. */
      const selected = source.select;
      assert.ok(
        selected !== null &&
          typeof selected === "object" &&
          !Array.isArray(selected) &&
          typeof selected.name === "string",
      );
      this.createdSource = selected.name;
      /** Error title property captured from the create payload. */
      const errorTitle = properties.Error;
      assert.ok(
        errorTitle !== null &&
          typeof errorTitle === "object" &&
          !Array.isArray(errorTitle) &&
          Array.isArray(errorTitle.title),
      );
      this.createdTitleFragmentLengths = errorTitle.title.map((entry) => {
        assert.ok(
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
        );
        /** Text object captured from one title fragment. */
        const text = entry.text;
        assert.ok(text !== null && typeof text === "object");
        assert.ok(!Array.isArray(text) && typeof text.content === "string");
        return text.content.length;
      });
      return { id: ids.badAgent };
    }
    if (request.path === `/v1/pages/${ids.badAgent}/markdown`)
      return {
        markdown: this.markdown ?? "",
        truncated: false,
        unknown_block_ids: [],
      };
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}
