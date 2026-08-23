/** Notion Agent-body loading, semantic validation, and relation coverage. */
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "../src/domain/json.js";
import type { TableKind } from "../src/domain/provider.js";
import { NotionProvider } from "../src/provider/notion/notion-provider.js";
import { NOTION_TABLES } from "../src/provider/notion/notion-schema.js";
import type {
  NotionRequest,
  NotionTransport,
} from "../src/provider/notion/notion-transport.js";
import { NotionApiError } from "../src/provider/notion/notion-transport.js";

/** Stable Notion IDs used across transport fixtures. */
const ids = {
  activeAgents: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  agent: "11111111111111111111111111111111",
  badAgent: "44444444444444444444444444444444",
  childRun: "55555555555555555555555555555555",
  agents: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  errors: "cccccccccccccccccccccccccccccccc",
  policy: "22222222222222222222222222222222",
  prompt: "33333333333333333333333333333333",
  parentRun: "66666666666666666666666666666666",
  restartRun: "77777777777777777777777777777777",
  resources: "dddddddddddddddddddddddddddddddd",
  task: "99999999999999999999999999999999",
  tasks: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
} as const;

test("Notion Agent records derive configuration and Resources from the page body", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
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
      type: "notion",
    },
    new AgentBodyTransport(),
  );

  /** Agent definition resolved for the current run. */
  const agent = await provider.getAgentByKey("code-reviewer");
  assert.ok(agent);
  assert.equal(agent.enabled, true);
  assert.equal(agent.model, "gpt-5.6-sol");
  assert.equal(agent.reasoning, "high");
  assert.deepEqual(agent.resourceIds, [ids.prompt, ids.policy]);
  assert.deepEqual(agent.transitions, {
    blocked: "Blocked",
    succeeded: "In progress",
  });
  assert.deepEqual(Object.keys(agent.properties), ["Name"]);
});

test("Notion Agent record lookup isolates unrelated malformed bodies", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
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
      type: "notion",
    },
    new AgentBodyTransport(),
  );

  assert.equal((await provider.getAgent(ids.agent))?.key, "code-reviewer");
  await assert.rejects(provider.getAgent(ids.badAgent), TypeError);
  assert.equal(
    await provider.getAgent("88888888888888888888888888888888"),
    null,
  );
});

test("Notion page lookup treats only typed HTTP 404 as absence", async () => {
  /** Typed provider failure representing an absent page. */
  const missing = new NotionApiError("gone", 404, "object_not_found", null);
  /** Provider whose page lookup receives the typed absence. */
  const provider = lifecycleProvider(new FailingTransport(missing));

  assert.equal(await provider.getTask(ids.task), null);
});

test("Notion page lookup propagates every non-404 failure", async () => {
  /** Failures whose text must not be interpreted as page absence. */
  const failures = [
    new Error("not found"),
    new NotionApiError("not found", 500, "internal_error", null),
  ];

  for (const failure of failures) {
    /** Provider configured to throw the current failure unchanged. */
    const provider = lifecycleProvider(new FailingTransport(failure));
    await assert.rejects(
      provider.getTask(ids.task),
      (error) => error === failure,
    );
  }
});

test("Notion Agent loading retries a body and metadata torn read", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
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
      type: "notion",
    },
    new TornAgentBodyTransport(),
  );

  /** Agent definition resolved for the current run. */
  const agent = await provider.getAgentByKey("code-reviewer");
  assert.match(agent?.version ?? "", /^[0-9a-f]{64}$/u);
  assert.deepEqual(agent?.restartCompatibleVersions, [
    "2026-08-17T13:00:00.000Z",
  ]);
});

test("Notion Agent versions bind same-timestamp command policy changes", async () => {
  /** Test fixture for transport. */
  const transport = new SameTimestampAgentBodyTransport();
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
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
      type: "notion",
    },
    transport,
  );

  /** Test fixture for restricted. */
  const restricted = await provider.getAgentByKey("code-reviewer");
  transport.permissive = true;
  /** Test fixture for permissive. */
  const permissive = await provider.getAgentByKey("code-reviewer");

  assert.notEqual(restricted?.version, permissive?.version);
  assert.deepEqual(restricted?.commands, { inclusion: ["git"] });
  assert.deepEqual(permissive?.commands, { exclusion: [] });
});

