/** Verifies canonical safe enhanced Markdown for readable Resources and legacy compatibility. */
import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/core/digest.js";
import {
  canonicalResourceMarkdown,
  isMarkdownResourceKind,
  resourceBodyFromMarkdownResponse,
  resourcePageMarkdown,
} from "../src/provider/notion/notion-resource-markdown.js";

test("selects prompt and policy Resources for native Markdown", () => {
  assert.equal(isMarkdownResourceKind("prompt"), true);
  assert.equal(isMarkdownResourceKind("policy"), true);
  assert.equal(isMarkdownResourceKind("json-schema"), false);
});

test("accepts the safe enhanced-Markdown Resource subset", () => {
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

  assert.equal(canonicalResourceMarkdown(body), body);
  assert.equal(resourcePageMarkdown(body), `## Resource body\n${body}`);
});

test("rejects unknown, external, and non-canonical Resource content", () => {
  assert.throws(
    () =>
      canonicalResourceMarkdown(
        '<page url="https://notion.so/page">Page</page>',
      ),
    /unsafe Notion block tag/u,
  );
  assert.throws(
    () =>
      canonicalResourceMarkdown("![diagram](https://example.invalid/a.png)"),
    /contains an image/u,
  );
  assert.throws(
    () => canonicalResourceMarkdown("First paragraph\n\nSecond paragraph"),
    /must use <empty-block\/>/u,
  );
});

test("validates native Markdown completeness evidence", () => {
  assert.throws(
    () =>
      resourceBodyFromMarkdownResponse({
        markdown: "## Resource body\nPrompt",
        object: "page_markdown",
        truncated: true,
        unknown_block_ids: [],
      }),
    /is truncated/u,
  );
  assert.throws(
    () =>
      resourceBodyFromMarkdownResponse({
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
    resourceBodyFromMarkdownResponse(response, sha256(legacyBody)),
    legacyBody,
  );
  assert.equal(
    resourceBodyFromMarkdownResponse(response),
    `\`\`\`plain text\n${legacyBody}\n\`\`\``,
  );
});
