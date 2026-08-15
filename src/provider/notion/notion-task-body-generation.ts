// Defines the single parser and ordering rule for append-only Notion Task bodies.
import type { JsonObject, JsonValue } from "../../domain/json.js";
import { NOTION_TASK_MUTATION_CAPTION_PREFIX } from "./notion-schema.js";

export interface NotionTaskBodyGeneration {
  readonly block: JsonObject;
  readonly body: string;
  readonly digest: string;
}

export function activeTaskBodyGeneration(blocks: readonly JsonObject[]): NotionTaskBodyGeneration | null {
  const generations = blocks.map(taskBodyGeneration).filter((value): value is NotionTaskBodyGeneration => value !== null);
  return generations.at(-1) ?? null;
}

export function taskBodyGeneration(block: JsonObject): NotionTaskBodyGeneration | null {
  if (block.type !== "code") return null;
  const code = objectValue(block.code);
  if (code.language !== "markdown") return null;
  const caption = richTextValue(code.caption);
  if (!caption.startsWith(NOTION_TASK_MUTATION_CAPTION_PREFIX)) return null;
  const digest = caption.slice(NOTION_TASK_MUTATION_CAPTION_PREFIX.length);
  if (!/^[a-f0-9]{64}$/u.test(digest)) return null;
  return { block, body: richTextValue(code.rich_text).replace(/\r\n?/gu, "\n").normalize("NFC"), digest };
}

function objectValue(value: JsonValue | undefined): JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function richTextValue(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const object = objectValue(item);
    if (typeof object.plain_text === "string") return object.plain_text;
    const text = objectValue(object.text);
    return typeof text.content === "string" ? text.content : "";
  }).join("").normalize("NFC");
}
