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
  schema: "12121212121212121212121212121212",
  parentRun: "66666666666666666666666666666666",
  restartRun: "77777777777777777777777777777777",
  resources: "dddddddddddddddddddddddddddddddd",
  task: "99999999999999999999999999999999",
  tasks: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
} as const;

/** Host-valid working directory used by Active Agent fixtures. */
const activeAgentWorkingDirectory =
  process.platform === "win32" ? "C:\\runs\\child" : "/runs/child";

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
  assert.deepEqual(agent.resourceIds, [ids.prompt, ids.policy, ids.schema]);
  assert.deepEqual(agent.transitions, {
    blocked: "Blocked",
    succeeded: "In progress",
  });
  assert.deepEqual(Object.keys(agent.properties), ["Name"]);
});

test("Notion records reject incomplete Markdown renderings", async () => {
  /** Provider whose Agent body is explicitly truncated by Notion. */
  const provider = lifecycleProvider(new TruncatedAgentBodyTransport());

  await assert.rejects(
    provider.getAgent(ids.agent),
    /incomplete page Markdown/u,
  );
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
  /** Transport boundary exercised by "Notion Agent versions bind same-timestamp command policy changes". */
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

  /** Restricted case exercised by "Notion Agent versions bind same-timestamp command policy changes". */
  const restricted = await provider.getAgentByKey("code-reviewer");
  transport.permissive = true;
  /** Permissive case exercised by "Notion Agent versions bind same-timestamp command policy changes". */
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

  /** Workspace report expected to contain the malformed Agent definition. */
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

  /** Workspace report establishing the same property mismatch as planning. */
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

test("workspace validation rejects incomplete relation and select contracts", async () => {
  /** Canonical environment shared by schema-contract fixtures. */
  const environment = {
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
  } as const;
  /** Validation report for a relation with the wrong target contract. */
  const relationReport = await new NotionProvider(
    environment,
    new AgentBodyTransport({
      name: "Dependencies",
      table: "tasks",
      type: "relation",
    }),
  ).validateWorkspace();
  assert.ok(
    relationReport.issues.some((entry) => entry.path === "Tasks.Dependencies"),
  );
  /** Validation report for a select with incomplete canonical options. */
  const selectReport = await new NotionProvider(
    environment,
    new AgentBodyTransport({
      name: "State",
      table: "resources",
      type: "select",
    }),
  ).validateWorkspace();
  assert.ok(
    selectReport.issues.some((entry) => entry.path === "Resources.State"),
  );
  /** Validation report for a missing required Active Agent property. */
  const requiredReport = await new NotionProvider(
    environment,
    new AgentBodyTransport({
      name: "Finished At",
      table: "activeAgents",
      type: null,
    }),
  ).validateWorkspace();
  assert.ok(
    requiredReport.issues.some(
      (entry) => entry.path === "Active Agents.Finished At",
    ),
  );
});

test("workspace plans are bound to the configured Notion target", async () => {
  /** Shared managed-table mapping served by the deterministic transport. */
  const tables = {
    activeAgents: ids.activeAgents,
    agents: ids.agents,
    errors: ids.errors,
    resources: ids.resources,
    tasks: ids.tasks,
  };
  /** Plan authorized for the first bootstrap parent. */
  const first = new NotionProvider(
    {
      bootstrapParent: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      connection: {},
      tables,
      type: "notion",
    },
    new AgentBodyTransport(),
  );
  /** Provider with an otherwise identical schema but a different target parent. */
  const second = new NotionProvider(
    {
      bootstrapParent: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      connection: {},
      tables,
      type: "notion",
    },
    new AgentBodyTransport(),
  );

  /** Plan bound to the first provider target. */
  const plan = await first.planWorkspace("management-v2");
  /** Plan independently bound to the second provider target. */
  const otherPlan = await second.planWorkspace("management-v2");
  assert.notEqual(plan.digest, otherPlan.digest);
  await assert.rejects(
    second.applyWorkspacePlan(plan),
    /Workspace plan target does not match the provider/u,
  );
});

test("workspace planning reuses a uniquely named bootstrap database", async () => {
  /** Provider configured before its Tasks data-source ID was persisted. */
  const provider = new NotionProvider(
    {
      bootstrapParent: "ffffffffffffffffffffffffffffffff",
      connection: {},
      tables: {
        activeAgents: null,
        agents: null,
        errors: null,
        resources: null,
        tasks: null,
      },
      type: "notion",
    },
    new ExistingTableDiscoveryTransport(),
  );

  /** Plan expected to adopt rather than recreate the discovered Tasks table. */
  const plan = await provider.planWorkspace("management-v2");

  assert.equal(plan.target.tables.tasks, ids.tasks);
  assert.equal(
    plan.steps.some(
      (step) => step.kind === "create_table" && step.table === "tasks",
    ),
    false,
  );
});

test("Notion Active Agent lookup preserves parent and restart Run IDs", async () => {
  /** Provider serving one child with both hierarchy and retry relations. */
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

  /** Decoded child run whose hierarchy and retry identities are asserted. */
  const run = await provider.getActiveAgent("child");
  assert.equal(run?.parentRunId, "root");
  assert.equal(run?.restartOfRunId, "failed");
});

test("Notion Active Agent decoding rejects invalid lifecycle status", async () => {
  /** Provider whose Active Agent row contains an out-of-domain status. */
  const provider = lifecycleProvider(new InvalidActiveAgentTransport());

  await assert.rejects(
    provider.listActiveAgents(),
    /Invalid Active Agent status/u,
  );
});

test("Notion terminal Active Agents detach from Tasks without losing retry identity", async () => {
  for (const status of ["completed", "failed", "stale", "stopped"] as const) {
    /** Transport boundary exercised by "Notion terminal Active Agents detach from Tasks without losing retry identity". */
    const transport = new ActiveAgentLifecycleTransport();
    /** Provider implementation that owns persistence for this invocation. */
    const provider = lifecycleProvider(transport);
    /** Terminal state observed by "Notion terminal Active Agents detach from Tasks without losing retry identity". */
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

  /** Transport boundary exercised by "Notion terminal Active Agents detach from Tasks without losing retry identity". */
  const transport = new ActiveAgentLifecycleTransport();
  /** Provider implementation that owns persistence for this invocation. */
  const provider = lifecycleProvider(transport);
  await provider.archiveActiveAgent("child");
  assert.deepEqual(transport.patches[0], {
    properties: {
      Archived: { checkbox: true },
      Task: requestRelation([]),
      "Task ID": requestRichText(ids.task),
    },
  });
  assert.equal((await provider.getActiveAgent("child"))?.archived, true);
  assert.deepEqual(await provider.listActiveAgents(), []);
});

test("Notion Active Agent updates decode the authoritative PATCH page", async () => {
  /** Transport whose query remains stale after returning an authoritative patch. */
  const transport = new StaleActiveAgentUpdateTransport();
  /** Updated record decoded directly from the mutation response. */
  const updated = await lifecycleProvider(transport).updateActiveAgent(
    "child",
    {
      finishedAt: "2026-08-17T12:01:00.000Z",
      outcome: "completed work",
      status: "completed",
    },
  );

  assert.equal(transport.queryCount, 1);
  assert.deepEqual(updated, {
    agentId: ids.agent,
    agentVersion: "agent-version",
    archived: false,
    attempt: 1,
    completionTaskStatus: "",
    failureSummary: "",
    finishedAt: "2026-08-17T12:01:00.000Z",
    harnessId: "harness",
    id: ids.childRun,
    lastHeartbeat: "2026-08-17T12:00:00.000Z",
    outcome: "completed work",
    parentRunId: null,
    restartOfRunId: null,
    retryKey: "child",
    runId: "child",
    startedAt: "2026-08-17T12:00:00.000Z",
    status: "completed",
    taskId: ids.task,
    version: "2026-08-17T12:01:00.000Z",
    workingDirectory: null,
  });
});

test("Notion Active Agent creation persists historical Task identity", async () => {
  /** Transport boundary exercised by "Notion Active Agent creation persists historical Task identity". */
  const transport = new ActiveAgentCreationTransport();
  /** Created state observed by "Notion Active Agent creation persists historical Task identity". */
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
    workingDirectory: activeAgentWorkingDirectory,
  });

  assert.equal(transport.queryCount, 1);
  assert.deepEqual(created, {
    agentId: ids.agent,
    agentVersion: "agent-version",
    archived: false,
    attempt: 1,
    completionTaskStatus: "",
    failureSummary: "",
    finishedAt: null,
    harnessId: "harness",
    id: ids.childRun,
    lastHeartbeat: "2026-08-17T12:00:00.000Z",
    outcome: "",
    parentRunId: null,
    restartOfRunId: null,
    retryKey: "child",
    runId: "child",
    startedAt: "2026-08-17T12:00:00.000Z",
    status: "running",
    taskId: ids.task,
    version: "2026-08-17T12:00:00.000Z",
    workingDirectory: activeAgentWorkingDirectory,
  });
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
    requestRichText(activeAgentWorkingDirectory),
  );
});

