/** Shared Notion IDs, providers, pages, and property payloads. */
import type { JsonObject } from "../../../src/domain/json.js";
import { NotionProvider } from "../../../src/provider/notion/notion-provider.js";
import type { NotionTransport } from "../../../src/provider/notion/notion-transport.js";

/** Stable page and data-source IDs shared by deterministic Notion fixtures. */
export const ids = {
  activeAgents: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  agent: "11111111111111111111111111111111",
  badAgent: "44444444444444444444444444444444",
  childRun: "55555555555555555555555555555555",
  agents: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  errors: "cccccccccccccccccccccccccccccccc",
  policy: "22222222222222222222222222222222",
  prompt: "33333333333333333333333333333333",
  schema: "12121212121212121212121212121212",
  parentRun: "66666666666666666666666666666666",
  restartRun: "77777777777777777777777777777777",
  resources: "dddddddddddddddddddddddddddddddd",
  task: "99999999999999999999999999999999",
  tasks: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
} as const;

/** Host-valid working directory used by Active Agent fixtures. */
export const activeAgentWorkingDirectory =
  process.platform === "win32" ? "C:\\runs\\child" : "/runs/child";

/** Creates a Notion provider configured for Active Agent lifecycle tests. */
export function lifecycleProvider(transport: NotionTransport): NotionProvider {
  return new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: ids.activeAgents,
        agents: ids.agents,
        errors: ids.errors,
        resources: ids.resources,
        tasks: ids.tasks,
      },
    },
    transport,
  );
}

/** Renders the canonical Agent-definition Markdown used by provider fixtures. */
export function agentMarkdown(commands: string): string {
  return `## Agent definition

\`\`\`json
{"schema":"agent-definition-v1","enabled":true,"commands":${commands},"allowedTaskTypes":["Feature"],"allowedStatuses":["In progress"],"id":"code-reviewer","model":"gpt-5.6-sol","reasoning":"high","inputResourceSelectors":["agent-policy/review","schema/result-v1"],"promptResources":["prompt/code-reviewer"],"transitions":{"succeeded":"In progress","blocked":"Blocked"}}
\`\`\`
`;
}

/** Builds a Notion page for an Active Agent hierarchy test. */
export function activeAgentPage(
  id: string,
  runId: string,
  parentId?: string,
  restartId?: string,
): JsonObject {
  return page(
    id,
    activeAgentProperties({
      parentIds: parentId === undefined ? [] : [parentId],
      restartIds: restartId === undefined ? [] : [restartId],
      runId,
      taskIds: [ids.task],
    }),
  );
}

/** Builds the running Active Agent page used by lifecycle tests. */
export function activeAgentLifecyclePage(
  taskIds: readonly string[],
  archived = false,
  overrides: JsonObject = {},
): JsonObject {
  return page(
    ids.childRun,
    activeAgentProperties({
      archived,
      overrides,
      parentIds: [],
      restartIds: [],
      runId: "child",
      taskIds,
    }),
  );
}

/** Variable fields used to build one canonical Active Agent property payload. */
interface ActiveAgentPropertiesOptions {
  /** Whether the fixture row is archived. */
  readonly archived?: boolean;
  /** Property payloads applied after all canonical fixture defaults. */
  readonly overrides?: JsonObject;
  /** Parent relation page IDs. */
  readonly parentIds: readonly string[];
  /** Restart-source relation page IDs. */
  readonly restartIds: readonly string[];
  /** Stable Run ID and retry identity for the fixture. */
  readonly runId: string;
  /** Task relation page IDs. */
  readonly taskIds: readonly string[];
}

/** Builds the shared managed-property payload for an Active Agent page. */
function activeAgentProperties({
  archived = false,
  overrides = {},
  parentIds,
  restartIds,
  runId,
  taskIds,
}: ActiveAgentPropertiesOptions): JsonObject {
  return {
    Agent: relationProperty([ids.agent]),
    "Agent Version": richTextProperty("rich_text", "agent-version"),
    Archived: { checkbox: archived, type: "checkbox" },
    Attempt: { number: 1, type: "number" },
    "Completion Task Status": richTextProperty("rich_text", ""),
    "Failure Summary": richTextProperty("rich_text", ""),
    "Finished At": dateProperty(null),
    "Harness ID": richTextProperty("rich_text", "harness"),
    "Last Heartbeat": dateProperty("2026-08-17T12:00:00.000Z"),
    Outcome: richTextProperty("rich_text", ""),
    Parent: relationProperty(parentIds),
    "Restart Of": relationProperty(restartIds),
    "Retry Key": richTextProperty("rich_text", runId),
    "Run ID": richTextProperty("title", runId),
    "Started At": dateProperty("2026-08-17T12:00:00.000Z"),
    Status: selectProperty("Running"),
    Task: relationProperty(taskIds),
    "Task ID": richTextProperty("rich_text", ids.task),
    "Working Directory": richTextProperty("rich_text", ""),
    ...overrides,
  };
}

/** Builds a Notion Resource page fixture. */
export function resourcePage(
  id: string,
  key: string,
  kind: string,
): JsonObject {
  return page(id, {
    Kind: selectProperty(kind),
    Resource: richTextProperty("title", key),
    State: selectProperty("Active"),
  });
}

/** Wraps properties in a minimal Notion page object. */
export function page(
  id: string,
  properties: JsonObject,
  parentId: string = ids.tasks,
): JsonObject {
  return {
    archived: false,
    id,
    last_edited_time: "2026-08-17T12:00:00.000Z",
    parent: { data_source_id: parentId, type: "data_source_id" },
    properties,
  };
}

/** Wraps pages in a terminal Notion pagination response. */
export function pageResults(results: readonly JsonObject[]): JsonObject {
  return { has_more: false, next_cursor: null, results: [...results] };
}

/** Builds a typed Notion title or rich-text response property. */
export function richTextProperty(
  type: "rich_text" | "title",
  value: string,
): JsonObject {
  return {
    [type]: [{ plain_text: value }],
    type,
  };
}

/** Builds a Notion select response property. */
export function selectProperty(value: string): JsonObject {
  return { select: { name: value }, type: "select" };
}

/** Builds a canonical descriptor for a Notion relation. */
export function relationProperty(ids: readonly string[]): JsonObject {
  return { relation: ids.map((id) => ({ id })), type: "relation" };
}

/** Builds a nullable Notion date response property. */
export function dateProperty(value: string | null): JsonObject {
  return { date: value === null ? null : { start: value }, type: "date" };
}

/** Encodes a Notion date request value. */
export function requestDate(value: string): JsonObject {
  return { date: { start: value } };
}

/** Encodes Notion relation IDs for a request. */
export function requestRelation(ids: readonly string[]): JsonObject {
  return { relation: ids.map((id) => ({ id })) };
}

/** Encodes plain text as a Notion rich-text request value. */
export function requestRichText(value: string): JsonObject {
  return { rich_text: [{ text: { content: value }, type: "text" }] };
}

/** Encodes a Notion select request value. */
export function requestSelect(value: string): JsonObject {
  return { select: { name: value } };
}
