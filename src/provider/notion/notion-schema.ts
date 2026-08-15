// Defines the provider-owned minimum schema for a Notion workspace.
import { digestJson } from "../../core/digest.js";
import { toJsonValue } from "../../domain/json.js";
import type { TableDescriptor, WorkspaceSchemaDescriptor } from "../../domain/schema.js";

const TABLES: readonly TableDescriptor[] = [
  {
    kind: "resources",
    managedRanges: ["## Resource body"],
    properties: [
      property("key", "Resource", "title"),
      property("kind", "Kind", "select"),
      property("version", "Version", "rich_text"),
      property("digest", "Digest", "rich_text"),
      property("state", "State", "select"),
      property("dependencies", "Dependencies", "rich_text"),
    ],
    title: "Resources",
  },
  {
    kind: "errors",
    managedRanges: ["## Error Description", "## Error Resolution"],
    properties: [
      property("title", "Error", "title"),
      property("errorKey", "Error Key", "rich_text"),
      property("severity", "Severity", "select"),
      relation("task", "Task", "tasks"),
      relation("subAgent", "Sub-agent", "subAgents"),
      property("runId", "Run ID", "rich_text", false),
    ],
    title: "Errors",
  },
  {
    kind: "tasks",
    managedRanges: [],
    properties: [
      property("title", "Task", "title"),
      property("status", "Status", "status"),
      property("priority", "Priority", "number", false),
      relation("blockedBy", "Blocked By", "tasks", false),
      property("issueOrPr", "Issue / PR", "url", false),
    ],
    title: "Tasks",
  },
  {
    kind: "subAgents",
    managedRanges: ["## Sub-agent definition"],
    properties: [
      property("name", "Name", "title"),
      property("enabled", "Enabled", "checkbox"),
      property("revision", "Revision", "number"),
      property("model", "Model", "rich_text"),
      property("status", "Status", "select"),
      relation("workingOn", "Working On", "tasks"),
      property("lastRun", "Last Run", "last_edited_time", true, false),
    ],
    title: "Sub-agents",
  },
];

export function createNotionWorkspaceSchema(): WorkspaceSchemaDescriptor {
  const core = {
    providerType: "notion",
    tables: TABLES,
    version: "notion-workspace-schema-v1",
  };
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

function property(
  logicalName: string,
  physicalName: string,
  type: string,
  required = true,
  writable = true,
) {
  return { logicalName, physicalName, required, targetTable: null, type, writable } as const;
}

function relation(
  logicalName: string,
  physicalName: string,
  targetTable: "subAgents" | "tasks",
  required = true,
) {
  return { logicalName, physicalName, required, targetTable, type: "relation", writable: true } as const;
}
