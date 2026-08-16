/** Verifies the exact readable and legacy representations of Notion prompt Resources. */
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "../src/domain/json.js";
import {
  promptBodyBlocks,
  promptBodyText,
} from "../src/provider/notion/notion-prompt-body.js";

test("round-trips canonical prompt paragraphs without a snippet", () => {
  /** Provides representative multi-paragraph prompt text. */
  const body = "Shared authority paragraph.\n\nRole-specific paragraph.";
  /** Encodes the prompt into its Notion body representation. */
  const blocks = promptBodyBlocks(body);

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["paragraph", "paragraph"],
  );
  assert.equal(promptBodyText(blocks), body);
});

test("reads a legacy prompt code block until its next authorized write", () => {
  /** Models the prior snippet representation plus an editor-created empty block. */
  const blocks: JsonObject[] = [
    {
      code: {
        language: "plain text",
        rich_text: [{ plain_text: "Legacy prompt" }],
      },
      type: "code",
    },
    { paragraph: { rich_text: [] }, type: "paragraph" },
  ];

  assert.equal(promptBodyText(blocks), "Legacy prompt");
});

test("rejects unmanaged block types in a readable prompt", () => {
  assert.throws(
    () =>
      promptBodyText([
        {
          bulleted_list_item: { rich_text: [{ plain_text: "Unmanaged" }] },
          type: "bulleted_list_item",
        },
      ]),
    /supports only ordinary paragraph blocks/u,
  );
});
