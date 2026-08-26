/** Notion implementation of the simplified provider contract. */
import { type JsonObject, type JsonValue } from "../../domain/json.js";
import type { ValidationReport, WorkspacePlan } from "../../domain/provider.js";
import type {
  ActiveAgentRecord,
  AgentDefinition,
  AgentRecord,
  ErrorRecord,
  ReportErrorInput,
  ResourceRecord,
  TaskRecord,
} from "../../domain/records.js";
import type {
  ActiveAgentPatch,
  AgentTaskProvider,
  CreateActiveAgentRecord,
} from "../agent-task-provider.js";
import type { NotionTransport } from "./notion-transport.js";
import { normalizeNotionId as normalizeId } from "./notion-id.js";
import { NotionProviderRuntime } from "./provider/runtime.js";
import { NotionWorkspace } from "./provider/workspace.js";
import {
  checkbox,
  date,
  detachedTaskProperties,
  errorMarkdown,
  errorSourceLabel,
  relation,
  requirePresent,
  requiredString,
  richText,
  select,
  title,
  toSelectLabel,
} from "./provider/values.js";

/** AgentTaskProvider backed by the configured Notion data sources. */
export class NotionProvider
  extends NotionProviderRuntime
  implements AgentTaskProvider
{
  /** Workspace schema boundary sharing this provider's transport and table IDs. */
  private readonly workspace: NotionWorkspace;

  /** Creates a provider over decoded Notion options and a transport. */
  public constructor(
    environment: ConstructorParameters<typeof NotionProviderRuntime>[0],
    transport: NotionTransport,
  ) {
    super(environment, transport);
    this.workspace = new NotionWorkspace(environment, transport, this.tables, {
      markdown: (pageId) => this.markdown(pageId),
      query: (kind, filter) => this.query(kind, filter),
    });
  }

  /** @inheritdoc */
  public validateEnvironment(): Promise<ValidationReport> {
    return this.workspace.validateEnvironment();
  }

  /** @inheritdoc */
  public validateWorkspace(): Promise<ValidationReport> {
    return this.workspace.validateWorkspace();
  }

  /** @inheritdoc */
  public planWorkspace(environmentId: string): Promise<WorkspacePlan> {
    return this.workspace.planWorkspace(environmentId);
  }

  /** @inheritdoc */
  public applyWorkspacePlan(
    plan: WorkspacePlan,
  ): Promise<Readonly<Record<string, string>>> {
    return this.workspace.applyWorkspacePlan(plan);
  }

  /** @inheritdoc */
  public async listTasks(status?: string): Promise<readonly TaskRecord[]> {
    /** Task pages returned by the optional status query. */
    const pages = await this.query(
      "tasks",
      status === undefined
        ? undefined
        : { property: "Status", select: { equals: status } },
    );
    return Promise.all(pages.map((page) => this.decodeTask(page)));
  }

  /** @inheritdoc */
  public async getTask(id: string): Promise<TaskRecord | null> {
    /** Managed Task page selected by provider ID. */
    const page = await this.pageOrNull(id);
    if (page === null) return null;
    this.assertManagedPage(page, "tasks");
    return this.decodeTask(page);
  }

  /** @inheritdoc */
  public async setTaskStatus(
    id: string,
    expectedStatus: string,
    expectedVersion: string,
    status: string,
  ): Promise<TaskRecord> {
    /** Current managed Task verified before any provider mutation. */
    const page = requirePresent(
      await this.pageOrNull(id),
      `Task not found: ${id}`,
    );
    this.assertManagedPage(page, "tasks");
    /** Decoded Task snapshot checked for optimistic status consistency. */
    const current = await this.decodeTask(page);
    if (
      current.status !== expectedStatus ||
      current.version !== expectedVersion
    )
      throw new Error("Task changed before status update");
    await this.transport.request({
      body: { properties: { Status: select(status) } },
      method: "PATCH",
      path: `/v1/pages/${normalizeId(id)}`,
    });
    return requirePresent(
      await this.getTask(id),
      `Task not found after update: ${id}`,
    );
  }

  /** @inheritdoc */
  public async updateTaskBody(
    id: string,
    expectedBody: string,
    body: string,
  ): Promise<TaskRecord> {
    /** Current managed Task verified before any provider mutation. */
    const page = requirePresent(
      await this.pageOrNull(id),
      `Task not found: ${id}`,
    );
    this.assertManagedPage(page, "tasks");
    await this.transport.request({
      body: {
        type: "update_content",
        update_content: {
          content_updates: [{ new_str: body, old_str: expectedBody }],
        },
      },
      method: "PATCH",
      path: `/v1/pages/${normalizeId(id)}/markdown`,
    });
    return requirePresent(
      await this.getTask(id),
      `Task not found after description update: ${id}`,
    );
  }

  /** @inheritdoc */
  public async listAgents(): Promise<readonly AgentRecord[]> {
    /** Agent pages and Resource-key index loaded concurrently. */
    const [pages, resourceIdByKey] = await Promise.all([
      this.query("agents"),
      this.resourceIdByKey(),
    ]);
    return Promise.all(
      pages.map((page) => this.decodeAgent(page, resourceIdByKey)),
    );
  }

  /** @inheritdoc */
  public async getAgent(agentId: string): Promise<AgentRecord | null> {
    /** Managed Agent page selected by provider ID. */
    const page = await this.pageOrNull(agentId);
    if (page === null) return null;
    this.assertManagedPage(page, "agents");
    return this.decodeAgent(page, await this.resourceIdByKey());
  }

  /** @inheritdoc */
  public async getAgentByKey(key: string): Promise<AgentRecord | null> {
    /** Agent definitions whose declared ID matches the requested key. */
    const matches: Array<{
      /** Authoritative Markdown body of the provider record. */
      body: string;
      /** Strict Agent definition parsed from authoritative Markdown. */
      definition: AgentDefinition;
      /** Notion page selected for decoding or mutation. */
      page: JsonObject;
    }> = [];
    for (const page of await this.query("agents")) {
      try {
        /** Agent body and metadata proven to come from the same version. */
        const stable = await this.stableAgentDefinition(page);
        if (stable.definition.id === key) matches.push(stable);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    if (matches.length > 1)
      throw new Error(`Agent definition id is not unique: ${key}`);
    /** Single validated match selected after uniqueness checks. */
    const match = matches[0];
    if (match === undefined) return null;
    return this.agentRecord(
      match.page,
      match.body,
      match.definition,
      await this.resourceIdByKey(),
    );
  }

  /** @inheritdoc */
  public async listResources(): Promise<readonly ResourceRecord[]> {
    return Promise.all(
      (await this.query("resources")).map((page) => this.decodeResource(page)),
    );
  }

  /** @inheritdoc */
  public async getResourceByKey(key: string): Promise<ResourceRecord | null> {
    /** Resource pages returned by the key-filtered query. */
    const pages = await this.query("resources", {
      property: "Resource",
      title: { equals: key },
    });
    if (pages.length > 1) throw new Error(`Resource Key is not unique: ${key}`);
    /** Unique Resource page selected by stable key. */
    const page = pages[0];
    return page === undefined ? null : this.decodeResource(page);
  }

  /** @inheritdoc */
  public async listActiveAgents(): Promise<readonly ActiveAgentRecord[]> {
    return (await this.activeRecords(await this.query("activeAgents"))).filter(
      (record) => !record.archived,
    );
  }

  /** @inheritdoc */
  public async getActiveAgent(
    runId: string,
  ): Promise<ActiveAgentRecord | null> {
    /** Active Agent pages returned by the Run ID query. */
    const pages = await this.query("activeAgents", {
      property: "Run ID",
      title: { equals: runId },
    });
    if (pages.length > 1) throw new Error(`Run ID is not unique: ${runId}`);
    /** Active Agent records decoded from the matching pages. */
    const records = await this.activeRecords(pages);
    return records[0] ?? null;
  }

  /** @inheritdoc */
  public async createActiveAgent(
    input: CreateActiveAgentRecord,
  ): Promise<ActiveAgentRecord> {
    if ((await this.getActiveAgent(input.runId)) !== null)
      throw new Error(`Run ID already exists: ${input.runId}`);
    /** Parent Active Agent resolved from the supplied run ID. */
    const parent =
      input.parentRunId === null
        ? null
        : await this.getActiveAgent(input.parentRunId);
    /** Prior attempt referenced by the replacement run. */
    const restart =
      input.restartOfRunId === null
        ? null
        : await this.getActiveAgent(input.restartOfRunId);
    /** Created Active Agent page returned by Notion. */
    const page = await this.transport.request({
      body: {
        parent: { data_source_id: this.requiredTableId("activeAgents") },
        properties: {
          "Run ID": title(input.runId),
          Archived: checkbox(false),
          Agent: relation([input.agentId]),
          "Agent Version": richText(input.agentVersion),
          Task: relation([input.taskId]),
          "Task ID": richText(input.taskId),
          Parent: relation(parent === null ? [] : [parent.id]),
          "Restart Of": relation(restart === null ? [] : [restart.id]),
          "Retry Key": richText(input.retryKey),
          Attempt: { number: input.attempt },
          Status: select("Running"),
          "Harness ID": richText(input.harnessId),
          "Started At": date(input.startedAt),
          "Last Heartbeat": date(input.startedAt),
          "Finished At": date(null),
          Outcome: richText(""),
          "Completion Task Status": richText(""),
          "Failure Summary": richText(""),
          "Working Directory": richText(input.workingDirectory ?? ""),
        },
      },
      method: "POST",
      path: "/v1/pages",
    });
    return requirePresent(
      (await this.activeRecords([page]))[0],
      `Created Active Agent is unavailable: ${requiredString(page.id, "Created page id")}`,
    );
  }

  /** @inheritdoc */
  public async updateActiveAgent(
    runId: string,
    patch: ActiveAgentPatch,
  ): Promise<ActiveAgentRecord> {
    /** Current provider record loaded before applying a mutation. */
    const current = requirePresent(
      await this.getActiveAgent(runId),
      `Active Agent not found: ${runId}`,
    );
    /** Notion property patch derived from supplied Active Agent fields. */
    const properties: Record<string, JsonValue> = {};
    if (patch.status !== undefined)
      properties.Status = select(toSelectLabel(patch.status));
    if (patch.lastHeartbeat !== undefined)
      properties["Last Heartbeat"] = date(patch.lastHeartbeat);
    if (patch.finishedAt !== undefined)
      properties["Finished At"] = date(patch.finishedAt);
    if (patch.outcome !== undefined)
      properties.Outcome = richText(patch.outcome);
    if (patch.completionTaskStatus !== undefined)
      properties["Completion Task Status"] = richText(
        patch.completionTaskStatus,
      );
    if (patch.failureSummary !== undefined)
      properties["Failure Summary"] = richText(patch.failureSummary);
    if (patch.status !== undefined && patch.status !== "running")
      Object.assign(properties, detachedTaskProperties(current.taskId));
    /** Authoritative Notion page returned by the mutation. */
    const page = await this.transport.request({
      body: { properties },
      method: "PATCH",
      path: `/v1/pages/${current.id}`,
    });
    return requirePresent(
      (await this.activeRecords([page]))[0],
      `Updated Active Agent is unavailable: ${runId}`,
    );
  }

  /** @inheritdoc */
  public async archiveActiveAgent(runId: string): Promise<void> {
    /** Current provider record loaded before applying a mutation. */
    const current = requirePresent(
      await this.getActiveAgent(runId),
      `Active Agent not found: ${runId}`,
    );
    await this.transport.request({
      body: {
        properties: {
          Archived: checkbox(true),
          ...detachedTaskProperties(current.taskId),
        },
      },
      method: "PATCH",
      path: `/v1/pages/${current.id}`,
    });
  }

  /** @inheritdoc */
  public async listErrors(): Promise<readonly ErrorRecord[]> {
    return Promise.all(
      (await this.query("errors")).map((page) => this.decodeError(page)),
    );
  }

  /** @inheritdoc */
  public async getErrorByKey(key: string): Promise<ErrorRecord | null> {
    /** Error pages returned by the Error Key query. */
    const pages = await this.query("errors", {
      property: "Error Key",
      rich_text: { equals: key },
    });
    if (pages.length > 1) throw new Error(`Error Key is not unique: ${key}`);
    /** Unique Error page selected by stable key. */
    const page = pages[0];
    return page === undefined ? null : this.decodeError(page);
  }

  /** @inheritdoc */
  public async reportError(input: ReportErrorInput): Promise<ErrorRecord> {
    /** Existing Error selected for an idempotent update. */
    const existing = await this.getErrorByKey(input.errorKey);
    /** Canonical Notion properties for the reported Error. */
    const properties = {
      Error: title(input.title),
      "Error Key": richText(input.errorKey),
      Source: select(errorSourceLabel(input.source)),
      Severity: select(toSelectLabel(input.severity)),
      Status: select("Open"),
      Task: relation(input.taskId === null ? [] : [input.taskId]),
      Agent: relation(input.agentId === null ? [] : [input.agentId]),
      "Active Agent": relation(
        input.activeAgentId === null ? [] : [input.activeAgentId],
      ),
      "Fixed At": date(null),
    };
    /** Canonical Markdown rendered for the provider page. */
    const markdown = errorMarkdown(input.description, input.resolution);
    if (existing === null) {
      await this.transport.request({
        body: {
          markdown,
          parent: { data_source_id: this.requiredTableId("errors") },
          properties,
        },
        method: "POST",
        path: "/v1/pages",
      });
    } else {
      await this.transport.request({
        body: { properties },
        method: "PATCH",
        path: `/v1/pages/${existing.id}`,
      });
      await this.replaceMarkdown(existing.id, markdown);
    }
    return requirePresent(
      await this.getErrorByKey(input.errorKey),
      `Reported Error is unavailable: ${input.errorKey}`,
    );
  }

  /** @inheritdoc */
  public async resolveError(
    key: string,
    resolution: string,
  ): Promise<ErrorRecord> {
    /** Current provider record loaded before applying a mutation. */
    const current = requirePresent(
      await this.getErrorByKey(key),
      `Error not found: ${key}`,
    );
    await this.replaceMarkdown(
      current.id,
      errorMarkdown(current.description, resolution),
    );
    await this.transport.request({
      body: {
        properties: {
          Status: select("Resolved"),
          "Fixed At": date(new Date().toISOString()),
        },
      },
      method: "PATCH",
      path: `/v1/pages/${current.id}`,
    });
    return requirePresent(
      await this.getErrorByKey(key),
      `Resolved Error is unavailable: ${key}`,
    );
  }
}