test("Notion Task body updates require and replace exact Markdown", async () => {
  /** Transport boundary exercised by "Notion Task body updates require and replace exact Markdown". */
  const transport = new TaskBodyTransport();
  /** Updated state observed by "Notion Task body updates require and replace exact Markdown". */
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

test("Notion Tasks may have an empty Markdown body", async () => {
  /** Provider whose otherwise valid Task has no page content. */
  const provider = lifecycleProvider(new EmptyTaskBodyTransport());

  assert.equal((await provider.getTask(ids.task))?.body, "");
});

test("Notion Tasks reject truncated inline relations", async () => {
  /** Provider whose Dependencies relation exceeds Notion's inline limit. */
  const provider = lifecycleProvider(new TruncatedTaskRelationTransport());

  await assert.rejects(
    provider.getTask(ids.task),
    /relation exceeds the inline reference limit/u,
  );
});

test("Notion Task operations reject pages outside the configured Tasks table", async () => {
  /** Transport serving a Task-shaped page from a foreign data source. */
  const transport = new TaskBodyTransport(ids.resources);
  /** Provider expected to reject every direct operation on the foreign page. */
  const provider = lifecycleProvider(transport);
  await assert.rejects(
    provider.getTask(ids.task),
    /outside the configured tasks table/u,
  );
  await assert.rejects(
    provider.setTaskStatus(ids.task, "Planned", "version", "In review"),
    /outside the configured tasks table/u,
  );
  await assert.rejects(
    provider.updateTaskBody(ids.task, "original", "changed"),
    /outside the configured tasks table/u,
  );
  assert.equal(transport.patch, null);
});

test("Notion Error resolution stays open when its Markdown write fails", async () => {
  /** Transport that rejects the first resolution mutation. */
  const transport = new FailingErrorResolutionTransport();
  /** Provider whose resolution body write fails before any status update. */
  const provider = lifecycleProvider(transport);

  await assert.rejects(
    provider.resolveError("retry-chain", "Fixed configuration"),
    /Markdown update failed/u,
  );
  assert.equal(transport.statusPatches, 0);
});

test("Notion Error Markdown preserves embedded level-two headings", async () => {
  /** Transport that serves the exact Markdown created by reportError. */
  const transport = new ErrorRoundTripTransport();
  /** Provider implementation that owns persistence for this invocation. */
  const provider = lifecycleProvider(transport);
  /** Arbitrary Error text containing headings that previously escaped sections. */
  const description = "First symptom\n\n## Diagnostic\n\nDetailed evidence";
  /** Arbitrary resolution containing another level-two heading. */
  const resolution = "Applied fix\n\n## Verification\n\nAll checks pass";

  /** Round-tripped Error used to compare protected Markdown section content. */
  const reported = await provider.reportError({
    activeAgentId: null,
    agentId: null,
    description,
    errorKey: "heading-round-trip",
    resolution,
    severity: "medium",
    source: "ai",
    taskId: null,
    title: "T".repeat(2_100),
  });

  assert.equal(reported.description, description);
  assert.equal(reported.resolution, resolution);
  assert.equal(transport.createdSource, "AI");
  assert.deepEqual(transport.createdTitleFragmentLengths, [2_000, 100]);
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
      readonly type: string | null;
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
            {
              type: property.type,
              ...(property.relation === null
                ? {}
                : {
                    relation: {
                      data_source_id: ids[property.relation],
                      ...(property.syncedName === undefined
                        ? { single_property: {} }
                        : {
                            dual_property: {
                              synced_property_name: property.syncedName,
                            },
                          }),
                    },
                  }),
              ...(property.type === "select" && property.options.length > 0
                ? {
                    select: {
                      options: property.options.map((name) => ({ name })),
                    },
                  }
                : {}),
            },
          ]),
        );
        if (this.propertyOverride?.table === table.kind) {
          if (this.propertyOverride.type === null)
            delete properties[this.propertyOverride.name];
          else
            properties[this.propertyOverride.name] = {
              type: this.propertyOverride.type,
            };
        }
        return { properties };
      }
    }
    if (request.path === `/v1/data_sources/${ids.agents}/query`)
      return pageResults([
        page(
          ids.agent,
          {
            Name: richTextProperty("title", "Code Reviewer"),
          },
          ids.agents,
        ),
        page(
          ids.badAgent,
          {
            Name: richTextProperty("title", "Broken Draft"),
          },
          ids.agents,
        ),
      ]);
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`)
      return pageResults([
        activeAgentPage(ids.childRun, "child", ids.parentRun, ids.restartRun),
      ]);
    if (request.path === `/v1/data_sources/${ids.resources}/query`)
      return pageResults([
        resourcePage(ids.prompt, "prompt/code-reviewer", "Prompt"),
        resourcePage(ids.policy, "agent-policy/review", "Policy"),
        resourcePage(ids.schema, "schema/result-v1", "Schema"),
      ]);
    if (request.path === `/v1/pages/${ids.agent}/markdown`)
      return {
        markdown: agentMarkdown('{"exclusion":[]}'),
        truncated: false,
        unknown_block_ids: [],
      };
    if (request.path === `/v1/pages/${ids.agent}`)
      return page(
        ids.agent,
        {
          Name: richTextProperty("title", "Code Reviewer"),
        },
        ids.agents,
      );
    if (request.path === `/v1/pages/${ids.badAgent}/markdown`)
      return {
        markdown: "## Agent definition\n\n```json\nnot json\n```",
        truncated: false,
        unknown_block_ids: [],
      };
    if (request.path === `/v1/pages/${ids.badAgent}`)
      return page(
        ids.badAgent,
        {
          Name: richTextProperty("title", "Broken Draft"),
        },
        ids.agents,
      );
    if (request.path === "/v1/pages/88888888888888888888888888888888")
      throw new NotionApiError("gone", 404, "object_not_found", null);
    if (request.path === `/v1/pages/${ids.parentRun}`)
      return activeAgentPage(ids.parentRun, "root");
    if (request.path === `/v1/pages/${ids.restartRun}`)
      return activeAgentPage(ids.restartRun, "failed");
    if (request.path === `/v1/pages/${ids.prompt}/markdown`)
      return {
        markdown: "Review the code.",
        truncated: false,
        unknown_block_ids: [],
      };
    if (request.path === `/v1/pages/${ids.policy}/markdown`)
      return {
        markdown: "Apply review policy.",
        truncated: false,
        unknown_block_ids: [],
      };
    if (request.path === `/v1/pages/${ids.schema}/markdown`)
      return {
        markdown: "Use result schema v1.",
        truncated: false,
        unknown_block_ids: [],
      };
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Serves a structurally complete Active Agent with an invalid status. */
class InvalidActiveAgentTransport extends AgentBodyTransport {
  /** Overrides only the Active Agents query used by the regression. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`) {
      /** Complete fixture whose status is replaced with an unknown label. */
      const run = activeAgentPage(ids.childRun, "child");
      assert.ok(
        run.properties !== null &&
          typeof run.properties === "object" &&
          !Array.isArray(run.properties),
      );
      return pageResults([
        {
          ...run,
          properties: {
            ...run.properties,
            Status: selectProperty("Paused"),
          },
        },
      ]);
    }
    return super.request(request);
  }
}

