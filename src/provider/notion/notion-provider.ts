/** Notion implementation of the simplified provider contract. */
import { digestJson, sha256 } from "../../core/digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../domain/json.js";
import type {
  ProviderEnvironment,
  TableKind,
  ValidationIssue,
  ValidationReport,
  WorkspacePlan,
  WorkspaceStep,
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
  type NotionTransport,
} from "./notion-transport.js";

interface WorkspacePropertyMismatch {
  readonly actual: string;
  readonly property: NotionPropertyDescriptor;
}
interface WorkspaceSchemaInspection {
  readonly configured: boolean;
  readonly mismatched: readonly WorkspacePropertyMismatch[];
  readonly missing: readonly NotionPropertyDescriptor[];
  readonly table: NotionTableDescriptor;
}

/** AgentTaskProvider backed by the configured Notion data sources. */
export class NotionProvider implements AgentTaskProvider {
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
    const issues: ValidationIssue[] = [];
    if (this.environment.type !== "notion")
      issues.push(
        issue("provider_type", "provider.type", "Provider type must be notion"),
      );
    if (this.environment.bootstrapParent === null)
      issues.push(
        issue(
          "bootstrap_parent",
          "provider.bootstrapParent",
          "Bootstrap parent is required",
        ),
      );
    return { issues, valid: issues.length === 0 };
  }

  /** @inheritdoc */
  public async validateWorkspace(): Promise<ValidationReport> {
    const issues: ValidationIssue[] = [];
    for (const inspection of await this.inspectWorkspaceSchema()) {
      const { table } = inspection;
      if (!inspection.configured) {
        issues.push(
          issue(
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
            issue(
              "missing_property",
              `${table.title}.${property.name}`,
              "Required property is missing",
            ),
          );
      for (const { actual, property } of inspection.mismatched)
        issues.push(
          issue(
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
    const steps: WorkspaceStep[] = [];
    for (const inspection of await this.inspectWorkspaceSchema()) {
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
    const core = {
      environmentId,
      schema: "workspace-plan-v1" as const,
      steps,
      targetSchemaDigest: NOTION_SCHEMA_DIGEST,
    };
    return { ...core, digest: digestJson(toJsonValue(core)) };
  }

  private async inspectWorkspaceSchema(): Promise<
    readonly WorkspaceSchemaInspection[]
  > {
    const inspections: WorkspaceSchemaInspection[] = [];
    for (const table of NOTION_TABLES) {
      const id = this.#tables[table.kind];
      if (id === null) {
        inspections.push({
          configured: false,
          mismatched: [],
          missing: table.properties,
          table,
        });
        continue;
      }
      const source = await this.transport.request({
        method: "GET",
        path: `/v1/data_sources/${normalizeId(id)}`,
      });
      const properties = object(source.properties, `${table.title} properties`);
      const missing: NotionPropertyDescriptor[] = [];
      const mismatched: WorkspacePropertyMismatch[] = [];
      for (const property of table.properties) {
        const observed = properties[property.name];
        if (observed === undefined) {
          missing.push(property);
          continue;
        }
        const actual = requiredString(
          object(observed, property.name).type,
          `${property.name} type`,
        );
        if (actual !== property.type) mismatched.push({ actual, property });
      }
      inspections.push({
        configured: true,
        mismatched,
        missing,
        table,
      });
    }
    return inspections;
  }

  /** @inheritdoc */
  public async applyWorkspacePlan(
    plan: WorkspacePlan,
  ): Promise<Readonly<Record<string, string>>> {
    const core = {
      environmentId: plan.environmentId,
      schema: plan.schema,
      steps: plan.steps,
      targetSchemaDigest: plan.targetSchemaDigest,
    };
    if (plan.digest !== digestJson(toJsonValue(core)))
      throw new Error("Workspace plan digest is invalid");
    for (const step of plan.steps.filter(
      (entry) => entry.kind === "create_table",
    ))
      await this.createTable(step.table);
    for (const step of plan.steps.filter(
      (entry) => entry.kind === "add_property",
    )) {
      const name = requiredString(step.payload.name, "Workspace property name");
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

  /** @inheritdoc */
  public async listTasks(status?: string): Promise<readonly TaskRecord[]> {
    const pages = await this.query(
      "tasks",
      status === undefined
        ? undefined
        : { property: "Status", select: { equals: status } },
    );
    return Promise.all(pages.map((page) => this.task(page)));
  }
  /** @inheritdoc */
  public async getTask(id: string): Promise<TaskRecord | null> {
    const page = await this.pageOrNull(id);
    return page === null ? null : this.task(page);
  }
  /** @inheritdoc */
  public async setTaskStatus(id: string, status: string): Promise<TaskRecord> {
    await this.transport.request({
      body: { properties: { Status: select(status) } },
      method: "PATCH",
      path: `/v1/pages/${normalizeId(id)}`,
    });
    return required(
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
    await this.transport.request({
      body: {
        type: "update_content",
        update_content: { new_str: body, old_str: expectedBody },
      },
      method: "PATCH",
      path: `/v1/pages/${normalizeId(id)}/markdown`,
    });
    return required(
      await this.getTask(id),
      `Task not found after description update: ${id}`,
    );
  }

  /** @inheritdoc */
  public async listAgents(): Promise<readonly AgentRecord[]> {
    const [pages, resourceIdByKey] = await Promise.all([
      this.query("agents"),
      this.resourceIdByKey(),
    ]);
    return Promise.all(pages.map((page) => this.agent(page, resourceIdByKey)));
  }
  /** @inheritdoc */
  public async getAgent(agentId: string): Promise<AgentRecord | null> {
    const normalized = normalizeId(agentId);
    const page = (await this.query("agents")).find(
      (candidate) => normalizeId(id(candidate)) === normalized,
    );
    return page === undefined
      ? null
      : this.agent(page, await this.resourceIdByKey());
  }
  /** @inheritdoc */
  public async getAgentByKey(key: string): Promise<AgentRecord | null> {
    const matches: Array<{
      body: string;
      definition: AgentDefinition;
      page: JsonObject;
    }> = [];
    for (const page of await this.query("agents")) {
      try {
        const stable = await this.stableAgentDefinition(page);
        if (stable.definition.id === key) matches.push(stable);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    if (matches.length > 1)
      throw new Error(`Agent definition id is not unique: ${key}`);
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
      (await this.query("resources")).map((page) => this.resource(page)),
    );
  }
  /** @inheritdoc */
  public async getResourceByKey(key: string): Promise<ResourceRecord | null> {
    const pages = await this.query("resources", {
      property: "Resource",
      title: { equals: key },
    });
    if (pages.length > 1) throw new Error(`Resource Key is not unique: ${key}`);
    const page = pages[0];
    return page === undefined ? null : this.resource(page);
  }

  /** @inheritdoc */
  public async listActiveAgents(): Promise<readonly ActiveAgentRecord[]> {
    return this.activeRecords(await this.query("activeAgents"));
  }
  /** @inheritdoc */
  public async getActiveAgent(
    runId: string,
  ): Promise<ActiveAgentRecord | null> {
    const pages = await this.query("activeAgents", {
      property: "Run ID",
      title: { equals: runId },
    });
    if (pages.length > 1) throw new Error(`Run ID is not unique: ${runId}`);
    const records = await this.activeRecords(pages);
    return records[0] ?? null;
  }
  /** @inheritdoc */
  public async createActiveAgent(
    input: CreateActiveAgentRecord,
  ): Promise<ActiveAgentRecord> {
    if ((await this.getActiveAgent(input.runId)) !== null)
      throw new Error(`Run ID already exists: ${input.runId}`);
    const parent =
      input.parentRunId === null
        ? null
        : await this.getActiveAgent(input.parentRunId);
    const restart =
      input.restartOfRunId === null
        ? null
        : await this.getActiveAgent(input.restartOfRunId);
    const page = await this.transport.request({
      body: {
        parent: { data_source_id: this.table("activeAgents") },
        properties: {
          "Run ID": title(input.runId),
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
          "Failure Summary": richText(""),
          "Working Directory": richText(input.workingDirectory ?? ""),
        },
      },
      method: "POST",
      path: "/v1/pages",
    });
    return required(
      await this.getActiveAgent(input.runId),
      `Created Active Agent is unavailable: ${requiredString(page.id, "Created page id")}`,
    );
  }
  /** @inheritdoc */
  public async updateActiveAgent(
    runId: string,
    patch: ActiveAgentPatch,
  ): Promise<ActiveAgentRecord> {
    const current = required(
      await this.getActiveAgent(runId),
      `Active Agent not found: ${runId}`,
    );
    const properties: Record<string, JsonValue> = {};
    if (patch.status !== undefined)
      properties.Status = select(label(patch.status));
    if (patch.lastHeartbeat !== undefined)
      properties["Last Heartbeat"] = date(patch.lastHeartbeat);
    if (patch.finishedAt !== undefined)
      properties["Finished At"] = date(patch.finishedAt);
    if (patch.outcome !== undefined)
      properties.Outcome = richText(patch.outcome);
    if (patch.failureSummary !== undefined)
      properties["Failure Summary"] = richText(patch.failureSummary);
    if (patch.status !== undefined && patch.status !== "running")
      Object.assign(properties, detachedTaskProperties(current.taskId));
    await this.transport.request({
      body: { properties },
      method: "PATCH",
      path: `/v1/pages/${current.id}`,
    });
    return required(
      await this.getActiveAgent(runId),
      `Updated Active Agent is unavailable: ${runId}`,
    );
  }
  /** @inheritdoc */
  public async archiveActiveAgent(runId: string): Promise<void> {
    const current = required(
      await this.getActiveAgent(runId),
      `Active Agent not found: ${runId}`,
    );
    await this.transport.request({
      body: {
        in_trash: true,
        properties: detachedTaskProperties(current.taskId),
      },
      method: "PATCH",
      path: `/v1/pages/${current.id}`,
    });
  }

  /** @inheritdoc */
  public async listErrors(): Promise<readonly ErrorRecord[]> {
    return Promise.all(
      (await this.query("errors")).map((page) => this.error(page)),
    );
  }
  /** @inheritdoc */
  public async getErrorByKey(key: string): Promise<ErrorRecord | null> {
    const pages = await this.query("errors", {
      property: "Error Key",
      rich_text: { equals: key },
    });
    if (pages.length > 1) throw new Error(`Error Key is not unique: ${key}`);
    const page = pages[0];
    return page === undefined ? null : this.error(page);
  }
  /** @inheritdoc */
  public async reportError(input: ReportErrorInput): Promise<ErrorRecord> {
    const existing = await this.getErrorByKey(input.errorKey);
    const properties = {
      Error: title(input.title),
      "Error Key": richText(input.errorKey),
      Source: select(label(input.source)),
      Severity: select(label(input.severity)),
      Status: select("Open"),
      Task: relation(input.taskId === null ? [] : [input.taskId]),
      Agent: relation(input.agentId === null ? [] : [input.agentId]),
      "Active Agent": relation(
        input.activeAgentId === null ? [] : [input.activeAgentId],
      ),
      "Fixed At": date(null),
    };
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
    return required(
      await this.getErrorByKey(input.errorKey),
      `Reported Error is unavailable: ${input.errorKey}`,
    );
  }
  /** @inheritdoc */
  public async resolveError(
    key: string,
    resolution: string,
  ): Promise<ErrorRecord> {
    const current = required(
      await this.getErrorByKey(key),
      `Error not found: ${key}`,
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
    await this.replaceMarkdown(
      current.id,
      errorMarkdown(current.description, resolution),
    );
    return required(
      await this.getErrorByKey(key),
      `Resolved Error is unavailable: ${key}`,
    );
  }

  private async task(page: JsonObject): Promise<TaskRecord> {
    const props = properties(page);
    return {
      archived: archived(page),
      body: await this.markdown(id(page)),
      dependencies: relationIds(props.Dependencies),
      id: id(page),
      priority: numberValue(props.Priority),
      properties: plainProperties(props),
      status: selectValue(props.Status),
      title: textValue(props.Task),
      type: selectValue(props.Type),
      version: version(page),
    };
  }
  private async agent(
    page: JsonObject,
    resourceIdByKey: ReadonlyMap<string, string>,
  ): Promise<AgentRecord> {
    const stable = await this.stableAgentDefinition(page);
    return this.agentRecord(
      stable.page,
      stable.body,
      stable.definition,
      resourceIdByKey,
    );
  }
  private async stableAgentDefinition(page: JsonObject): Promise<{
    readonly body: string;
    readonly definition: AgentDefinition;
    readonly page: JsonObject;
  }> {
    let metadata = page;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const body = await this.markdown(id(metadata));
      const current = await this.pageOrNull(id(metadata));
      if (current === null)
        throw new Error(`Agent page disappeared while loading: ${id(page)}`);
      if (version(current) === version(metadata)) {
        const definition = parseAgentDefinition(body);
        return { body, definition, page: current };
      }
      metadata = current;
    }
    throw new Error(`Agent page changed repeatedly while loading: ${id(page)}`);
  }
  private agentRecord(
    page: JsonObject,
    body: string,
    definition: AgentDefinition,
    resourceIdByKey: ReadonlyMap<string, string>,
  ): AgentRecord {
    const props = properties(page);
    const resourceIds = definition.resourceKeys.map((key) => {
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
      id: id(page),
      key: definition.id,
      lifecycleCommands: definition.lifecycleCommands,
      model: definition.model,
      name: textValue(props.Name),
      notes: definition.notes,
      properties: plainProperties(props),
      reasoning: definition.reasoning,
      resourceIds,
      restartCompatibleVersions: [version(page)],
      taskDescription: definition.taskDescription,
      transitions: definition.transitions,
      version: agentVersion(page, body),
    };
  }
  private async resourceIdByKey(): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    for (const page of await this.query("resources")) {
      const key = textValue(properties(page).Resource);
      if (result.has(key))
        throw new Error(`Resource Key is not unique: ${key}`);
      result.set(key, id(page));
    }
    return result;
  }
  private async validateAgentSemantics(
    issues: ValidationIssue[],
  ): Promise<void> {
    if (this.#tables.agents === null || this.#tables.resources === null) return;
    let agentPages: readonly JsonObject[];
    let resourcePages: readonly JsonObject[];
    try {
      [agentPages, resourcePages] = await Promise.all([
        this.query("agents"),
        this.query("resources"),
      ]);
    } catch (error) {
      issues.push(
        issue(
          "semantic_inventory",
          "Agents",
          `Could not inventory Agent configuration: ${String(error)}`,
        ),
      );
      return;
    }
    const resources = resourcePages.map((page) => {
      const props = properties(page);
      return {
        archived: archived(page),
        id: id(page),
        key: textValue(props.Resource),
        kind: selectValue(props.Kind),
        state: selectValue(props.State),
      };
    });
    const resourcesByKey = new Map<string, typeof resources>();
    for (const resource of resources) {
      const path = `Resources.${resource.id}`;
      if (resource.key === "")
        issues.push(issue("resource_key", path, "Resource key is empty"));
      if (!["Prompt", "Policy"].includes(resource.kind))
        issues.push(
          issue("resource_kind", path, `Unsupported Kind: ${resource.kind}`),
        );
      if (!["Active", "Draft", "Retired"].includes(resource.state))
        issues.push(
          issue("resource_state", path, `Unsupported State: ${resource.state}`),
        );
      const matches = resourcesByKey.get(resource.key) ?? [];
      matches.push(resource);
      resourcesByKey.set(resource.key, matches);
    }
    for (const [key, matches] of resourcesByKey)
      if (key !== "" && matches.length > 1)
        issues.push(
          issue(
            "duplicate_resource_key",
            `Resources.${key}`,
            `Resource key appears ${matches.length} times`,
          ),
        );

    const definitions: Array<{
      definition: AgentDefinition;
      pageId: string;
    }> = [];
    for (const page of agentPages) {
      const pageId = id(page);
      try {
        definitions.push({
          definition: parseAgentDefinition(await this.markdown(pageId)),
          pageId,
        });
      } catch (error) {
        issues.push(
          issue(
            "agent_definition",
            `Agents.${pageId}`,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
    const definitionsById = new Map<string, typeof definitions>();
    for (const entry of definitions) {
      const matches = definitionsById.get(entry.definition.id) ?? [];
      matches.push(entry);
      definitionsById.set(entry.definition.id, matches);
    }
    for (const [definitionId, matches] of definitionsById)
      if (matches.length > 1)
        issues.push(
          issue(
            "duplicate_agent_id",
            `Agents.${definitionId}`,
            `Agent definition id appears ${matches.length} times`,
          ),
        );
    for (const { definition, pageId } of definitions)
      for (const key of definition.resourceKeys) {
        const matches = resourcesByKey.get(key) ?? [];
        const path = `Agents.${pageId}.resources.${key}`;
        if (matches.length === 0) {
          issues.push(
            issue("missing_resource", path, "Referenced Resource is missing"),
          );
          continue;
        }
        if (matches.length > 1) continue;
        const resource = matches[0]!;
        if (resource.archived || resource.state !== "Active")
          issues.push(
            issue(
              "unavailable_resource",
              path,
              "Referenced Resource must be active",
            ),
          );
        const expectedKind = key.startsWith("prompt/") ? "Prompt" : "Policy";
        if (resource.kind !== expectedKind)
          issues.push(
            issue(
              "resource_kind_mismatch",
              path,
              `Expected ${expectedKind}, received ${resource.kind}`,
            ),
          );
      }
  }
  private async resource(page: JsonObject): Promise<ResourceRecord> {
    const props = properties(page);
    return {
      archived: archived(page),
      body: await this.markdown(id(page)),
      id: id(page),
      key: textValue(props.Resource),
      kind: selectValue(props.Kind),
      properties: plainProperties(props),
      state: selectValue(props.State).toLowerCase() as ResourceState,
      version: version(page),
    };
  }
  private async activeRecords(
    pages: readonly JsonObject[],
  ): Promise<readonly ActiveAgentRecord[]> {
    const raw = pages.map((page) => ({ page, props: properties(page) }));
    const runByPage = new Map(
      raw.map(({ page, props }) => [
        normalizeId(id(page)),
        textValue(props["Run ID"]),
      ]),
    );
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
          const page = await this.pageOrNull(pageId);
          if (page !== null)
            runByPage.set(
              normalizeId(pageId),
              textValue(properties(page)["Run ID"]),
            );
        }),
    );
    return raw.map(({ page, props }) => {
      const first = (name: string): string | null =>
        relationIds(props[name])[0] ?? null;
      return {
        agentId: first("Agent") ?? "",
        agentVersion: textValue(props["Agent Version"]),
        archived: archived(page),
        attempt: numberValue(props.Attempt) ?? 0,
        failureSummary: textValue(props["Failure Summary"]),
        finishedAt: dateValue(props["Finished At"]),
        harnessId: textValue(props["Harness ID"]),
        id: id(page),
        lastHeartbeat: dateValue(props["Last Heartbeat"]) ?? "",
        outcome: textValue(props.Outcome),
        parentRunId:
          runByPage.get(normalizeOptionalId(first("Parent"))) ?? null,
        restartOfRunId:
          runByPage.get(normalizeOptionalId(first("Restart Of"))) ?? null,
        retryKey: textValue(props["Retry Key"]),
        runId: textValue(props["Run ID"]),
        startedAt: dateValue(props["Started At"]) ?? "",
        status: selectValue(
          props.Status,
        ).toLowerCase() as ActiveAgentRecord["status"],
        taskId: first("Task") ?? textValue(props["Task ID"]),
        version: version(page),
        workingDirectory: nullableTextValue(props["Working Directory"]),
      };
    });
  }
  private async error(page: JsonObject): Promise<ErrorRecord> {
    const props = properties(page);
    const body = await this.markdown(id(page));
    return {
      activeAgentId: relationIds(props["Active Agent"])[0] ?? null,
      agentId: relationIds(props.Agent)[0] ?? null,
      archived: archived(page),
      description: section(body, "Error Description"),
      errorKey: textValue(props["Error Key"]),
      id: id(page),
      resolution: section(body, "Error Resolution"),
      severity: selectValue(props.Severity).toLowerCase() as ErrorSeverity,
      source: selectValue(props.Source).toLowerCase() as ErrorSource,
      status: selectValue(props.Status).toLowerCase() as ErrorRecord["status"],
      taskId: relationIds(props.Task)[0] ?? null,
      title: textValue(props.Error),
      version: version(page),
    };
  }

  private async pageOrNull(pageId: string): Promise<JsonObject | null> {
    try {
      return await this.transport.request({
        method: "GET",
        path: `/v1/pages/${normalizeId(pageId)}`,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.toLowerCase().includes("not found")
      )
        return null;
      throw error;
    }
  }
  private async query(
    kind: TableKind,
    filter?: JsonObject,
  ): Promise<readonly JsonObject[]> {
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
  private table(kind: TableKind): string {
    const value = this.#tables[kind];
    if (value === null)
      throw new Error(`Notion table is not configured: ${kind}`);
    return normalizeId(value);
  }
  private async markdown(pageId: string): Promise<string> {
    const response = await this.transport.request({
      method: "GET",
      path: `/v1/pages/${pageId}/markdown`,
    });
    return requiredString(response.markdown, "Page Markdown")
      .replace(/\r\n?/gu, "\n")
      .normalize("NFC");
  }
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
  private async createTable(kind: TableKind): Promise<void> {
    if (this.#tables[kind] !== null) return;
    if (this.environment.bootstrapParent === null)
      throw new Error("Notion bootstrap parent is required");
    const table = notionTable(kind);
    const properties = Object.fromEntries(
      table.properties
        .filter((entry) => entry.relation === null)
        .map((entry) => [entry.name, propertySchema(entry, this.#tables)]),
    );
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
  private async addProperty(
    kind: TableKind,
    descriptor: NotionPropertyDescriptor,
  ): Promise<void> {
    const source = await this.transport.request({
      method: "GET",
      path: `/v1/data_sources/${this.table(kind)}`,
    });
    if (
      object(source.properties, "Data source properties")[descriptor.name] !==
      undefined
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

function propertySchema(
  descriptor: NotionPropertyDescriptor,
  tables: Readonly<Record<TableKind, string | null>>,
): JsonObject {
  if (descriptor.relation !== null) {
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
function properties(page: JsonObject): JsonObject {
  return object(page.properties, "Page properties");
}
function plainProperties(value: JsonObject): JsonObject {
  return toJsonValue(value) as JsonObject;
}
function id(page: JsonObject): string {
  return requiredString(page.id, "Page id");
}
function version(page: JsonObject): string {
  return requiredString(page.last_edited_time, "Page version");
}

/** Binds a Notion Agent revision to both metadata and its authoritative body. */
function agentVersion(page: JsonObject, body: string): string {
  const metadataVersion = version(page);
  return sha256(`${metadataVersion.length}:${metadataVersion}${body}`);
}
function archived(page: JsonObject): boolean {
  return page.archived === true || page.in_trash === true;
}
function textValue(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  const property = object(value, "Text property");
  const values =
    property.type === "title" ? property.title : property.rich_text;
  if (!Array.isArray(values)) return "";
  return values
    .map((entry) => {
      const item = object(entry, "Rich text");
      return typeof item.plain_text === "string" ? item.plain_text : "";
    })
    .join("");
}
function nullableTextValue(value: JsonValue | undefined): string | null {
  const text = textValue(value);
  return text === "" ? null : text;
}
function selectValue(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  const selected = object(value, "Select property").select;
  return selected === null || selected === undefined
    ? ""
    : requiredString(object(selected, "Select value").name, "Select name");
}
function relationIds(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  const values = object(value, "Relation property").relation;
  return Array.isArray(values)
    ? values.map((entry) =>
        requiredString(object(entry, "Relation item").id, "Relation id"),
      )
    : [];
}
function numberValue(value: JsonValue | undefined): number | null {
  const number =
    value === undefined ? null : object(value, "Number property").number;
  return typeof number === "number" ? number : null;
}
function dateValue(value: JsonValue | undefined): string | null {
  if (value === undefined) return null;
  const selected = object(value, "Date property").date;
  return selected === null || selected === undefined
    ? null
    : requiredString(object(selected, "Date value").start, "Date start");
}
function object(value: JsonValue | undefined, label: string): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new TypeError(`${label} must be an object`);
  return value;
}
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, message, path };
}
function normalizeOptionalId(value: string | null): string {
  return value === null ? "" : normalizeId(value);
}
function richTextPayload(value: string): JsonObject[] {
  return [{ text: { content: value }, type: "text" }];
}
function title(value: string): JsonObject {
  return { title: richTextPayload(value) };
}
function richText(value: string): JsonObject {
  return { rich_text: richTextPayload(value) };
}
function select(value: string): JsonObject {
  return { select: { name: value } };
}
function relation(ids: readonly string[]): JsonObject {
  return { relation: ids.map((value) => ({ id: normalizeId(value) })) };
}

/** Preserves immutable Task identity while removing reciprocal live ownership. */
function detachedTaskProperties(taskId: string): JsonObject {
  if (taskId === "")
    throw new Error("Active Agent Task identity is unavailable");
  return { Task: relation([]), "Task ID": richText(taskId) };
}
function date(value: string | null): JsonObject {
  return { date: value === null ? null : { start: value } };
}
function label(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
function errorMarkdown(description: string, resolution: string): string {
  return `## Error Description\n\n${description}\n\n## Error Resolution\n\n${resolution}\n`;
}
function section(markdown: string, heading: string): string {
  const pattern = new RegExp(
    `(?:^|\\n)## ${heading}\\n+([\\s\\S]*?)(?=\\n## |$)`,
    "u",
  );
  return pattern.exec(markdown)?.[1]?.trim() ?? "";
}
