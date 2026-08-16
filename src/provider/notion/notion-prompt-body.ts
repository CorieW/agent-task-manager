/** Encodes prompt Resources as readable Notion paragraphs while preserving exact text digests. */
import type { JsonObject, JsonValue } from "../../domain/json.js";

/** Maximum number of rich-text characters accepted by one Notion text item. */
const RICH_TEXT_CHUNK_SIZE = 2_000;

/** Converts one canonical prompt body into ordinary Notion paragraph blocks. */
export function promptBodyBlocks(body: string): readonly JsonObject[] {
  return normalizePromptBody(body)
    .split("\n\n")
    .map((paragraph) => ({
      object: "block",
      paragraph: { rich_text: richText(paragraph) },
      type: "paragraph",
    }));
}

/** Reconstructs one canonical prompt body from readable or legacy Notion blocks. */
export function promptBodyText(blocks: readonly JsonObject[]): string {
  /** Selects the first managed prompt-content block. */
  const first = blocks[0];
  if (first === undefined) {
    throw new Error("## Resource body must contain prompt content");
  }

  if (first.type === "code") {
    if (blocks.slice(1).some((block) => !isEmptyParagraph(block))) {
      throw new Error("Legacy prompt Resource body contains unmanaged blocks");
    }
    return normalizePromptBody(blockText(first));
  }

  if (blocks.some((block) => block.type !== "paragraph")) {
    throw new Error(
      "Prompt Resource body supports only ordinary paragraph blocks",
    );
  }
  return normalizePromptBody(blocks.map(blockText).join("\n\n"));
}

/** Normalizes prompt text before storage, hashing, or comparison. */
export function normalizePromptBody(body: string): string {
  return body.replace(/\r\n?/gu, "\n").normalize("NFC");
}

/** Reports whether a block is an empty paragraph inserted by the Notion editor. */
function isEmptyParagraph(block: JsonObject): boolean {
  return block.type === "paragraph" && blockText(block) === "";
}

/** Builds Notion rich text without exceeding the per-item character limit. */
function richText(text: string): JsonValue[] {
  if (text === "") return [];
  /** Collects bounded rich-text chunks in source order. */
  const chunks: JsonValue[] = [];
  for (let index = 0; index < text.length; index += RICH_TEXT_CHUNK_SIZE) {
    chunks.push({
      text: { content: text.slice(index, index + RICH_TEXT_CHUNK_SIZE) },
      type: "text",
    });
  }
  return chunks;
}

/** Extracts normalized plain text from a supported Notion content block. */
function blockText(block: JsonObject): string {
  /** Identifies the type-specific block payload. */
  const type = requiredString(block.type, "Block type");
  /** Reads the block's rich-text collection. */
  const richTextValue = objectValue(block[type], `Block ${type}`).rich_text;
  if (!Array.isArray(richTextValue)) return "";
  return richTextValue
    .map((item) => {
      /** Reads one Notion rich-text item. */
      const object = objectValue(item, "Rich text item");
      if (typeof object.plain_text === "string") return object.plain_text;
      return requiredString(
        objectValue(object.text, "Rich text value").content,
        "Rich text content",
      );
    })
    .join("")
    .normalize("NFC");
}

/** Returns a non-array JSON object or throws a closed-boundary error. */
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

/** Returns a required non-empty string or throws a closed-boundary error. */
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}
