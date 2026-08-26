/** Shared Notion page access and record decoding for provider operations. */
import { isAbsolute } from "node:path";

import type { JsonObject } from "../../../domain/json.js";
import {
  parseAgentDefinition,
  type ActiveAgentRecord,
  type AgentDefinition,
  type AgentRecord,
  type ErrorRecord,
  type ErrorSeverity,
  type ErrorSource,
  type ResourceRecord,
  type ResourceState,
  type TaskRecord,
} from "../../../domain/records.js";
import type { NotionProviderOptions } from "../notion-environment.js";
import type { NotionTableKind } from "../notion-schema.js";
import { normalizeNotionId as normalizeId } from "../notion-id.js";
import {
  collectNotionPages,
  decodeCompletePageMarkdown,
  NotionApiError,
  type NotionTransport,
} from "../notion-transport.js";
import {
  activeAgentStatus,
  agentVersion,
  archived,
  checkboxValue,
  markdownSection,
  notionPageId,
  notionPageVersion,
  nullableTextValue,
  numberValue,
  optionalIsoDateValue,
  pageProperties,
  plainProperties,
  relatedRunId,
  relationIds,
  requireJsonObject,
  requiredIsoDateValue,
  requiredTextValue,
  selectValue,
  textValue,
} from "./values.js";

/** Runtime shared by the public Notion provider facade. */
export class NotionProviderRuntime {
  protected readonly tables: Record<NotionTableKind, string | null>;

  public constructor(
    protected readonly environment: NotionProviderOptions,
    protected readonly transport: NotionTransport,
  ) {
    this.tables = { ...environment.tables };
  }

  /** Decodes a Task record from its Notion page and Markdown. */
  protected async decodeTask(page: JsonObject): Promise<TaskRecord> {
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
  protected async decodeAgent(
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
  protected async stableAgentDefinition(page: JsonObject): Promise<{
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
  protected agentRecord(
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
  protected async resourceIdByKey(): Promise<ReadonlyMap<string, string>> {
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

  /** Decodes a Resource record from its Notion page and Markdown. */
  protected async decodeResource(page: JsonObject): Promise<ResourceRecord> {
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
  protected async activeRecords(
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
  protected async decodeError(page: JsonObject): Promise<ErrorRecord> {
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
  protected async pageOrNull(pageId: string): Promise<JsonObject | null> {
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
  protected assertManagedPage(page: JsonObject, kind: NotionTableKind): void {
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
  protected async query(
    kind: NotionTableKind,
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
  protected table(kind: NotionTableKind): string {
    /** Configured data-source ID before normalization. */
    const value = this.tables[kind];
    if (value === null)
      throw new Error(`Notion table is not configured: ${kind}`);
    return normalizeId(value);
  }

  /** Reads the complete Markdown representation of a Notion page. */
  protected async markdown(pageId: string): Promise<string> {
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
  protected async replaceMarkdown(
    pageId: string,
    markdown: string,
  ): Promise<void> {
    await this.transport.request({
      body: { replace_content: { new_str: markdown }, type: "replace_content" },
      method: "PATCH",
      path: `/v1/pages/${pageId}/markdown`,
    });
  }
}
