/** Canonical Notion schema for the simplified five-table workspace. */
import { digestJson } from "../../core/digest.js";
import { toJsonValue } from "../../domain/json.js";
import type { TableKind } from "../../domain/provider.js";

/** Canonical shape of one Notion database property. */
export interface NotionPropertyDescriptor {
  /** Human-readable display name. */
  readonly name: string;
  /** Allowed select values for the Notion property. */
  readonly options: readonly string[];
  /** Managed table targeted by a Notion relation property. */
  readonly relation: TableKind | null;
  /** Whether the property must exist in a configured table. */
  readonly required: boolean;
  /** Name of the reverse relation created by Notion. */
  readonly syncedName?: string;
  /** Notion property type. */
  readonly type: string;
}

/** Canonical title and properties for one managed Notion table. */
export interface NotionTableDescriptor {
  /** Domain or protocol classification of the record. */
  readonly kind: TableKind;
  /** Canonical properties in deterministic schema order. */
  readonly properties: readonly NotionPropertyDescriptor[];
  /** Human-readable Notion database title. */
  readonly title: string;
}

/** Builds a non-relation canonical property descriptor. */
const property = (
  name: string,
  type: string,
  required = true,
  options: readonly string[] = [],
): NotionPropertyDescriptor => ({
  name,
  options,
  relation: null,
  required,
  type,
});
/** Builds a canonical relation property descriptor. */
const relationProperty = (
  name: string,
  relation: TableKind,
  syncedName?: string,
): NotionPropertyDescriptor => ({
  name,
  options: [],
  relation,
  required: true,
  ...(syncedName === undefined ? {} : { syncedName }),
  type: "relation",
});

/** Canonical ordered schema for all five managed Notion tables. */
export const NOTION_TABLES: readonly NotionTableDescriptor[] = [
  {
    kind: "tasks",
    title: "Tasks",
    properties: [
      property("Task", "title"),
      property("Type", "select"),
      property("Status", "select"),
      relationProperty("Dependencies", "tasks"),
      property("Priority", "number", false),
    ],
  },
  {
    kind: "resources",
    title: "Resources",
    properties: [
      property("Resource", "title"),
      property("Kind", "select", true, ["Prompt", "Policy"]),
      property("State", "select", true, ["Active", "Draft", "Retired"]),
      property("Owner", "people", false),
      property("Review Date", "date", false),
      property("Source", "url", false),
    ],
  },
  {
    kind: "agents",
    title: "Agents",
    properties: [property("Name", "title")],
  },
  {
    kind: "activeAgents",
    title: "Active Agents",
    properties: [
      property("Run ID", "title"),
      property("Archived", "checkbox"),
      relationProperty("Agent", "agents"),
      property("Agent Version", "rich_text"),
      relationProperty("Task", "tasks", "Active Agents"),
      property("Task ID", "rich_text"),
      relationProperty("Parent", "activeAgents"),
      relationProperty("Restart Of", "activeAgents"),
      property("Retry Key", "rich_text"),
      property("Attempt", "number"),
      property("Status", "select", true, [
        "Running",
        "Failed",
        "Stale",
        "Completed",
        "Stopped",
      ]),
      property("Harness ID", "rich_text"),
      property("Started At", "date"),
      property("Last Heartbeat", "date"),
      property("Finished At", "date"),
      property("Outcome", "rich_text"),
      property("Completion Task Status", "rich_text"),
      property("Failure Summary", "rich_text"),
      property("Working Directory", "rich_text"),
    ],
  },
  {
    kind: "errors",
    title: "Errors",
    properties: [
      property("Error", "title"),
      property("Error Key", "rich_text"),
      property("Source", "select", true, ["Human", "AI", "System"]),
      property("Severity", "select", true, [
        "Critical",
        "High",
        "Medium",
        "Low",
      ]),
      property("Status", "select", true, ["Open", "Resolved"]),
      relationProperty("Task", "tasks"),
      relationProperty("Agent", "agents"),
      relationProperty("Active Agent", "activeAgents"),
      property("Owner", "people", false),
      property("Created At", "created_time", false),
      property("Updated At", "last_edited_time", false),
      property("Fixed At", "date"),
    ],
  },
];

/** Version label included in the canonical Notion schema digest. */
export const NOTION_SCHEMA_VERSION = "notion-workspace-schema-v1";
/** SHA-256 digest of the complete canonical Notion schema. */
export const NOTION_SCHEMA_DIGEST = digestJson(
  toJsonValue({ tables: NOTION_TABLES, version: NOTION_SCHEMA_VERSION }),
);
/** Returns the canonical descriptor for a provider table kind. */
export function notionTable(kind: TableKind): NotionTableDescriptor {
  /** Canonical managed-table descriptor for this operation. */
  const table = NOTION_TABLES.find((entry) => entry.kind === kind);
  if (table === undefined) throw new Error(`Unknown Notion table: ${kind}`);
  return table;
}
