/** Canonical Notion schema for the simplified five-table workspace. */
import { digestJson } from "../../core/digest.js";
import { toJsonValue } from "../../domain/json.js";
import type { TableKind } from "../../domain/provider.js";

export interface NotionPropertyDescriptor {
  readonly name: string;
  readonly options: readonly string[];
  readonly relation: TableKind | null;
  readonly required: boolean;
  readonly syncedName?: string;
  readonly type: string;
}
export interface NotionTableDescriptor {
  readonly kind: TableKind;
  readonly properties: readonly NotionPropertyDescriptor[];
  readonly title: string;
}
const p = (
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
const r = (
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

export const NOTION_TABLES: readonly NotionTableDescriptor[] = [
  {
    kind: "tasks",
    title: "Tasks",
    properties: [
      p("Task", "title"),
      p("Status", "select", true, [
        "Backlog",
        "Ready",
        "Planned",
        "In progress",
        "Blocked",
        "In review",
        "Completed",
        "Cancelled",
        "Duplicate",
        "Not reproducible",
        "Superseded",
      ]),
      r("Dependencies", "tasks"),
      p("Priority", "number", false),
    ],
  },
  {
    kind: "resources",
    title: "Resources",
    properties: [
      p("Resource", "title"),
      p("Kind", "select", true, ["Prompt", "Policy"]),
      p("State", "select", true, ["Active", "Draft", "Retired"]),
      p("Owner", "people", false),
      p("Review Date", "date", false),
      p("Source", "url", false),
    ],
  },
  {
    kind: "agents",
    title: "Agents",
    properties: [p("Name", "title")],
  },
  {
    kind: "activeAgents",
    title: "Active Agents",
    properties: [
      p("Run ID", "title"),
      r("Agent", "agents"),
      p("Agent Version", "rich_text"),
      r("Task", "tasks", "Active Agents"),
      r("Parent", "activeAgents"),
      r("Restart Of", "activeAgents"),
      p("Retry Key", "rich_text"),
      p("Attempt", "number"),
      p("Status", "select", true, [
        "Running",
        "Failed",
        "Stale",
        "Completed",
        "Stopped",
      ]),
      p("Harness ID", "rich_text"),
      p("Started At", "date"),
      p("Last Heartbeat", "date"),
      p("Finished At", "date", false),
      p("Outcome", "rich_text", false),
      p("Failure Summary", "rich_text", false),
    ],
  },
  {
    kind: "errors",
    title: "Errors",
    properties: [
      p("Error", "title"),
      p("Error Key", "rich_text"),
      p("Source", "select", true, ["Human", "AI", "System"]),
      p("Severity", "select", true, ["Critical", "High", "Medium", "Low"]),
      p("Status", "select", true, ["Open", "Resolved"]),
      r("Task", "tasks"),
      r("Agent", "agents"),
      r("Active Agent", "activeAgents"),
      p("Owner", "people", false),
      p("Created At", "created_time", false),
      p("Updated At", "last_edited_time", false),
      p("Fixed At", "date", false),
    ],
  },
];

export const NOTION_SCHEMA_VERSION = "notion-workspace-schema-v6";
export const NOTION_SCHEMA_DIGEST = digestJson(
  toJsonValue({ tables: NOTION_TABLES, version: NOTION_SCHEMA_VERSION }),
);
export function notionTable(kind: TableKind): NotionTableDescriptor {
  const table = NOTION_TABLES.find((entry) => entry.kind === kind);
  if (table === undefined) throw new Error(`Unknown Notion table: ${kind}`);
  return table;
}