test("Notion workspace validation reports malformed Agent bodies", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
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
      type: "notion",
    },
    new AgentBodyTransport(),
  );

  /** Test fixture for report. */
  const report = await provider.validateWorkspace();
  assert.equal(report.valid, false);
  assert.ok(
    report.issues.some(
      (entry) =>
        entry.code === "agent_definition" &&
        entry.path === `Agents.${ids.badAgent}`,
    ),
  );
});

test("workspace planning rejects property types found invalid by validation", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
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
      type: "notion",
    },
    new AgentBodyTransport({
      name: "Status",
      table: "tasks",
      type: "rich_text",
    }),
  );

  /** Test fixture for report. */
  const report = await provider.validateWorkspace();
  assert.ok(
    report.issues.some(
      (entry) =>
        entry.code === "property_type" && entry.path === "Tasks.Status",
    ),
  );
  await assert.rejects(
    provider.planWorkspace("management-v2"),
    /Cannot plan incompatible property Tasks\.Status/u,
  );
});

test("Notion Active Agent lookup preserves parent and restart Run IDs", async () => {
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(
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
      type: "notion",
    },
    new AgentBodyTransport(),
  );

  /** Test fixture for run. */
  const run = await provider.getActiveAgent("child");
  assert.equal(run?.parentRunId, "root");
  assert.equal(run?.restartOfRunId, "failed");
});

test("Notion terminal Active Agents detach from Tasks without losing retry identity", async () => {
  for (const status of ["completed", "failed", "stale", "stopped"] as const) {
    /** Test fixture for transport. */
    const transport = new ActiveAgentLifecycleTransport();
    /** Provider implementation that owns persistence for this invocation. */
    const provider = lifecycleProvider(transport);
    /** Test fixture for terminal. */
    const terminal = await provider.updateActiveAgent("child", {
      finishedAt: "2026-08-17T12:01:00.000Z",
      status,
    });
    assert.equal(terminal.taskId, ids.task);
    assert.deepEqual(transport.patches[0], {
      properties: {
        "Finished At": requestDate("2026-08-17T12:01:00.000Z"),
        Status: requestSelect(
          `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`,
        ),
        Task: requestRelation([]),
        "Task ID": requestRichText(ids.task),
      },
    });
  }

  /** Test fixture for transport. */
  const transport = new ActiveAgentLifecycleTransport();
  /** Provider implementation that owns persistence for this invocation. */
  const provider = lifecycleProvider(transport);
  await provider.archiveActiveAgent("child");
  assert.deepEqual(transport.patches[0], {
    in_trash: true,
    properties: {
      Task: requestRelation([]),
      "Task ID": requestRichText(ids.task),
    },
  });
});

test("Notion Active Agent creation persists historical Task identity", async () => {
  /** Test fixture for transport. */
  const transport = new ActiveAgentCreationTransport();
  /** Test fixture for created. */
  const created = await lifecycleProvider(transport).createActiveAgent({
    agentId: ids.agent,
    agentVersion: "agent-version",
    attempt: 1,
    harnessId: "harness",
    parentRunId: null,
    restartOfRunId: null,
    retryKey: "child",
    runId: "child",
    startedAt: "2026-08-17T12:00:00.000Z",
    taskId: ids.task,
    workingDirectory: "C:\\runs\\child",
  });

  assert.equal(created.taskId, ids.task);
  assert.deepEqual(
    transport.createdProperties?.Task,
    requestRelation([ids.task]),
  );
  assert.deepEqual(
    transport.createdProperties?.["Task ID"],
    requestRichText(ids.task),
  );
  assert.deepEqual(
    transport.createdProperties?.["Working Directory"],
    requestRichText("C:\\runs\\child"),
  );
});