/** Serves one pre-existing canonical Tasks database under the bootstrap page. */
class ExistingTableDiscoveryTransport extends AgentBodyTransport {
  /** Routes bootstrap discovery before delegating schema inspection. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (
      request.path ===
      `/v1/blocks/ffffffffffffffffffffffffffffffff/children?page_size=100`
    )
      return pageResults([
        {
          child_database: { title: "Tasks" },
          id: ids.parentRun,
          in_trash: false,
          type: "child_database",
        },
      ]);
    if (request.path === `/v1/databases/${ids.parentRun}`)
      return { data_sources: [{ id: ids.tasks }] };
    return super.request(request);
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
        truncated: false,
        unknown_block_ids: [],
      };
    return super.request(request);
  }
}

/** Serves an Agent body with Notion's explicit incompleteness marker. */
class TruncatedAgentBodyTransport extends AgentBodyTransport {
  /** Returns incomplete Markdown for the otherwise valid Agent fixture. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/pages/${ids.agent}/markdown`)
      return {
        markdown: agentMarkdown('{"exclusion":[]}'),
        truncated: true,
        unknown_block_ids: [ids.prompt],
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
  /** Whether the served row is retained as an archived Run-ID tombstone. */
  private archived = false;

  /** Routes lifecycle query and patch requests for one Active Agent. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`)
      return pageResults([
        activeAgentLifecyclePage(
          this.detached ? [] : [ids.task],
          this.archived,
        ),
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
      /** Active Agent property payload captured from the terminal update. */
      const properties = request.body.properties;
      if (
        properties !== null &&
        typeof properties === "object" &&
        !Array.isArray(properties)
      ) {
        /** Archived checkbox payload inspected independently from Task detachment. */
        const archived = properties.Archived;
        if (
          archived !== null &&
          typeof archived === "object" &&
          !Array.isArray(archived) &&
          archived.checkbox === true
        )
          this.archived = true;
      }
      return activeAgentLifecyclePage([], this.archived);
    }
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Returns an authoritative update while indexed Active Agent queries stay stale. */
class StaleActiveAgentUpdateTransport implements NotionTransport {
  /** Number of indexed Active Agent lookups made by the provider. */
  public queryCount = 0;

