/** Notion implementation of the simplified provider contract. */
import { isAbsolute } from "node:path";

import { digestJson, sha256 } from "../../core/digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../domain/json.js";
import {
  TABLE_KINDS,
  type ProviderEnvironment,
  type TableKind,
  type ValidationIssue,
  type ValidationReport,
  type WorkspacePlan,
  type WorkspaceStep,
} from "../../domain/provider.js";
import {
  parseAgentDefinition,
  type ActiveAgentRecord,
  type AgentDefinition,
  type AgentRecord,
  type ErrorRecord,
  type ErrorSeverity,
  type ErrorSource,
  type ReportErrorInput,
  type ResourceRecord,
  type ResourceState,
  type TaskRecord,
} from "../../domain/records.js";
import type {
  ActiveAgentPatch,
  AgentTaskProvider,
  CreateActiveAgentRecord,
} from "../agent-task-provider.js";
import { normalizeNotionId as normalizeId } from "./notion-id.js";
import {
  NOTION_SCHEMA_DIGEST,
  NOTION_TABLES,
  notionTable,
  type NotionPropertyDescriptor,
  type NotionTableDescriptor,
} from "./notion-schema.js";
import {
  asObject,
  collectNotionPages,
  decodeCompletePageMarkdown,
  NotionApiError,
  type NotionTransport,
} from "./notion-transport.js";

/** Observed type mismatch for one managed Notion property. */
interface WorkspacePropertyMismatch {
  /** Observed Notion property type. */
  readonly actual: string;
  /** Canonical descriptor used as the expected value. */
  readonly property: NotionPropertyDescriptor;
}

/** Non-mutating comparison of one configured table with its canonical schema. */
interface WorkspaceSchemaInspection {
  /** Whether the managed Notion table has a configured data source. */
  readonly configured: boolean;
  /** Configured properties whose Notion types differ from the canonical schema. */
  readonly mismatched: readonly WorkspacePropertyMismatch[];
  /** Canonical properties absent from the configured Notion table. */
  readonly missing: readonly NotionPropertyDescriptor[];
  /** Complete observed property schema used for apply-time drift detection. */
  readonly observedProperties: JsonObject | null;
  /** Managed table affected by the operation. */
  readonly table: NotionTableDescriptor;
}

/** AgentTaskProvider backed by the configured Notion data sources. */
export class NotionProvider implements AgentTaskProvider {
  /** Configured data-source IDs indexed by domain table kind. */
  readonly #tables: Record<TableKind, string | null>;
  /** Creates a provider over a validated environment and transport. */
  public constructor(
    private readonly environment: ProviderEnvironment,
    private readonly transport: NotionTransport,
  ) {
    this.#tables = { ...environment.tables };
  }

  /** @inheritdoc */
  public async validateEnvironment(): Promise<ValidationReport> {
    /** Validation issues accumulated without failing the remaining checks. */
    const issues: ValidationIssue[] = [];
    if (this.environment.type !== "notion")
      issues.push(
        validationIssue(
          "provider_type",
          "provider.type",
          "Provider type must be notion",
        ),
      );
    if (this.environment.bootstrapParent === null)
      issues.push(
        validationIssue(
          "bootstrap_parent",
          "provider.bootstrapParent",
          "Bootstrap parent is required",
        ),
      );
    return { issues, valid: issues.length === 0 };
  }

  /** @inheritdoc */
  public async validateWorkspace(): Promise<ValidationReport> {
    /** Validation issues accumulated without failing the remaining checks. */
    const issues: ValidationIssue[] = [];
    for (const inspection of await this.inspectWorkspaceSchema()) {
      /** Canonical managed-table descriptor for the current operation. */
      const { table } = inspection;
      if (!inspection.configured) {
        issues.push(
          validationIssue(
            "missing_table",
            `provider.tables.${table.kind}`,
            `${table.title} is not configured`,
          ),
        );
        continue;
      }
      for (const property of inspection.missing)
        if (property.required)
          issues.push(
            validationIssue(
              "missing_property",
              `${table.title}.${property.name}`,
              "Required property is missing",
            ),
          );
      for (const { actual, property } of inspection.mismatched)
        issues.push(
          validationIssue(
            "property_type",
            `${table.title}.${property.name}`,
            `Expected ${property.type}, received ${actual}`,
          ),
        );
    }
    await this.validateAgentSemantics(issues);
    return { issues, valid: issues.length === 0 };
  }

  /** @inheritdoc */
  public async planWorkspace(environmentId: string): Promise<WorkspacePlan> {
    await this.discoverManagedTables();
    /** Ordered workspace mutations authorized by the plan. */
    const steps: WorkspaceStep[] = [];
    /** Exact provider state from which the additive plan is derived. */
    const inspections = await this.inspectWorkspaceSchema();
    for (const inspection of inspections) {
      /** Canonical managed-table descriptor for the current operation. */
      const { table } = inspection;
      if (!inspection.configured) {
        steps.push({
          id: `create:${table.kind}`,
          kind: "create_table",
          payload: { title: table.title },
          table: table.kind,
        });
        for (const property of table.properties.filter(
          (entry) => entry.relation !== null,
        ))
          steps.push({
            id: `property:${table.kind}:${property.name}`,
            kind: "add_property",
            payload: { name: property.name },
            table: table.kind,
          });
        continue;
      }
      if (inspection.mismatched.length > 0) {
        /** First incompatible schema property that blocks planning. */
        const mismatch = inspection.mismatched[0]!;
        throw new Error(
          `Cannot plan incompatible property ${table.title}.${mismatch.property.name}: expected ${mismatch.property.type}, received ${mismatch.actual}`,
        );
      }
      for (const property of inspection.missing)
        steps.push({
          id: `property:${table.kind}:${property.name}`,
          kind: "add_property",
          payload: { name: property.name },
          table: table.kind,
        });
    }
    /** Serialized fields covered by the deterministic digest. */
    const core = {
      environmentId,
      observedSchemaDigest: this.workspaceInspectionDigest(inspections),
      schema: "workspace-plan-v1" as const,
      steps,
      target: this.workspaceTarget(),
      targetSchemaDigest: NOTION_SCHEMA_DIGEST,
    };
    return { ...core, digest: digestJson(toJsonValue(core)) };
  }