test("Notion Task body updates require and replace exact Markdown", async () => {
  /** Test fixture for transport. */
  const transport = new TaskBodyTransport();
  /** Test fixture for updated. */
  const updated = await lifecycleProvider(transport).updateTaskBody(
    ids.task,
    "## Context\n\nOriginal.\n",
    "## Context\n\nOriginal.\n\n## Planning\n\nPlan.\n",
  );
  assert.match(updated.body, /## Planning\n\nPlan\./u);
  assert.deepEqual(transport.patch, {
    type: "update_content",
    update_content: {
      content_updates: [
        {
          new_str: "## Context\n\nOriginal.\n\n## Planning\n\nPlan.\n",
          old_str: "## Context\n\nOriginal.\n",
        },
      ],
    },
  });
});

/** Creates a Notion provider configured for Active Agent lifecycle tests. */
function lifecycleProvider(transport: NotionTransport): NotionProvider {
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
      type: "notion",
    },
    transport,
  );
}

/** Transport that rejects every request with one exact error object. */
class FailingTransport implements NotionTransport {
  /** Creates a transport around the failure expected by the scenario. */
  public constructor(private readonly failure: Error) {}

  /** Rejects without wrapping so tests can assert error identity. */
  public async request(_request: NotionRequest): Promise<JsonObject> {
    throw this.failure;
  }
}

/** Serves deterministic Agent metadata, body, and Resource responses. */
class AgentBodyTransport implements NotionTransport {
  /** Creates an instance with its required collaborators. */
  public constructor(
    private readonly propertyOverride?: {
      /** Name captured by the record fixture. */
      readonly name: string;
      /** Canonical managed-table descriptor for the current operation. */
      readonly table: TableKind;
      /** Type captured by the record fixture. */
      readonly type: string;
    },
  ) {}

  /** Routes the Notion requests used to hydrate an Agent record. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (
      request.method === "GET" &&
      request.path.startsWith("/v1/data_sources/")
    ) {
      /** Source ID captured by the request fixture. */
      const sourceId = request.path.split("/").at(-1);
      /** Canonical managed-table descriptor for the current operation. */
      const table = NOTION_TABLES.find((entry) => ids[entry.kind] === sourceId);
      if (table !== undefined) {
        /** Properties captured by the request fixture. */
        const properties: JsonObject = Object.fromEntries(
          table.properties.map((property) => [
            property.name,
            { type: property.type },
          ]),
        );
        if (this.propertyOverride?.table === table.kind)
          properties[this.propertyOverride.name] = {
            type: this.propertyOverride.type,
          };
        return { properties };
      }
    }
    if (request.path === `/v1/data_sources/${ids.agents}/query`)
      return pageResults([
        page(ids.agent, {
          Name: richTextProperty("title", "Code Reviewer"),
        }),
        page(ids.badAgent, {
          Name: richTextProperty("title", "Broken Draft"),
        }),
      ]);
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`)
      return pageResults([
        activeAgentPage(ids.childRun, "child", ids.parentRun, ids.restartRun),
      ]);
    if (request.path === `/v1/data_sources/${ids.resources}/query`)
      return pageResults([
        resourcePage(ids.prompt, "prompt/code-reviewer", "Prompt"),
        resourcePage(ids.policy, "policy/review", "Policy"),
      ]);
    if (request.path === `/v1/pages/${ids.agent}/markdown`)
      return { markdown: agentMarkdown('{"exclusion":[]}') };
    if (request.path === `/v1/pages/${ids.agent}`)
      return page(ids.agent, {
        Name: richTextProperty("title", "Code Reviewer"),
      });
    if (request.path === `/v1/pages/${ids.badAgent}/markdown`)
      return { markdown: "## Agent definition\n\n```json\nnot json\n```" };
    if (request.path === `/v1/pages/${ids.badAgent}`)
      return page(ids.badAgent, {
        Name: richTextProperty("title", "Broken Draft"),
      });
    if (request.path === `/v1/pages/${ids.parentRun}`)
      return activeAgentPage(ids.parentRun, "root");
    if (request.path === `/v1/pages/${ids.restartRun}`)
      return activeAgentPage(ids.restartRun, "failed");
    if (request.path === `/v1/pages/${ids.prompt}/markdown`)
      return { markdown: "Review the code." };
    if (request.path === `/v1/pages/${ids.policy}/markdown`)
      return { markdown: "Apply review policy." };
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Simulates metadata changing between the body read and consistency check. */
class TornAgentBodyTransport extends AgentBodyTransport {
  /** Returns a changed Agent version after the first metadata read. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/pages/${ids.agent}`)
      return {
        ...page(ids.agent, {
          Name: richTextProperty("title", "Code Reviewer"),
        }),
        last_edited_time: "2026-08-17T13:00:00.000Z",
      };
    return super.request(request);
  }
}

