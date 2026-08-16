/** Verifies canonical safe enhanced Markdown and legacy prompt compatibility. */
import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/core/digest.js";
import {
  canonicalPromptMarkdown,
  promptBodyFromMarkdownResponse,
  promptPageMarkdown,
} from "../src/provider/notion/notion-prompt-markdown.js";

test("accepts the safe enhanced-Markdown prompt subset", () => {
  /** Provides representative supported prompt formatting. */
  const body = [
    "# Role",
    "Read **carefully** and use [the policy](https://example.invalid/policy).",
    "- First requirement",
    "- [ ] Explicit check",
    "> Preserve evidence.",
    "```typescript",
    "const value = 1;",
    "",
    "return value;",
    "```",
  ].join("\n");

  assert.equal(canonicalPromptMarkdown(body), body);
  assert.equal(promptPageMarkdown(body), `## Resource body\n${body}`);
});

test("rejects unknown, external, and non-canonical prompt content", () => {
  assert.throws(
    () =>
      canonicalPromptMarkdown('<page url="https://notion.so/page">Page</page>'),
    /unsafe Notion block tag/u,
  );
  assert.throws(
    () => canonicalPromptMarkdown("![diagram](https://example.invalid/a.png)"),
    /contains an image/u,
  );
  assert.throws(
    () => canonicalPromptMarkdown("First paragraph\n\nSecond paragraph"),
    /must use <empty-block\/>/u,
  );
});

test("validates native Markdown completeness evidence", () => {
  assert.throws(
    () =>
      promptBodyFromMarkdownResponse({
        markdown: "## Resource body\nPrompt",
        object: "page_markdown",
        truncated: true,
        unknown_block_ids: [],
      }),
    /is truncated/u,
  );
  assert.throws(
    () =>
      promptBodyFromMarkdownResponse({
        markdown: '## Resource body\n<unknown alt="form"/>',
        object: "page_markdown",
        truncated: false,
        unknown_block_ids: ["block-1"],
      }),
    /contains unknown blocks/u,
  );
});

test("unwraps a legacy whole-prompt snippet only for its pinned digest", () => {
  /** Represents the previous prompt Resource body projection. */
  const legacyBody = "Shared authority.\n\nRole instructions.";
  /** Models Notion's native Markdown rendering of the legacy code block. */
  const response = {
    markdown: `## Resource body\n\`\`\`plain text\n${legacyBody}\n\`\`\``,
    object: "page_markdown",
    truncated: false,
    unknown_block_ids: [],
  };

  assert.equal(
    promptBodyFromMarkdownResponse(response, sha256(legacyBody)),
    legacyBody,
  );
  assert.equal(
    promptBodyFromMarkdownResponse(response),
    `\`\`\`plain text\n${legacyBody}\n\`\`\``,
  );
});