  /** Reuses uniquely named managed databases already created under the bootstrap page. */
  private async discoverManagedTables(): Promise<void> {
    if (
      this.environment.bootstrapParent === null ||
      TABLE_KINDS.every((kind) => this.#tables[kind] !== null)
    )
      return;
    /** Non-trashed child databases beneath the configured bootstrap page. */
    const children = await collectNotionPages((cursor) =>
      this.transport.request({
        method: "GET",
        path: `/v1/blocks/${normalizeId(this.environment.bootstrapParent!)}/children?page_size=100${
          cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`
        }`,
      }),
    );
    for (const table of NOTION_TABLES) {
      if (this.#tables[table.kind] !== null) continue;
      /** Existing databases with the exact canonical managed title. */
      const matches = children.filter((child) => {
        if (child.type !== "child_database" || child.in_trash === true)
          return false;
        return (
          requiredString(
            requireJsonObject(child.child_database, "Child database").title,
            "Child database title",
          ) === table.title
        );
      });
      if (matches.length > 1)
        throw new Error(
          `Multiple ${table.title} databases exist under the bootstrap page`,
        );
      /** Unique child database matching the canonical managed title. */
      const match = matches[0];
      if (match === undefined) continue;
      /** Database metadata used to resolve its unique data source. */
      const database = await this.transport.request({
        method: "GET",
        path: `/v1/databases/${normalizeId(requiredString(match.id, "Child database id"))}`,
      });
      if (
        !Array.isArray(database.data_sources) ||
        database.data_sources.length !== 1
      )
        throw new Error(
          `${table.title} database must contain exactly one data source`,
        );
      this.#tables[table.kind] = requiredString(
        requireJsonObject(database.data_sources[0], "Managed data source").id,
        "Managed data source id",
      );
    }
  }

  /** Compares configured Notion data sources with the canonical schema. */
  private async inspectWorkspaceSchema(): Promise<
    readonly WorkspaceSchemaInspection[]
  > {
    /** Schema inspection results accumulated in canonical table order. */
    const inspections: WorkspaceSchemaInspection[] = [];
    for (const table of NOTION_TABLES) {
      /** Provider-owned record identifier. */
      const id = this.#tables[table.kind];
      if (id === null) {
        inspections.push({
          configured: false,
          mismatched: [],
          missing: table.properties,
          observedProperties: null,
          table,
        });
        continue;
      }
      /** Current data-source schema returned by Notion. */
      const source = await this.transport.request({
        method: "GET",
        path: `/v1/data_sources/${normalizeId(id)}`,
      });
      /** Provider properties encoded or decoded for the current record. */
      const properties = requireJsonObject(
        source.properties,
        `${table.title} properties`,
      );
      /** Canonical properties absent from the observed schema. */
      const missing: NotionPropertyDescriptor[] = [];
      /** Configured properties whose Notion types differ from the canonical schema. */
      const mismatched: WorkspacePropertyMismatch[] = [];
      for (const property of table.properties) {
        /** Observed provider value compared with the canonical expectation. */
        const observed = properties[property.name];
        if (observed === undefined) {
          missing.push(property);
          continue;
        }
        /** Complete observed property contract compared with the canonical schema. */
        const actual = propertyContractMismatch(
          property,
          requireJsonObject(observed, property.name),
          this.#tables,
        );
        if (actual !== null) mismatched.push({ actual, property });
      }
      inspections.push({
        configured: true,
        mismatched,
        missing,
        observedProperties: properties,
        table,
      });
    }
    return inspections;
  }

  /** @inheritdoc */
  public async applyWorkspacePlan(
    plan: WorkspacePlan,
  ): Promise<Readonly<Record<string, string>>> {
    /** Serialized fields covered by the deterministic digest. */
    const core = {
      environmentId: plan.environmentId,
      observedSchemaDigest: plan.observedSchemaDigest,
      schema: plan.schema,
      steps: plan.steps,
      target: plan.target,
      targetSchemaDigest: plan.targetSchemaDigest,
    };
    if (plan.digest !== digestJson(toJsonValue(core)))
      throw new Error("Workspace plan digest is invalid");
    if (
      digestJson(toJsonValue(plan.target)) !==
      digestJson(toJsonValue(this.workspaceTarget()))
    )
      throw new Error("Workspace plan target does not match the provider");
    if (
      plan.observedSchemaDigest !==
      this.workspaceInspectionDigest(await this.inspectWorkspaceSchema())
    )
      throw new Error("Workspace schema changed after the plan was created");
    for (const step of plan.steps.filter(
      (entry) => entry.kind === "create_table",
    ))
      await this.createTable(step.table);
    for (const step of plan.steps.filter(
      (entry) => entry.kind === "add_property",
    )) {
      /** Human-readable display name. */
      const name = requiredString(step.payload.name, "Workspace property name");
      /** Canonical schema descriptor for the requested property. */
      const descriptor = notionTable(step.table).properties.find(
        (entry) => entry.name === name,
      );
      if (descriptor === undefined)
        throw new Error(`Unknown property ${step.table}.${name}`);
      await this.addProperty(step.table, descriptor);
    }
    return Object.fromEntries(
      Object.entries(this.#tables).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    );
  }

  /** Returns the normalized provider target covered by workspace authorization. */
  private workspaceTarget(): WorkspacePlan["target"] {
    return {
      bootstrapParent:
        this.environment.bootstrapParent === null
          ? null
          : normalizeId(this.environment.bootstrapParent),
      tables: Object.fromEntries(
        TABLE_KINDS.map((kind) => [
          kind,
          this.#tables[kind] === null ? null : normalizeId(this.#tables[kind]),
        ]),
      ) as Record<TableKind, string | null>,
    };
  }

  /** Digests the exact configured IDs and observed property schemas. */
  private workspaceInspectionDigest(
    inspections: readonly WorkspaceSchemaInspection[],
  ): string {
    return digestJson(
      toJsonValue(
        inspections.map((inspection) => ({
          configured: inspection.configured,
          properties: inspection.observedProperties,
          table: inspection.table.kind,
          tableId: this.#tables[inspection.table.kind],
        })),
      ),
    );
  }

  /** @inheritdoc */
  public async listTasks(status?: string): Promise<readonly TaskRecord[]> {
    /** Notion pages returned by the bounded query. */
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
    /** Notion page selected or decoded by the current operation. */
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
    /** Notion page selected or decoded by the current operation. */
    const page = await this.pageOrNull(agentId);
    if (page === null) return null;
    this.assertManagedPage(page, "agents");
    return this.decodeAgent(page, await this.resourceIdByKey());
  }

  /** @inheritdoc */
  public async getAgentByKey(key: string): Promise<AgentRecord | null> {
    /** All candidates matching the requested stable key. */
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
    /** Notion pages returned by the bounded query. */
    const pages = await this.query("resources", {
      property: "Resource",
      title: { equals: key },
    });
    if (pages.length > 1) throw new Error(`Resource Key is not unique: ${key}`);
    /** Notion page selected or decoded by the current operation. */
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
    /** Notion pages returned by the bounded query. */
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
    /** Notion page selected or decoded by the current operation. */
    const page = await this.transport.request({
      body: {
        parent: { data_source_id: this.table("activeAgents") },
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
    /** Provider properties encoded or decoded for the current record. */
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
    /** Notion pages returned by the bounded query. */
    const pages = await this.query("errors", {
      property: "Error Key",
      rich_text: { equals: key },
    });
    if (pages.length > 1) throw new Error(`Error Key is not unique: ${key}`);
    /** Notion page selected or decoded by the current operation. */
    const page = pages[0];
    return page === undefined ? null : this.decodeError(page);
  }

  /** @inheritdoc */
  public async reportError(input: ReportErrorInput): Promise<ErrorRecord> {
    /** Existing record selected for an idempotent update. */
    const existing = await this.getErrorByKey(input.errorKey);
    /** Provider properties encoded or decoded for the current record. */
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
          parent: { data_source_id: this.table("errors") },
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

  /** Decodes a Task record from its Notion page and Markdown. */
  private async decodeTask(page: JsonObject): Promise<TaskRecord> {
    /** Decoded Notion properties for the current page. */
    const props = pageProperties(page);
    return {
      archived: archived(page),
      body: await this.markdown(notionPageId(page)),
      dependencies: relationIds(props.Dependencies),
      id: notionPageId(page),
      priority: numberValue(props.Priority),
      properties: plainProperties(props),
      status: selectValue(props.Status),
      title: textValue(props.Task),
      type: selectValue(props.Type),
      version: notionPageVersion(page),
    };
  }

  /** Decodes an Agent record from a stable Notion page and body. */
  private async decodeAgent(
    page: JsonObject,
    resourceIdByKey: ReadonlyMap<string, string>,
  ): Promise<AgentRecord> {
    /** Agent body and metadata proven to come from the same version. */
    const stable = await this.stableAgentDefinition(page);
    return this.agentRecord(
      stable.page,
      stable.body,
      stable.definition,
      resourceIdByKey,
    );
  }

  /** Retries until Agent metadata and Markdown come from one version. */
  private async stableAgentDefinition(page: JsonObject): Promise<{
    /** Authoritative Markdown body of the provider record. */
    readonly body: string;
    /** Strict Agent definition parsed from authoritative Markdown. */
    readonly definition: AgentDefinition;
    /** Notion page selected for decoding or mutation. */
    readonly page: JsonObject;
  }> {
    /** Latest Agent page metadata used to detect a torn read. */
    let metadata = page;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      /** Markdown body read or rendered for the current record. */
      const body = await this.markdown(notionPageId(metadata));
      /** Current provider record loaded before applying a mutation. */
      const current = await this.pageOrNull(notionPageId(metadata));
      if (current === null)
        throw new Error(
          `Agent page disappeared while loading: ${notionPageId(page)}`,
        );
      if (notionPageVersion(current) === notionPageVersion(metadata)) {
        /** Strict Agent definition parsed from authoritative Markdown. */
        const definition = parseAgentDefinition(body);
        return { body, definition, page: current };
      }
      metadata = current;
    }
    throw new Error(
      `Agent page changed repeatedly while loading: ${notionPageId(page)}`,
    );
  }

  /** Projects a stable Notion page and Agent definition into a domain record. */
  private agentRecord(
    page: JsonObject,
    body: string,
    definition: AgentDefinition,
    resourceIdByKey: ReadonlyMap<string, string>,
  ): AgentRecord {
    /** Decoded Notion properties for the current page. */
    const props = pageProperties(page);
    /** Provider record IDs of Resources supplied to the Agent. */
    const resourceIds = definition.resourceKeys.map((key) => {
      /** Provider ID resolved from the Agent's declared Resource key. */
      const resourceId = resourceIdByKey.get(key);
      if (resourceId === undefined)
        throw new Error(
          `Agent ${definition.id} references missing Resource: ${key}`,
        );
      return resourceId;
    });
    return {
      allowedStatuses: definition.allowedStatuses,
      allowedTaskTypes: definition.allowedTaskTypes,
      archived: archived(page),
      body,
      calledBy: definition.calledBy,
      commands: definition.commands,
      enabled: definition.enabled,
      id: notionPageId(page),
      key: definition.id,
      lifecycleCommands: definition.lifecycleCommands,
      model: definition.model,
      name: textValue(props.Name),
      notes: definition.notes,
      properties: plainProperties(props),
      reasoning: definition.reasoning,
      resourceIds,
      restartCompatibleVersions: [notionPageVersion(page)],
      taskDescription: definition.taskDescription,
      transitions: definition.transitions,
      version: agentVersion(page, body),
    };
  }

  /** Indexes Resource provider IDs by their stable keys. */
  private async resourceIdByKey(): Promise<ReadonlyMap<string, string>> {
    /** Resource provider IDs indexed by their unique stable keys. */
    const result = new Map<string, string>();
    for (const page of await this.query("resources")) {
      /** Stable domain key used for lookup. */
      const key = textValue(pageProperties(page).Resource);
      if (result.has(key))
        throw new Error(`Resource Key is not unique: ${key}`);
      result.set(key, notionPageId(page));
    }
    return result;
  }

  /** Validates agent semantics. */
  private async validateAgentSemantics(
    issues: ValidationIssue[],
  ): Promise<void> {
    if (this.#tables.agents === null || this.#tables.resources === null) return;
    /** Agent pages whose definitions require semantic validation. */
    let agentPages: readonly JsonObject[];
    /** Resource pages indexed for Agent-definition validation. */
    let resourcePages: readonly JsonObject[];
    try {
      [agentPages, resourcePages] = await Promise.all([
        this.query("agents"),
        this.query("resources"),
      ]);
    } catch (error) {
      issues.push(
        validationIssue(
          "semantic_inventory",
          "Agents",
          `Could not inventory Agent configuration: ${String(error)}`,
        ),
      );
      return;
    }
    /** Resources resolved in the Agent definition's declared order. */
    const resources = resourcePages.map((page) => {
      /** Decoded Notion properties for the current page. */
      const props = pageProperties(page);
      return {
        archived: archived(page),
        id: notionPageId(page),
        key: textValue(props.Resource),
        kind: selectValue(props.Kind),
        state: selectValue(props.State),
      };
    });
    /** Resources grouped by stable key for duplicate and selector validation. */
    const resourcesByKey = new Map<string, typeof resources>();
    for (const resource of resources) {
      /** Configuration, validation, filesystem, or provider path for this value. */
      const path = `Resources.${resource.id}`;
      if (resource.key === "")
        issues.push(
          validationIssue("resource_key", path, "Resource key is empty"),
        );
      if (!["Prompt", "Policy"].includes(resource.kind))
        issues.push(
          validationIssue(
            "resource_kind",
            path,
            `Unsupported Kind: ${resource.kind}`,
          ),
        );
      if (!["Active", "Draft", "Retired"].includes(resource.state))
        issues.push(
          validationIssue(
            "resource_state",
            path,
            `Unsupported State: ${resource.state}`,
          ),
        );
      /** All candidates matching the requested stable key. */
      const matches = resourcesByKey.get(resource.key) ?? [];
      matches.push(resource);
      resourcesByKey.set(resource.key, matches);
    }
    for (const [key, matches] of resourcesByKey)
      if (key !== "" && matches.length > 1)
        issues.push(
          validationIssue(
            "duplicate_resource_key",
            `Resources.${key}`,
            `Resource key appears ${matches.length} times`,
          ),
        );

    /** Ordered definitions used by validate agent semantics. */
    const definitions: Array<{
      /** Strict Agent definition parsed from authoritative Markdown. */
      definition: AgentDefinition;
      /** Stable page ID. */
      pageId: string;
    }> = [];
    for (const page of agentPages) {
      /** Normalized provider page ID used for uniqueness checks. */
      const pageId = notionPageId(page);
      try {
        definitions.push({
          definition: parseAgentDefinition(await this.markdown(pageId)),
          pageId,
        });
      } catch (error) {
        issues.push(
          validationIssue(
            "agent_definition",
            `Agents.${pageId}`,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
    /** Agent definitions grouped by stable ID for uniqueness validation. */
    const definitionsById = new Map<string, typeof definitions>();
    for (const entry of definitions) {
      /** All candidates matching the requested stable key. */
      const matches = definitionsById.get(entry.definition.id) ?? [];
      matches.push(entry);
      definitionsById.set(entry.definition.id, matches);
    }
    for (const [definitionId, matches] of definitionsById)
      if (matches.length > 1)
        issues.push(
          validationIssue(
            "duplicate_agent_id",
            `Agents.${definitionId}`,
            `Agent definition id appears ${matches.length} times`,
          ),
        );
    for (const { definition, pageId } of definitions)
      for (const key of definition.resourceKeys) {
        /** All candidates matching the requested stable key. */
        const matches = resourcesByKey.get(key) ?? [];
        /** Configuration, validation, filesystem, or provider path for this value. */
        const path = `Agents.${pageId}.resources.${key}`;
        if (matches.length === 0) {
          issues.push(
            validationIssue(
              "missing_resource",
              path,
              "Referenced Resource is missing",
            ),
          );
          continue;
        }
        if (matches.length > 1) continue;
        /** Resource currently resolved or validated for Agent context. */
        const resource = matches[0]!;
        if (resource.archived || resource.state !== "Active")
          issues.push(
            validationIssue(
              "unavailable_resource",
              path,
              "Referenced Resource must be active",
            ),
          );
        /** Resource kind required by the Agent selector. */
        const expectedKind = key.startsWith("prompt/") ? "Prompt" : "Policy";
        if (resource.kind !== expectedKind)
          issues.push(
            validationIssue(
              "resource_kind_mismatch",
              path,
              `Expected ${expectedKind}, received ${resource.kind}`,
            ),
          );
      }
  }

  /** Decodes a Resource record from its Notion page and Markdown. */
  private async decodeResource(page: JsonObject): Promise<ResourceRecord> {
    /** Decoded Notion properties for the current page. */
    const props = pageProperties(page);
    return {
      archived: archived(page),
      body: await this.markdown(notionPageId(page)),
      id: notionPageId(page),
      key: textValue(props.Resource),
      kind: selectValue(props.Kind),
      properties: plainProperties(props),
      state: selectValue(props.State).toLowerCase() as ResourceState,
      version: notionPageVersion(page),
    };
  }

  /** Decodes Active Agent records and validates their relations. */
  private async activeRecords(
    pages: readonly JsonObject[],
  ): Promise<readonly ActiveAgentRecord[]> {
    /** Untrusted serialized or provider response before strict conversion. */
    const raw = pages.map((page) => ({ page, props: pageProperties(page) }));
    /** Active Agent rows indexed by normalized Notion page ID. */
    const runByPage = new Map(
      raw.map(({ page, props }) => [
        normalizeId(notionPageId(page)),
        requiredTextValue(props["Run ID"], "Active Agent Run ID"),
      ]),
    );
    if (new Set(runByPage.values()).size !== runByPage.size)
      throw new Error("Active Agent Run IDs must be unique");
    /** Distinct values tracked by active records. */
    const relatedPageIds = new Set(
      raw.flatMap(({ props }) => [
        ...relationIds(props.Parent),
        ...relationIds(props["Restart Of"]),
      ]),
    );
    await Promise.all(
      [...relatedPageIds]
        .filter((pageId) => !runByPage.has(normalizeId(pageId)))
        .map(async (pageId) => {
          /** Notion page selected or decoded by the current operation. */
          const page = await this.pageOrNull(pageId);
          if (page !== null)
            runByPage.set(
              normalizeId(pageId),
              requiredTextValue(
                pageProperties(page)["Run ID"],
                "Related Active Agent Run ID",
              ),
            );
        }),
    );
    return raw.map(({ page, props }) => {
      /** At-most-one relation required by the Active Agent schema. */
      const one = (name: string, required = false): string | null => {
        /** Related Notion page IDs supplied by the property. */
        const ids = relationIds(props[name]);
        if (ids.length > 1 || (required && ids.length !== 1))
          throw new Error(
            `Active Agent ${name} relation must contain ${required ? "exactly" : "at most"} one page`,
          );
        return ids[0] ?? null;
      };
      /** Parent page relation resolved to its stable Run ID. */
      const parentPageId = one("Parent");
      /** Restart-source page relation resolved to its stable Run ID. */
      const restartPageId = one("Restart Of");
      /** Related Agent definition required for every run. */
      const agentId = one("Agent", true)!;
      /** Current Task relation, absent only after terminal archival. */
      const taskRelationId = one("Task");
      /** Historical Task identity retained after detachment. */
      const taskTextId = textValue(props["Task ID"]);
      /** Assigned Task identity selected from current or historical storage. */
      const taskId = taskRelationId ?? taskTextId;
      if (taskId === "") throw new Error("Active Agent Task ID is required");
      if (
        taskRelationId !== null &&
        taskTextId !== "" &&
        normalizeId(taskRelationId) !== normalizeId(taskTextId)
      )
        throw new Error("Active Agent Task relation conflicts with Task ID");
      /** One-based retry attempt. */
      const attempt = numberValue(props.Attempt);
      if (attempt === null || !Number.isSafeInteger(attempt) || attempt < 1)
        throw new Error("Active Agent Attempt must be a positive integer");
      /** Strict lifecycle status decoded from the managed select. */
      const status = activeAgentStatus(selectValue(props.Status));
      /** Optional command working directory retained from the pinned definition. */
      const workingDirectory = nullableTextValue(props["Working Directory"]);
      if (workingDirectory !== null && !isAbsolute(workingDirectory))
        throw new Error("Active Agent Working Directory must be absolute");
      return {
        agentId,
        agentVersion: requiredTextValue(
          props["Agent Version"],
          "Active Agent Agent Version",
        ),
        archived: archived(page) || checkboxValue(props.Archived),
        attempt,
        completionTaskStatus: textValue(props["Completion Task Status"]),
        failureSummary: textValue(props["Failure Summary"]),
        finishedAt: optionalIsoDateValue(
          props["Finished At"],
          "Active Agent Finished At",
        ),
        harnessId: requiredTextValue(
          props["Harness ID"],
          "Active Agent Harness ID",
        ),
        id: notionPageId(page),
        lastHeartbeat: requiredIsoDateValue(
          props["Last Heartbeat"],
          "Active Agent Last Heartbeat",
        ),
        outcome: textValue(props.Outcome),
        parentRunId: relatedRunId(parentPageId, runByPage, "Parent"),
        restartOfRunId: relatedRunId(restartPageId, runByPage, "Restart Of"),
        retryKey: requiredTextValue(
          props["Retry Key"],
          "Active Agent Retry Key",
        ),
        runId: requiredTextValue(props["Run ID"], "Active Agent Run ID"),
        startedAt: requiredIsoDateValue(
          props["Started At"],
          "Active Agent Started At",
        ),
        status,
        taskId,
        version: notionPageVersion(page),
        workingDirectory,
      };
    });
  }

  /** Decodes an Error record from its Notion page and Markdown. */
  private async decodeError(page: JsonObject): Promise<ErrorRecord> {
    /** Decoded Notion properties for the current page. */
    const props = pageProperties(page);
    /** Markdown body read or rendered for the current record. */
    const body = await this.markdown(notionPageId(page));
    return {
      activeAgentId: relationIds(props["Active Agent"])[0] ?? null,
      agentId: relationIds(props.Agent)[0] ?? null,
      archived: archived(page),
      description: markdownSection(body, "Error Description"),
      errorKey: textValue(props["Error Key"]),
      id: notionPageId(page),
      resolution: markdownSection(body, "Error Resolution"),
      severity: selectValue(props.Severity).toLowerCase() as ErrorSeverity,
      source: selectValue(props.Source).toLowerCase() as ErrorSource,
      status: selectValue(props.Status).toLowerCase() as ErrorRecord["status"],
      taskId: relationIds(props.Task)[0] ?? null,
      title: textValue(props.Error),
      version: notionPageVersion(page),
    };
  }

  /** Reads a Notion page, returning null only when the provider reports absence. */
  private async pageOrNull(pageId: string): Promise<JsonObject | null> {
    try {
      return await this.transport.request({
        method: "GET",
        path: `/v1/pages/${normalizeId(pageId)}`,
      });
    } catch (error) {
      if (error instanceof NotionApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** Rejects direct page IDs outside the configured managed data source. */
  private assertManagedPage(page: JsonObject, kind: TableKind): void {
    /** Page-parent metadata compared with the configured data-source ID. */
    const parent = requireJsonObject(page.parent, "Page parent");
    if (
      parent.type !== "data_source_id" ||
      typeof parent.data_source_id !== "string" ||
      normalizeId(parent.data_source_id) !== this.table(kind)
    )
      throw new Error(`Notion page is outside the configured ${kind} table`);
  }

  /** Queries every page in one configured managed table. */
  private async query(
    kind: TableKind,
    filter?: JsonObject,
  ): Promise<readonly JsonObject[]> {
    /** Configured data-source ID for this query. */
    const source = this.table(kind);
    return collectNotionPages((cursor) =>
      this.transport.request({
        body: {
          ...(filter === undefined ? {} : { filter }),
          page_size: 100,
          ...(cursor === null ? {} : { start_cursor: cursor }),
        },
        method: "POST",
        path: `/v1/data_sources/${source}/query`,
      }),
    );
  }

  /** Returns the configured data-source ID for a managed table. */
  private table(kind: TableKind): string {
    /** Configured data-source ID before normalization. */
    const value = this.#tables[kind];
    if (value === null)
      throw new Error(`Notion table is not configured: ${kind}`);
    return normalizeId(value);
  }

  /** Reads the complete Markdown representation of a Notion page. */
  private async markdown(pageId: string): Promise<string> {
    /** Notion response whose identifiers complete the operation. */
    const response = await this.transport.request({
      method: "GET",
      path: `/v1/pages/${pageId}/markdown`,
    });
    return decodeCompletePageMarkdown(response, {
      incomplete: "Notion returned incomplete page Markdown",
      invalidMarkdown: "Page Markdown must be a string",
      invalidMetadata: "Notion returned invalid Markdown completeness metadata",
    });
  }

  /** Replaces a page's complete Markdown representation. */
  private async replaceMarkdown(
    pageId: string,
    markdown: string,
  ): Promise<void> {
    await this.transport.request({
      body: { replace_content: { new_str: markdown }, type: "replace_content" },
      method: "PATCH",
      path: `/v1/pages/${pageId}/markdown`,
    });
  }

  /** Creates an absent managed table under the configured bootstrap page. */
  private async createTable(kind: TableKind): Promise<void> {
    if (this.#tables[kind] !== null) return;
    if (this.environment.bootstrapParent === null)
      throw new Error("Notion bootstrap parent is required");
    /** Canonical managed-table descriptor for this operation. */
    const table = notionTable(kind);
    /** Provider properties encoded or decoded for the current record. */
    const properties = Object.fromEntries(
      table.properties
        .filter((entry) => entry.relation === null)
        .map((entry) => [entry.name, propertySchema(entry, this.#tables)]),
    );
    /** Notion response whose identifiers complete the operation. */
    const response = await this.transport.request({
      body: {
        initial_data_source: { properties },
        parent: {
          page_id: normalizeId(this.environment.bootstrapParent),
          type: "page_id",
        },
        title: richTextPayload(table.title),
      },
      method: "POST",
      path: "/v1/databases",
    });
    if (
      !Array.isArray(response.data_sources) ||
      response.data_sources.length !== 1
    )
      throw new Error(`Created ${table.title} did not return one data source`);
    this.#tables[kind] = requiredString(
      asObject(response.data_sources[0] as JsonValue, "Created data source").id,
      "Created data source id",
    );
  }

  /** Adds one canonical property to a configured Notion data source. */
  private async addProperty(
    kind: TableKind,
    descriptor: NotionPropertyDescriptor,
  ): Promise<void> {
    /** Current data-source schema returned by Notion. */
    const source = await this.transport.request({
      method: "GET",
      path: `/v1/data_sources/${this.table(kind)}`,
    });
    if (
      requireJsonObject(source.properties, "Data source properties")[
        descriptor.name
      ] !== undefined
    )
      return;
    await this.transport.request({
      body: {
        properties: {
          [descriptor.name]: propertySchema(descriptor, this.#tables),
        },
      },
      method: "PATCH",
      path: `/v1/data_sources/${this.table(kind)}`,
    });
  }
}

/** Builds the Notion schema payload for one canonical property. */
function propertySchema(
  descriptor: NotionPropertyDescriptor,
  tables: Readonly<Record<TableKind, string | null>>,
): JsonObject {
  if (descriptor.relation !== null) {
    /** Destination Task status or related Notion table selected by the operation. */
    const target = tables[descriptor.relation];
    if (target === null)
      throw new Error(`Relation target is unavailable: ${descriptor.relation}`);
    return {
      relation: {
        data_source_id: normalizeId(target),
        ...(descriptor.syncedName === undefined
          ? { single_property: {} }
          : { dual_property: { synced_property_name: descriptor.syncedName } }),
      },
    };
  }
  if (descriptor.type === "title") return { title: {} };
  if (descriptor.type === "rich_text") return { rich_text: {} };
  if (descriptor.type === "checkbox") return { checkbox: {} };
  if (descriptor.type === "number") return { number: { format: "number" } };
  if (descriptor.type === "date") return { date: {} };
  if (descriptor.type === "url") return { url: {} };
  if (descriptor.type === "people") return { people: {} };
  if (descriptor.type === "created_time") return { created_time: {} };
  if (descriptor.type === "last_edited_time") return { last_edited_time: {} };
  if (descriptor.type === "select")
    return {
      select: {
        options: descriptor.options.map((name) => ({ name })),
      },
    };
  throw new Error(`Unsupported Notion property type: ${descriptor.type}`);
}

/** Returns a concise mismatch description for one observed property contract. */
function propertyContractMismatch(
  descriptor: NotionPropertyDescriptor,
  observed: JsonObject,
  tables: Readonly<Record<TableKind, string | null>>,
): string | null {
  /** Observed property discriminator compared before type-specific details. */
  const actualType =
    typeof observed.type === "string" ? observed.type : "missing type";
  if (actualType !== descriptor.type) return actualType;
  if (descriptor.relation !== null) {
    /** Untrusted relation configuration returned by Notion. */
    const relationConfiguration = observed.relation;
    if (
      relationConfiguration === null ||
      typeof relationConfiguration !== "object" ||
      Array.isArray(relationConfiguration)
    )
      return "relation configuration is missing";
    /** Configured data-source ID required by the canonical relation. */
    const expectedTargetId = tables[descriptor.relation];
    if (expectedTargetId === null) return "relation target is unavailable";
    if (
      typeof relationConfiguration.data_source_id !== "string" ||
      normalizeId(relationConfiguration.data_source_id) !==
        normalizeId(expectedTargetId)
    )
      return "relation target differs";
    if (descriptor.syncedName === undefined) {
      if (!("single_property" in relationConfiguration))
        return "relation mode differs";
    } else {
      /** Dual-relation configuration whose synchronized name must be exact. */
      const dualProperty = relationConfiguration.dual_property;
      if (
        dualProperty === null ||
        typeof dualProperty !== "object" ||
        Array.isArray(dualProperty) ||
        dualProperty.synced_property_name !== descriptor.syncedName
      )
        return "relation synchronization differs";
    }
  }
  if (descriptor.type === "select" && descriptor.options.length > 0) {
    /** Untrusted select configuration returned by Notion. */
    const selectConfiguration = observed.select;
    if (
      selectConfiguration === null ||
      typeof selectConfiguration !== "object" ||
      Array.isArray(selectConfiguration)
    )
      return "select configuration is missing";
    /** Raw option entries whose names define the observed select vocabulary. */
    const optionEntries = selectConfiguration.options;
    if (!Array.isArray(optionEntries)) return "select options differ";
    /** Observed option names extracted without accepting malformed entries. */
    const observedOptionNames = optionEntries.flatMap((option) => {
      if (
        option !== null &&
        typeof option === "object" &&
        !Array.isArray(option) &&
        typeof option.name === "string"
      )
        return [option.name];
      return [];
    });
    /** Canonical option names sorted for order-independent comparison. */
    const canonicalOptionNames = [...descriptor.options].sort();
    if (
      observedOptionNames.length !== optionEntries.length ||
      JSON.stringify(observedOptionNames.sort()) !==
        JSON.stringify(canonicalOptionNames)
    )
      return "select options differ";
  }
  return null;
}

/** Requires the properties object from a Notion page. */
function pageProperties(page: JsonObject): JsonObject {
  return requireJsonObject(page.properties, "Page properties");
}

/** Converts Notion property objects to provider-neutral JSON values. */
function plainProperties(value: JsonObject): JsonObject {
  return toJsonValue(value) as JsonObject;
}

/** Reads the required identifier from a Notion page. */
function notionPageId(page: JsonObject): string {
  return requiredString(page.id, "Page id");
}

/** Derives a stable optimistic-concurrency version. */
function notionPageVersion(page: JsonObject): string {
  return requiredString(page.last_edited_time, "Page version");
}

/** Binds a Notion Agent revision to both metadata and its authoritative body. */
function agentVersion(page: JsonObject, body: string): string {
  /** Provider metadata version included in the Agent version digest. */
  const metadataVersion = notionPageVersion(page);
  return sha256(`${metadataVersion.length}:${metadataVersion}${body}`);
}

/** Reports whether Notion has archived or trashed a page. */
function archived(page: JsonObject): boolean {
  return page.archived === true || page.in_trash === true;
}

/** Decodes plain text from a Notion rich-text property. */
function textValue(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  /** Strictly decoded rich-text property object. */
  const property = requireJsonObject(value, "Text property");
  /** Title or rich-text entries to concatenate. */
  const values =
    property.type === "title" ? property.title : property.rich_text;
  if (!Array.isArray(values)) return "";
  return values
    .map((entry) => {
      /** Rich-text fragment currently being decoded. */
      const item = requireJsonObject(entry, "Rich text");
      return typeof item.plain_text === "string" ? item.plain_text : "";
    })
    .join("");
}

/** Requires a non-empty decoded Notion text property. */
function requiredTextValue(
  value: JsonValue | undefined,
  label: string,
): string {
  /** Decoded text checked before it enters provider-neutral records. */
  const text = textValue(value);
  if (text.trim() === "") throw new Error(`${label} is required`);
  return text;
}

/** Decodes a nullable Notion rich-text value. */
function nullableTextValue(value: JsonValue | undefined): string | null {
  /** Normalized text field reader for the strict input boundary. */
  const text = textValue(value);
  return text === "" ? null : text;
}

/** Decodes a Notion select value. */
function selectValue(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  /** Select object after property-shape validation. */
  const selected = requireJsonObject(value, "Select property").select;
  return selected === null || selected === undefined
    ? ""
    : requiredString(
        requireJsonObject(selected, "Select value").name,
        "Select name",
      );
}

/** Decodes normalized page IDs from a Notion relation property. */
function relationIds(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  /** Relation property checked for Notion's inline-reference truncation marker. */
  const property = requireJsonObject(value, "Relation property");
  if (property.has_more === true)
    throw new Error("Notion relation exceeds the inline reference limit");
  /** Relation entries containing referenced page IDs. */
  const values = property.relation;
  return Array.isArray(values)
    ? values.map((entry) =>
        requiredString(
          requireJsonObject(entry, "Relation item").id,
          "Relation id",
        ),
      )
    : [];
}

/** Decodes a nullable Notion number property. */
function numberValue(value: JsonValue | undefined): number | null {
  /** Numeric Notion property value after shape validation. */
  const number =
    value === undefined
      ? null
      : requireJsonObject(value, "Number property").number;
  return typeof number === "number" ? number : null;
}

/** Decodes a Notion checkbox property. */
function checkboxValue(value: JsonValue | undefined): boolean {
  return (
    value !== undefined &&
    requireJsonObject(value, "Checkbox property").checkbox === true
  );
}

/** Decodes a nullable Notion date start value. */
function dateValue(value: JsonValue | undefined): string | null {
  if (value === undefined) return null;
  /** Date object after property-shape validation. */
  const selected = requireJsonObject(value, "Date property").date;
  return selected === null || selected === undefined
    ? null
    : requiredString(
        requireJsonObject(selected, "Date value").start,
        "Date start",
      );
}

/** Requires a parseable ISO timestamp from a Notion date property. */
function requiredIsoDateValue(
  value: JsonValue | undefined,
  label: string,
): string {
  /** Timestamp decoded from the managed date property. */
  const timestamp = dateValue(value);
  if (timestamp === null || !Number.isFinite(Date.parse(timestamp)))
    throw new Error(`${label} must be a valid timestamp`);
  return timestamp;
}

/** Decodes an optional parseable ISO timestamp from a Notion date property. */
function optionalIsoDateValue(
  value: JsonValue | undefined,
  label: string,
): string | null {
  /** Optional timestamp decoded from the managed date property. */
  const timestamp = dateValue(value);
  if (timestamp !== null && !Number.isFinite(Date.parse(timestamp)))
    throw new Error(`${label} must be a valid timestamp`);
  return timestamp;
}

/** Validates an Active Agent lifecycle status from its Notion select label. */
function activeAgentStatus(value: string): ActiveAgentRecord["status"] {
  /** Normalized select label compared with the closed domain union. */
  const status = value.toLowerCase();
  if (
    status !== "running" &&
    status !== "failed" &&
    status !== "stale" &&
    status !== "completed" &&
    status !== "stopped"
  )
    throw new Error(`Invalid Active Agent status: ${value}`);
  return status;
}

/** Resolves an optional Active Agent relation to an inventoried Run ID. */
function relatedRunId(
  pageId: string | null,
  runByPage: ReadonlyMap<string, string>,
  label: string,
): string | null {
  if (pageId === null) return null;
  /** Related Run ID required for a non-empty hierarchy relation. */
  const runId = runByPage.get(normalizeId(pageId));
  if (runId === undefined)
    throw new Error(`Active Agent ${label} relation is unavailable`);
  return runId;
}

/** Requires and returns a plain object at an untyped boundary. */
function requireJsonObject(
  value: JsonValue | undefined,
  label: string,
): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new TypeError(`${label} must be an object`);
  return value;
}

/** Requires a non-empty string at a decoded Notion boundary. */
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Returns a decoded value or throws the supplied error when it is absent. */
function requirePresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

/** Builds one structured workspace-validation issue. */
function validationIssue(
  code: string,
  path: string,
  message: string,
): ValidationIssue {
  return { code, message, path };
}

/** Builds one Notion rich-text fragment. */
function richTextPayload(value: string): JsonObject[] {
  /** Unicode-safe text fragments within Notion's per-fragment limit. */
  const fragments: string[] = [];
  /** Current Unicode-safe fragment accumulated below the provider limit. */
  let fragment = "";
  for (const character of value) {
    if (fragment.length + character.length > 2_000) {
      fragments.push(fragment);
      fragment = "";
    }
    fragment += character;
  }
  if (fragment !== "" || value === "") fragments.push(fragment);
  if (fragments.length > 100)
    throw new Error("Notion rich text exceeds 100 fragments");
  return fragments.map((content) => ({ text: { content }, type: "text" }));
}

/** Builds a Notion title-property payload. */
function title(value: string): JsonObject {
  return { title: richTextPayload(value) };
}

/** Builds a Notion rich-text property payload. */
function richText(value: string): JsonObject {
  return { rich_text: richTextPayload(value) };
}

/** Builds a Notion select-property payload. */
function select(value: string): JsonObject {
  return { select: { name: value } };
}

/** Builds a Notion checkbox-property payload. */
function checkbox(value: boolean): JsonObject {
  return { checkbox: value };
}

/** Builds a Notion relation-property payload. */
function relation(ids: readonly string[]): JsonObject {
  return { relation: ids.map((value) => ({ id: normalizeId(value) })) };
}

/** Preserves immutable Task identity while removing reciprocal live ownership. */
function detachedTaskProperties(taskId: string): JsonObject {
  if (taskId === "")
    throw new Error("Active Agent Task identity is unavailable");
  return { Task: relation([]), "Task ID": richText(taskId) };
}

/** Encodes an optional ISO timestamp as a Notion date property. */
function date(value: string | null): JsonObject {
  return { date: value === null ? null : { start: value } };
}

/** Converts a normalized domain value to its Notion select label. */
function toSelectLabel(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

/** Converts the closed Error source union to its canonical Notion option. */
function errorSourceLabel(source: ErrorSource): string {
  return { ai: "AI", human: "Human", system: "System" }[source];
}

/** Renders the managed description and resolution sections of an Error page. */
function errorMarkdown(description: string, resolution: string): string {
  return `## Error Description\n\n${quoteMarkdown(description)}\n\n## Error Resolution\n\n${quoteMarkdown(resolution)}\n`;
}

/** Quotes arbitrary Error text so its headings cannot escape the managed section. */
function quoteMarkdown(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Extracts a named level-two section from Markdown. */
function markdownSection(markdown: string, heading: string): string {
  /** Pattern bounded by the next level-two heading. */
  const pattern = new RegExp(
    `(?:^|\\n)## ${heading}\\n+([\\s\\S]*?)(?=\\n## |$)`,
    "u",
  );
  /** Raw managed section, or the empty value for absent legacy content. */
  const section = pattern.exec(markdown)?.[1]?.trim() ?? "";
  /** Lines used to detect the unambiguous blockquoted representation. */
  const lines = section.split("\n");
  if (lines.every((line) => line === ">" || line.startsWith("> ")))
    return lines
      .map((line) => (line === ">" ? "" : line.slice(2)))
      .join("\n")
      .trim();
  return section;
}