/** Changes an Agent body without changing its Notion timestamp. */
class SameTimestampAgentBodyTransport extends AgentBodyTransport {
  /** Whether subsequent body reads return the permissive command policy. */
  public permissive = false;

  /** Switches the served command policy while retaining metadata timestamps. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/pages/${ids.agent}/markdown`)
      return {
        markdown: agentMarkdown(
          this.permissive ? '{"exclusion":[]}' : '{"inclusion":["git"]}',
        ),
      };
    return super.request(request);
  }
}

/** Captures Active Agent terminal updates and Task detachment. */
class ActiveAgentLifecycleTransport implements NotionTransport {
  /** Active Agent property patches received by the transport. */
  public readonly patches: JsonObject[] = [];
  /** Whether the served Active Agent no longer relates to its Task. */
  private detached = false;

  /** Routes lifecycle query and patch requests for one Active Agent. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`)
      return pageResults([
        activeAgentLifecyclePage(this.detached ? [] : [ids.task]),
      ]);
    if (
      request.method === "PATCH" &&
      request.path === `/v1/pages/${ids.childRun}`
    ) {
      assert.ok(
        request.body !== undefined &&
          request.body !== null &&
          typeof request.body === "object" &&
          !Array.isArray(request.body),
      );
      this.patches.push(request.body);
      this.detached = true;
      return activeAgentLifecyclePage([]);
    }
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Captures the properties used to create an Active Agent page. */
class ActiveAgentCreationTransport implements NotionTransport {
  /** Properties from the most recent Active Agent creation request. */
  public createdProperties: JsonObject | null = null;

  /** Routes Active Agent lookup and creation requests. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`)
      return pageResults(
        this.createdProperties === null
          ? []
          : [activeAgentLifecyclePage([ids.task])],
      );
    if (request.method === "POST" && request.path === "/v1/pages") {
      assert.ok(
        request.body !== undefined &&
          request.body !== null &&
          typeof request.body === "object" &&
          !Array.isArray(request.body),
      );
      /** Properties captured by the request fixture. */
      const properties = request.body.properties;
      assert.ok(
        properties !== undefined &&
          properties !== null &&
          typeof properties === "object" &&
          !Array.isArray(properties),
      );
      this.createdProperties = properties;
      return { id: ids.childRun };
    }
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Captures optimistic Task-property and Markdown-body updates. */
class TaskBodyTransport implements NotionTransport {
  /** Task property patch received before the Markdown update. */
  public patch: JsonObject | null = null;
  /** Current Markdown body served by the transport. */
  private markdown = "## Context\n\nOriginal.\n";