  /** Routes one stale pre-read and one authoritative update response. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`) {
      this.queryCount += 1;
      return pageResults([activeAgentLifecyclePage([ids.task])]);
    }
    if (
      request.method === "PATCH" &&
      request.path === `/v1/pages/${ids.childRun}`
    )
      return {
        ...activeAgentLifecyclePage([], false, {
          "Finished At": dateProperty("2026-08-17T12:01:00.000Z"),
          Outcome: richTextProperty("rich_text", "completed work"),
          Status: selectProperty("Completed"),
        }),
        last_edited_time: "2026-08-17T12:01:00.000Z",
      };
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Captures the properties used to create an Active Agent page. */
class ActiveAgentCreationTransport implements NotionTransport {
  /** Properties from the most recent Active Agent creation request. */
  public createdProperties: JsonObject | null = null;
  /** Number of indexed Active Agent lookups made by the provider. */
  public queryCount = 0;

  /** Routes Active Agent lookup and creation requests. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.activeAgents}/query`) {
      this.queryCount += 1;
      return pageResults([]);
    }
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
      return activeAgentLifecyclePage([ids.task], false, {
        "Working Directory": richTextProperty(
          "rich_text",
          activeAgentWorkingDirectory,
        ),
      });
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
  /** Creates a Task fixture under the requested data source. */
  public constructor(private readonly parentId: string = ids.tasks) {}

