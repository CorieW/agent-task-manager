/** Defines the safe canonical enhanced-Markdown boundary for Notion prompt Resources. */
import { sha256 } from "../../core/digest.js";
import type { JsonObject, JsonValue } from "../../domain/json.js";

/** Exact managed heading that precedes every prompt Resource body. */
const RESOURCE_BODY_HEADING = "## Resource body";

/** Enhanced-Markdown tags that can carry external or nested Notion objects. */
const UNSAFE_BLOCK_TAG =
  /<(?:audio|bookmark|breadcrumb|callout|columns?|database|details|embed|file|meeting-notes|page|pdf|synced_block|table|video)\b/iu;

/** Enhanced-Markdown attributes excluded from the canonical prompt subset. */
const UNSAFE_BLOCK_ATTRIBUTE = /\{(?:color|toggle)=/iu;

/** Encodes one canonical prompt body as a complete managed Notion page body. */
export function promptPageMarkdown(body: string): string {
  /** Validates and normalizes the caller-supplied canonical prompt. */
  const canonicalBody = canonicalPromptMarkdown(body);
  return canonicalBody === ""
    ? RESOURCE_BODY_HEADING
    : `${RESOURCE_BODY_HEADING}\n${canonicalBody}`;
}

/** Validates one canonical prompt body against the supported Markdown subset. */
export function canonicalPromptMarkdown(body: string): string {
  /** Normalizes line endings and Unicode before structural validation. */
  const normalized = normalizeMarkdown(body);
  if (normalized === "") return normalized;
  if (normalized.startsWith("\n") || normalized.endsWith("\n")) {
    throw new Error("Prompt Markdown must not start or end with a blank line");
  }

  /** Tracks whether validation is currently inside a fenced code block. */
  let codeFenceOpen = false;
  for (const line of normalized.split("\n")) {
    if (/^```[A-Za-z0-9+.#_-]*(?: [A-Za-z0-9+.#_-]+)*$/u.test(line)) {
      codeFenceOpen = !codeFenceOpen;
      continue;
    }
    if (codeFenceOpen) continue;
    if (line === "") {
      throw new Error(
        "Prompt Markdown must use <empty-block/> for an intentional empty block",
      );
    }
    /** Removes list nesting before checking reserved top-level syntax. */
    const content = line.replace(/^\t+/u, "");
    if (content === RESOURCE_BODY_HEADING) {
      throw new Error("Prompt Markdown must not redefine ## Resource body");
    }
    assertSafeMarkdownLine(content);
  }
  if (codeFenceOpen) {
    throw new Error("Prompt Markdown contains an unclosed code fence");
  }
  return normalized;
}

/** Extracts and validates a prompt body from a native Notion Markdown response. */
export function promptBodyFromMarkdownResponse(
  response: JsonObject,
  expectedLegacyDigest: string | null = null,
): string {
  if (response.object !== "page_markdown") {
    throw new TypeError("Notion prompt response must be page_markdown");
  }
  if (response.truncated !== false) {
    throw new Error("Notion prompt Markdown response is truncated");
  }
  if (
    !Array.isArray(response.unknown_block_ids) ||
    response.unknown_block_ids.some((id) => typeof id !== "string")
  ) {
    throw new TypeError(
      "Notion prompt Markdown response has invalid unknown block evidence",
    );
  }
  if (response.unknown_block_ids.length !== 0) {
    throw new Error("Notion prompt Markdown contains unknown blocks");
  }
  return promptBodyFromPageMarkdown(
    requiredString(response.markdown, "Notion prompt Markdown"),
    expectedLegacyDigest,
  );
}

/** Extracts one managed prompt body from complete native Notion Markdown. */
export function promptBodyFromPageMarkdown(
  markdown: string,
  expectedLegacyDigest: string | null = null,
): string {
  /** Normalizes the provider response before locating the managed heading. */
  const normalized = normalizeMarkdown(markdown);
  if (normalized === RESOURCE_BODY_HEADING) return "";
  if (!normalized.startsWith(`${RESOURCE_BODY_HEADING}\n`)) {
    throw new Error(
      "Prompt Resource must start with exactly one ## Resource body heading",
    );
  }
  /** Selects the canonical Markdown following the managed heading. */
  const body = normalized.slice(RESOURCE_BODY_HEADING.length + 1);
  /** Detects the prior whole-prompt plain-text code-block representation. */
  const legacy = /^```(?:plain text|text)\n([\s\S]*)\n```$/u.exec(body);
  if (
    legacy?.[1] !== undefined &&
    expectedLegacyDigest !== null &&
    sha256(normalizeMarkdown(legacy[1])) === expectedLegacyDigest
  ) {
    return normalizeMarkdown(legacy[1]);
  }
  return canonicalPromptMarkdown(body);
}

/** Rejects one non-code line outside the approved enhanced-Markdown subset. */
function assertSafeMarkdownLine(line: string): void {
  if (UNSAFE_BLOCK_TAG.test(line)) {
    throw new Error("Prompt Markdown contains an unsafe Notion block tag");
  }
  if (/<(?:unknown|mention-)/iu.test(line)) {
    throw new Error("Prompt Markdown contains an unresolved Notion identity");
  }
  if (/!\[[^\]]*\]\(/u.test(line)) {
    throw new Error("Prompt Markdown contains an image");
  }
  if (UNSAFE_BLOCK_ATTRIBUTE.test(line)) {
    throw new Error("Prompt Markdown contains unsupported block attributes");
  }
  if (/<(?!\/?(?:br|empty-block)\/?\s*>)[A-Za-z/]/u.test(line)) {
    throw new Error("Prompt Markdown contains unsupported markup");
  }
}

/** Normalizes provider Markdown for stable comparisons and SHA-256 digests. */
function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/gu, "\n").normalize("NFC");
}

/** Returns a required non-empty string or throws a closed-boundary error. */
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}