  /** Routes the reads and writes required by a Task body update. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.method === "GET" && request.path === `/v1/pages/${ids.task}`)
      return page(ids.task, {
        Dependencies: relationProperty([]),
        Priority: { number: 15, type: "number" },
        Status: selectProperty("In Planning (AI)"),
        Task: richTextProperty("title", "Plan work"),
        Type: selectProperty("Feature"),
      });
    if (request.path === `/v1/pages/${ids.task}/markdown`) {
      if (request.method === "GET") return { markdown: this.markdown };
      assert.ok(
        request.method === "PATCH" &&
          request.body !== undefined &&
          request.body !== null &&
          typeof request.body === "object" &&
          !Array.isArray(request.body),
      );
      this.patch = request.body;
      /** Update captured by the request fixture. */
      const update = request.body.update_content;
      assert.ok(
        update !== undefined &&
          update !== null &&
          typeof update === "object" &&
          !Array.isArray(update),
      );
      /** Content updates captured by the request fixture. */
      const contentUpdates = update.content_updates;
      assert.ok(Array.isArray(contentUpdates) && contentUpdates.length === 1);
      /** Replacement captured by the request fixture. */
      const replacement = contentUpdates[0];
      assert.ok(
        replacement !== undefined &&
          replacement !== null &&
          typeof replacement === "object" &&
          !Array.isArray(replacement) &&
          replacement.old_str === this.markdown &&
          typeof replacement.new_str === "string",
      );
      this.markdown = replacement.new_str;
      return {};
    }
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Renders an Agent-definition section with a chosen command policy. */
function agentMarkdown(commands: string): string {
  return `## Agent definition

\`\`\`json
{"schema":"agent-definition-v1","enabled":true,"commands":${commands},"allowedTaskTypes":["Feature"],"allowedStatuses":["In progress"],"id":"code-reviewer","model":"gpt-5.6-sol","reasoning":"high","inputResourceSelectors":["policy/review","schema/result-v1"],"promptResources":["prompt/code-reviewer"],"transitions":{"succeeded":"In progress","blocked":"Blocked"}}
\`\`\`
`;
}

/** Builds a Notion page for an Active Agent hierarchy test. */
function activeAgentPage(
  id: string,
  runId: string,
  parentId?: string,
  restartId?: string,
): JsonObject {
  return page(id, {
    Parent: relationProperty(parentId === undefined ? [] : [parentId]),
    "Restart Of": relationProperty(restartId === undefined ? [] : [restartId]),
    "Run ID": richTextProperty("title", runId),
  });
}

/** Builds the running Active Agent page used by lifecycle tests. */
function activeAgentLifecyclePage(taskIds: readonly string[]): JsonObject {
  return page(ids.childRun, {
    "Finished At": dateProperty(null),
    Outcome: richTextProperty("rich_text", ""),
    Parent: relationProperty([]),
    "Restart Of": relationProperty([]),
    "Run ID": richTextProperty("title", "child"),
    Status: selectProperty("Running"),
    Task: relationProperty(taskIds),
    "Task ID": richTextProperty("rich_text", ids.task),
  });
}

/** Builds a Notion Resource page fixture. */
function resourcePage(id: string, key: string, kind: string): JsonObject {
  return page(id, {
    Kind: selectProperty(kind),
    Resource: richTextProperty("title", key),
    State: selectProperty("Active"),
  });
}

/** Wraps properties in a minimal Notion page object. */
function page(id: string, properties: JsonObject): JsonObject {
  return {
    archived: false,
    id,
    last_edited_time: "2026-08-17T12:00:00.000Z",
    properties,
  };
}

/** Wraps pages in a terminal Notion pagination response. */
function pageResults(results: readonly JsonObject[]): JsonObject {
  return { has_more: false, next_cursor: null, results: [...results] };
}

/** Builds a typed Notion title or rich-text response property. */
function richTextProperty(
  type: "rich_text" | "title",
  value: string,
): JsonObject {
  return {
    [type]: [{ plain_text: value }],
    type,
  };
}

/** Builds a Notion select response property. */
function selectProperty(value: string): JsonObject {
  return { select: { name: value }, type: "select" };
}

/** Builds a canonical descriptor for a Notion relation. */
function relationProperty(ids: readonly string[]): JsonObject {
  return { relation: ids.map((id) => ({ id })), type: "relation" };
}

/** Builds a nullable Notion date response property. */
function dateProperty(value: string | null): JsonObject {
  return { date: value === null ? null : { start: value }, type: "date" };
}

/** Encodes a Notion date request value. */
function requestDate(value: string): JsonObject {
  return { date: { start: value } };
}

/** Encodes Notion relation IDs for a request. */
function requestRelation(ids: readonly string[]): JsonObject {
  return { relation: ids.map((id) => ({ id })) };
}

/** Encodes plain text as a Notion rich-text request value. */
function requestRichText(value: string): JsonObject {
  return { rich_text: [{ text: { content: value }, type: "text" }] };
}

/** Encodes a Notion select request value. */
function requestSelect(value: string): JsonObject {
  return { select: { name: value } };
}