  /** Routes the reads and writes required by a Task body update. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.method === "GET" && request.path === `/v1/pages/${ids.task}`)
      return page(
        ids.task,
        {
          Dependencies: relationProperty([]),
          Priority: { number: 15, type: "number" },
          Status: selectProperty("In Planning (AI)"),
          Task: richTextProperty("title", "Plan work"),
          Type: selectProperty("Feature"),
        },
        this.parentId,
      );
    if (request.path === `/v1/pages/${ids.task}/markdown`) {
      if (request.method === "GET")
        return {
          markdown: this.markdown,
          truncated: false,
          unknown_block_ids: [],
        };
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

/** Serves an empty but complete Markdown representation for a valid Task. */
class EmptyTaskBodyTransport extends TaskBodyTransport {
  /** Overrides only the Task body read. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (
      request.method === "GET" &&
      request.path === `/v1/pages/${ids.task}/markdown`
    )
      return { markdown: "", truncated: false, unknown_block_ids: [] };
    return super.request(request);
  }
}

/** Marks the otherwise valid Task Dependencies relation as truncated. */
class TruncatedTaskRelationTransport extends TaskBodyTransport {
  /** Overrides only the Task metadata read. */
  public override async request(request: NotionRequest): Promise<JsonObject> {
    if (request.method === "GET" && request.path === `/v1/pages/${ids.task}`)
      return page(ids.task, {
        Dependencies: { has_more: true, relation: [], type: "relation" },
        Priority: { number: 15, type: "number" },
        Status: selectProperty("In Planning (AI)"),
        Task: richTextProperty("title", "Plan work"),
        Type: selectProperty("Feature"),
      });
    return super.request(request);
  }
}

/** Fails Error Markdown replacement and records any premature status patch. */
class FailingErrorResolutionTransport implements NotionTransport {
  /** Number of Error property patches attempted by the provider. */
  public statusPatches = 0;

