/** Provider-neutral the single parser and ordering rule for append-only Notion Task bodies contract. */
import { isSha256Digest } from "../../core/digest.js";
import type { JsonObject, JsonValue } from "../../domain/json.js";
import { NOTION_TASK_MUTATION_CAPTION_PREFIX } from "./notion-schema.js";

/** Provider-neutral Notion task body generation contract. */
export interface NotionTaskBodyGeneration {
  /** Notion block containing the selected Task body generation. */
  readonly block: JsonObject;
  /** Canonical body extracted from the selected generation. */
  readonly body: string;
  /** Binds Notion task body generation to canonical record content. */
  readonly digest: string;
}

/** Decodes active task body generation from managed Task-body content. */
export function activeTaskBodyGeneration(
  blocks: readonly JsonObject[],
): NotionTaskBodyGeneration | null {
  /** Derived generations value for `activeTaskBodyGeneration`. */
  const generations = blocks
    .map(taskBodyGeneration)
    .filter((value): value is NotionTaskBodyGeneration => value !== null);
  return generations.at(-1) ?? null;
}

/** Builds body generation. */
export function taskBodyGeneration(
  block: JsonObject,
): NotionTaskBodyGeneration | null {
  if (block.type !== "code") return null;
  /** Result of `objectValue`, retained for `taskBodyGeneration`. */
  const code = objectValue(block.code);
  if (code.language !== "markdown") return null;
  /** Result of `richTextValue`, retained for `taskBodyGeneration`. */
  const caption = richTextValue(code.caption);
  if (!caption.startsWith(NOTION_TASK_MUTATION_CAPTION_PREFIX)) return null;
  /** Result of `caption.slice`, retained for `taskBodyGeneration`. */
  const digest = caption.slice(NOTION_TASK_MUTATION_CAPTION_PREFIX.length);
  if (!isSha256Digest(digest)) return null;
  return {
    block,
    body: richTextValue(code.rich_text)
      .replace(/\r\n?/gu, "\n")
      .normalize("NFC"),
    digest,
  };
}

/** Returns a validated JSON object. */
function objectValue(value: JsonValue | undefined): JsonObject {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

/** Converts text value. */
function richTextValue(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      /** Result of `objectValue`, retained for `richTextValue`. */
      const object = objectValue(item);
      if (typeof object.plain_text === "string") return object.plain_text;
      /** Result of `objectValue`, retained for `richTextValue`. */
      const text = objectValue(object.text);
      return typeof text.content === "string" ? text.content : "";
    })
    .join("")
    .normalize("NFC");
}
