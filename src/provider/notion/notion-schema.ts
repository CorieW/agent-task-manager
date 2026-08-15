// Defines the provider-owned minimum schema for a Notion workspace.
import { digestJson } from "../../core/digest.js";
import { toJsonValue } from "../../domain/json.js";
import type { TableDescriptor, WorkspaceSchemaDescriptor } from "../../domain/schema.js";

export const NOTION_TASK_MUTATION_PROPERTY = "Manager Mutation";
export const NOTION_TASK_MUTATION_CAPTION_PREFIX = "agent-task-manager:task-mutation:";

const TABLES: readonly TableDescriptor[] = [
  {
    kind: "resources",
    managedRanges: [],
    properties: [
      property("key", "Resource", "title"),
      property("kind", "Kind", "select"),
      property("version", "Version", "rich_text"),
      property("digest", "Digest", "rich_text"),
      property("state", "State", "select"),
      property("dependencies", "Dependencies", "rich_text"),
      property("owner", "Owner", "people"),
      property("source", "Source", "url"),
      property("reviewDate", "Review Date", "date"),
    ],
    title: "Resources",
  },
  {
    kind: "errors",
    managedRanges: [],
    properties: [
      property("title", "Error", "title"),
      property("errorKey", "Error Key", "rich_text"),
      property("severity", "Severity", "select"),
      property("status", "Status", "select"),
      relation("task", "Task", "tasks"),
      relation("subAgent", "Sub-agent", "subAgents"),
      property("runId", "Run ID", "rich_text", false),
      property("owner", "Owner", "people"),
      property("githubLinks", "GitHub Links", "rich_text"),
      property("createdAt", "Created At", "created_time", true, false),
      property("fixedAt", "Fixed At", "date"),
    ],
    title: "Errors",
  },
  {
    kind: "tasks",
    managedRanges: [],
    properties: [
      property("title", "Task", "title"),
      property("status", "Status", "select"),
      property("resolution", "Resolution", "select"),
      property("managerMutation", NOTION_TASK_MUTATION_PROPERTY, "rich_text"),
      property("type", "Type", "select"),
      property("priority", "Priority", "number"),
      property("scope", "Scope", "rich_text"),
      property("acceptanceCriteria", "Acceptance Criteria", "rich_text"),
      relation("dependencies", "Dependencies", "tasks"),
      property("githubLinks", "GitHub Links", "rich_text"),
      property("owner", "Owner", "people"),
      property("requiredApproval", "Required Approval", "rich_text"),
      property("outcomeSummary", "Outcome Summary", "rich_text"),
      property("createdAt", "Created At", "created_time", true, false),
      property("closedAt", "Closed At", "date"),
    ],
    title: "Tasks",
  },
  {
    kind: "subAgents",
    managedRanges: [],
    properties: [
      property("name", "Name", "title"),
      property("enabled", "Enabled", "checkbox"),
      property("revision", "Revision", "number"),
      property("model", "Model", "rich_text"),
      property("status", "Status", "select"),
      relation("workingOn", "Working On", "tasks"),
      property("lastRun", "Last Run", "last_edited_time", true, false),
      property("responsibilities", "Responsibilities", "rich_text"),
      property("boundaries", "Boundaries", "rich_text"),
    ],
    title: "Sub-agents",
  },
];

export function createNotionWorkspaceSchema(): WorkspaceSchemaDescriptor {
  const core = {
    providerType: "notion",
    tables: TABLES,
    version: "notion-workspace-schema-v2",
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