  /** Routes the reads and failed write required by Error resolution. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.errors}/query`)
      return pageResults([
        page(ids.badAgent, {
          "Active Agent": relationProperty([]),
          Agent: relationProperty([]),
          Error: richTextProperty("title", "Retry blocked"),
          "Error Key": richTextProperty("rich_text", "retry-chain"),
          "Fixed At": dateProperty(null),
          Severity: selectProperty("High"),
          Source: selectProperty("System"),
          Status: selectProperty("Open"),
          Task: relationProperty([]),
        }),
      ]);
    if (request.path === `/v1/pages/${ids.badAgent}/markdown`) {
      if (request.method === "GET")
        return {
          markdown:
            "## Error Description\n\nRetry limit reached.\n\n## Error Resolution\n\n",
          truncated: false,
          unknown_block_ids: [],
        };
      throw new Error("Markdown update failed");
    }
    if (request.path === `/v1/pages/${ids.badAgent}`) {
      this.statusPatches += 1;
      return {};
    }
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Captures newly created Error Markdown and serves it back for decoding. */
class ErrorRoundTripTransport implements NotionTransport {
  /** Source select label captured from the create-page request. */
  public createdSource: string | null = null;
  /** Text-fragment lengths captured from the Error title payload. */
  public createdTitleFragmentLengths: number[] = [];
  /** Canonical Markdown captured from the create-page request. */
  private markdown: string | null = null;

