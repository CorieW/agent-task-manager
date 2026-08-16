/** Provider-neutral the provider-owned minimum schema for a Notion workspace contract. */
import { digestJson } from "../../core/digest.js";
import { toJsonValue } from "../../domain/json.js";
import type {
  TableDescriptor,
  WorkspaceSchemaDescriptor,
} from "../../domain/schema.js";

/** Property storing the digest of the active Task body generation. */
export const NOTION_TASK_MUTATION_PROPERTY = "Manager Mutation";

/** Caption prefix marking manager-owned Task body generations. */
export const NOTION_TASK_MUTATION_CAPTION_PREFIX =
  "agent-task-manager:task-mutation:";

/** Provider table kinds stored in deterministic order. */
const TABLES: readonly TableDescriptor[] = [
  {
    kind: "operations",
    managedRanges: [],
    properties: [
      property("key", "Operation", "title"),
      property("kind", "Kind", "rich_text"),
      property("version", "Version", "rich_text"),
      property("digest", "Digest", "rich_text"),
      property("state", "State", "select"),
      property("dependencies", "Dependencies", "rich_text"),
    ],
    title: "Operations",
  },
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
      relation("agent", "Agent", "agents"),
      property("runId", "Run ID", "rich_text", false),
    ],
    title: "Errors",
  },
  {
    kind: "tasks",
    managedRanges: [],
    properties: [
      property("title", "Task", "title"),
      property("status", "Status", "select"),
      property("managerMutation", NOTION_TASK_MUTATION_PROPERTY, "rich_text"),
      property("priority", "Priority", "number", false),
      relation("dependencies", "Dependencies", "tasks"),
    ],
    title: "Tasks",
  },
  {
    kind: "agents",
    managedRanges: [],
    properties: [
      property("name", "Name", "title"),
      property("enabled", "Enabled", "checkbox"),
      property("revision", "Revision", "number"),
      property("model", "Model", "rich_text"),
      property("status", "Status", "select"),
      relation("workingOn", "Working On", "tasks"),
      property("lastRun", "Last Run", "last_edited_time", true, false),
    ],
    title: "Agents",
  },
];

/** Creates Notion workspace schema. */
export function createNotionWorkspaceSchema(): WorkspaceSchemaDescriptor {
  /** Core snapshot used consistently during `createNotionWorkspaceSchema`. */
  const core = {
    providerType: "notion",
    tables: TABLES,
    version: "notion-workspace-schema-v3",
  };
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

/** Provider-neutral one logical-to-physical Notion property mapping contract. */
function property(
  logicalName: string,
  physicalName: string,
  type: string,
  required = true,
  writable = true,
) {
  return {
    logicalName,
    physicalName,
    required,
    targetTable: null,
    type,
    writable,
  } as const;
}

/** Reads relation. */
function relation(
  logicalName: string,
  physicalName: string,
  targetTable: "agents" | "tasks",
  required = true,
) {
  return {
    logicalName,
    physicalName,
    required,
    targetTable,
    type: "relation",
    writable: true,
  } as const;
}
