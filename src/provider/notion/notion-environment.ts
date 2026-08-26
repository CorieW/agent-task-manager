/** Strict configuration boundary owned by the Notion provider adapter. */
import type { JsonObject, JsonValue } from "../../domain/json.js";
import { NOTION_TABLE_KINDS, type NotionTableKind } from "./notion-schema.js";

/** Provider options accepted by the Notion adapter. */
export interface NotionProviderOptions {
  /** Notion page under which missing managed databases are created. */
  readonly bootstrapParent: string | null;
  /** Notion connection settings such as the token environment-variable name. */
  readonly connection: JsonObject;
  /** Configured Notion data-source IDs keyed by managed record family. */
  readonly tables: Readonly<Record<NotionTableKind, string | null>>;
}

/** Strictly parses opaque provider options as Notion configuration. */
export function parseNotionProviderOptions(
  options: JsonObject,
): NotionProviderOptions {
  /** Adapter-specific validation issues accumulated before rejection. */
  const issues: string[] = [];
  rejectUnknownKeys(
    options,
    ["connection", "bootstrapParent", "tables"],
    "provider.options",
    issues,
  );
  /** Provider connection settings retained as strict JSON. */
  const connection = objectValue(
    options.connection,
    "provider.options.connection",
    issues,
  );
  /** Optional parent page used for additive workspace bootstrap. */
  const bootstrapParent = nullableString(
    options.bootstrapParent,
    "provider.options.bootstrapParent",
    issues,
  );
  /** Untyped data-source mapping before strict ID validation. */
  const rawTables = objectValue(
    options.tables,
    "provider.options.tables",
    issues,
  );
  rejectUnknownKeys(
    rawTables,
    NOTION_TABLE_KINDS,
    "provider.options.tables",
    issues,
  );
  /** Complete nullable table mapping in canonical order. */
  const tables = Object.fromEntries(
    NOTION_TABLE_KINDS.map((kind) => [
      kind,
      nullableString(
        rawTables[kind],
        `provider.options.tables.${kind}`,
        issues,
      ),
    ]),
  ) as Record<NotionTableKind, string | null>;
  if (issues.length > 0)
    throw new TypeError(
      `Invalid Notion provider options:\n- ${issues.join("\n- ")}`,
    );
  return { bootstrapParent, connection, tables };
}

/** Requires a JSON object at one adapter-owned path. */
function objectValue(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  return value;
}

/** Parses a required nullable string. */
function nullableString(
  value: JsonValue | undefined,
  path: string,
  issues: string[],
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path} must be null or a non-empty string`);
    return null;
  }
  return value;
}

/** Rejects adapter options outside one exact object contract. */
function rejectUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  /** Allowlisted keys accepted at this boundary. */
  const keys = new Set(allowed);
  for (const key of Object.keys(value))
    if (!keys.has(key)) issues.push(`${path}.${key} is not allowed`);
}