  /** Routes the create/read sequence used by Error reporting. */
  public async request(request: NotionRequest): Promise<JsonObject> {
    if (request.path === `/v1/data_sources/${ids.errors}/query`)
      return pageResults(
        this.markdown === null
          ? []
          : [
              page(ids.badAgent, {
                "Active Agent": relationProperty([]),
                Agent: relationProperty([]),
                Error: richTextProperty("title", "Heading-safe Error"),
                "Error Key": richTextProperty(
                  "rich_text",
                  "heading-round-trip",
                ),
                "Fixed At": dateProperty(null),
                Severity: selectProperty("Medium"),
                Source: selectProperty("AI"),
                Status: selectProperty("Open"),
                Task: relationProperty([]),
              }),
            ],
      );
    if (request.method === "POST" && request.path === "/v1/pages") {
      assert.ok(
        request.body !== undefined &&
          request.body !== null &&
          typeof request.body === "object" &&
          !Array.isArray(request.body) &&
          typeof request.body.markdown === "string",
      );
      this.markdown = request.body.markdown;
      /** Created Error properties captured to verify canonical select labels. */
      const properties = request.body.properties;
      assert.ok(
        properties !== null &&
          typeof properties === "object" &&
          !Array.isArray(properties),
      );
      /** Source property captured from the create payload. */
      const source = properties.Source;
      assert.ok(
        source !== null && typeof source === "object" && !Array.isArray(source),
      );
      /** Selected Source option captured from the property. */
      const selected = source.select;
      assert.ok(
        selected !== null &&
          typeof selected === "object" &&
          !Array.isArray(selected) &&
          typeof selected.name === "string",
      );
      this.createdSource = selected.name;
      /** Error title property captured from the create payload. */
      const errorTitle = properties.Error;
      assert.ok(
        errorTitle !== null &&
          typeof errorTitle === "object" &&
          !Array.isArray(errorTitle) &&
          Array.isArray(errorTitle.title),
      );
      this.createdTitleFragmentLengths = errorTitle.title.map((entry) => {
        assert.ok(
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
        );
        /** Text object captured from one title fragment. */
        const text = entry.text;
        assert.ok(text !== null && typeof text === "object");
        assert.ok(!Array.isArray(text) && typeof text.content === "string");
        return text.content.length;
      });
      return { id: ids.badAgent };
    }
    if (request.path === `/v1/pages/${ids.badAgent}/markdown`)
      return {
        markdown: this.markdown ?? "",
        truncated: false,
        unknown_block_ids: [],
      };
    throw new Error(
      `Unexpected Notion request: ${request.method} ${request.path}`,
    );
  }
}

/** Renders an Agent-definition section with a chosen command policy. */
function agentMarkdown(commands: string): string {
  return `## Agent definition

\`\`\`json
{"schema":"agent-definition-v1","enabled":true,"commands":${commands},"allowedTaskTypes":["Feature"],"allowedStatuses":["In progress"],"id":"code-reviewer","model":"gpt-5.6-sol","reasoning":"high","inputResourceSelectors":["agent-policy/review","schema/result-v1"],"promptResources":["prompt/code-reviewer"],"transitions":{"succeeded":"In progress","blocked":"Blocked"}}
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
    Agent: relationProperty([ids.agent]),
    "Agent Version": richTextProperty("rich_text", "agent-version"),
    Archived: { checkbox: false, type: "checkbox" },
    Attempt: { number: 1, type: "number" },
    "Completion Task Status": richTextProperty("rich_text", ""),
    "Failure Summary": richTextProperty("rich_text", ""),
    "Finished At": dateProperty(null),
    "Harness ID": richTextProperty("rich_text", "harness"),
    "Last Heartbeat": dateProperty("2026-08-17T12:00:00.000Z"),
    Outcome: richTextProperty("rich_text", ""),
    Parent: relationProperty(parentId === undefined ? [] : [parentId]),
    "Restart Of": relationProperty(restartId === undefined ? [] : [restartId]),
    "Retry Key": richTextProperty("rich_text", runId),
    "Run ID": richTextProperty("title", runId),
    "Started At": dateProperty("2026-08-17T12:00:00.000Z"),
    Status: selectProperty("Running"),
    Task: relationProperty([ids.task]),
    "Task ID": richTextProperty("rich_text", ids.task),
    "Working Directory": richTextProperty("rich_text", ""),
  });
}

/** Builds the running Active Agent page used by lifecycle tests. */
function activeAgentLifecyclePage(
  taskIds: readonly string[],
  archived = false,
  overrides: JsonObject = {},
): JsonObject {
  return page(ids.childRun, {
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
    Parent: relationProperty([]),
    "Restart Of": relationProperty([]),
    "Retry Key": richTextProperty("rich_text", "child"),
    "Run ID": richTextProperty("title", "child"),
    "Started At": dateProperty("2026-08-17T12:00:00.000Z"),
    Status: selectProperty("Running"),
    Task: relationProperty(taskIds),
    "Task ID": richTextProperty("rich_text", ids.task),
    "Working Directory": richTextProperty("rich_text", ""),
    ...overrides,
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
function page(
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
