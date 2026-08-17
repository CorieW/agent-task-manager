/** Decodes provider-owned Notion rows and managed content into domain records. */
import { sha256 } from "../../core/digest.js";
import { pageAfter } from "../../core/pagination.js";
import { parseAgentDefinitionManifest } from "../../core/agent-definition.js";
import { taskSummaryMatchesPredicate } from "../../core/task-query-contract.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../domain/json.js";
import type {
  OperationRecord,
  ResourceRecord,
  ResourceRef,
  AgentDefinition,
  TaskQuery,
  TaskSnapshot,
  TaskSummary,
} from "../../domain/records.js";
import {
  collectNotionPages,
  type NotionTransport,
} from "./notion-transport.js";
import { objectValue, requiredString } from "./notion-json-boundary.js";
import { NOTION_TASK_MUTATION_PROPERTY } from "./notion-schema.js";
import { activeTaskBodyGeneration } from "./notion-task-body-generation.js";
import {
  isMarkdownResourceKind,
  resourceBodyFromMarkdownResponse,
} from "./notion-resource-markdown.js";
import {
  decodeResourceKindOption,
  decodeResourceStateOption,
} from "./notion-option-codec.js";

/** Provider-neutral Notion table IDs contract. */
export interface NotionTableIds {
  /** Errors table data-source identifier. */
  readonly errors: string;
  /** Resources table data-source identifier. */
  readonly resources: string;
  /** Operations table data-source identifier. */
  readonly operations?: string;
  /** Agents table data-source identifier. */
  readonly agents: string;
  /** Tasks table data-source identifier. */
  readonly tasks: string;
}

/** Implements Notion record reader. */
export class NotionRecordReader {
  /** Initializes Notion record reader. */
  public constructor(
    /** Ordered tables used by Notion record reader. */ private readonly tables: NotionTableIds,
    /** Ordered transport used by Notion record reader. */ private readonly transport: NotionTransport,
  ) {}

  /** Returns agent definitions in deterministic order. */
  public async listAgentDefinitions(): Promise<readonly AgentDefinition[]> {
    /** Result of `this.queryDataSource`, retained for `listAgentDefinitions`. */
    const pages = await this.queryDataSource(this.tables.agents);
    /** Result of `Promise.all`, retained for `listAgentDefinitions`. */
    const definitions = await Promise.all(
      pages.map((page) => this.agentDefinition(page)),
    );
    if (
      new Set(definitions.map((definition) => definition.id)).size !==
      definitions.length
    )
      throw new Error("Agent definition IDs must be unique");
    return definitions.sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Returns Agent definition. */
  public async getAgentDefinition(id: string): Promise<AgentDefinition> {
    /** Derived matches value for `getAgentDefinition`. */
    const matches = (await this.listAgentDefinitions()).filter(
      (definition) => definition.id === id,
    );
    if (matches.length !== 1)
      throw new Error(`Agent definition ${id} must resolve to exactly one row`);
    return requiredDefinition(matches[0], id);
  }

  /** Returns Agent page ID. */
  public async getAgentPageId(id: string): Promise<string> {
    /** Result of `this.queryDataSource`, retained for `getAgentPageId`. */
    const pages = await this.queryDataSource(this.tables.agents);
    /** Mutable matches collection accumulated during `getAgentPageId`. */
    const matches: string[] = [];
    for (const page of pages) {
      if ((await this.agentDefinition(page)).id === id)
        matches.push(requiredString(page.id, "Agent page id"));
    }
    if (matches.length !== 1)
      throw new Error(`Agent definition ${id} must resolve to exactly one row`);
    return requiredString(matches[0], "Agent page id");
  }

  /** Returns task summaries in deterministic order. */
  public async listTaskSummaries(
    query: TaskQuery,
  ): Promise<readonly TaskSummary[]> {
    /** Result of `this.queryDataSource`, retained for `listTaskSummaries`. */
    const pages = await this.queryDataSource(
      this.tables.tasks,
      taskPredicateFilter(query.predicate),
      1_000,
    );
    for (const key of Object.keys(query.predicate)) {
      if (!TASK_SUMMARY_KEYS.has(key))
        throw new Error(`Unsupported task predicate: ${key}`);
    }
    /** Candidate pages satisfying the provider-neutral summary predicate. */
    const candidatePages = pages.filter((page) =>
      taskSummaryMatchesPredicate(this.taskSummary(page), query.predicate),
    );
    /** Dependency pages reused across candidates that share prerequisites. */
    const dependencyPages = new Map<string, Promise<JsonObject>>();
    /** Summaries whose complete dependency set satisfies the query policy. */
    const matches: TaskSummary[] = [];
    for (const page of candidatePages) {
      /** Stable IDs of the candidate's prerequisite Tasks. */
      const dependencyIds = await this.relationIds(page, "Dependencies");
      /** Current prerequisite pages loaded from the configured Tasks table. */
      const dependencies = await Promise.all(
        dependencyIds.map((dependencyId) => {
          /** Shared read for one prerequisite referenced by multiple candidates. */
          let pending = dependencyPages.get(dependencyId);
          if (pending === undefined) {
            pending = this.getPageInTable(
              dependencyId,
              this.tables.tasks,
              "Task",
            );
            dependencyPages.set(dependencyId, pending);
          }
          return pending;
        }),
      );
      if (
        dependencies.every((dependencyPage) => {
          /** Bounded dependency state used for candidate eligibility. */
          const dependency = this.taskSummary(dependencyPage);
          return (
            !dependency.archived &&
            query.dependencySatisfiedStatuses.includes(dependency.status)
          );
        })
      ) {
        matches.push(this.taskSummary(page));
      }
    }
    return pageAfter(matches, query, (summary) => summary.id);
  }

  /** Returns task status options in deterministic order. */
  public async listTaskStatusOptions(): Promise<readonly string[]> {
    /** Result of `this.transport.request`, retained for `listTaskStatusOptions`. */
    const source = await this.transport.request({
      method: "GET",
      path: `/v1/data_sources/${this.tables.tasks}`,
    });
    /** Result of `objectValue`, retained for `listTaskStatusOptions`. */
    const status = objectValue(
      objectValue(source.properties, "Task properties").Status,
      "Task Status property",
    );
    if (status.type !== "select")
      throw new TypeError("Task Status must be select");
    /** Result of `objectValue`, retained for `listTaskStatusOptions`. */
    const options = objectValue(status.select, "Task Status select").options;
    if (!Array.isArray(options))
      throw new TypeError("Task Status options must be an array");
    /** Result of `options.map`, retained for `listTaskStatusOptions`. */
    const names = options.map((option) =>
      requiredString(
        objectValue(option, "Task Status option").name,
        "Task Status option name",
      ),
    );
    if (new Set(names).size !== names.length)
      throw new TypeError("Task Status options contain duplicates");
    return names.sort();
  }

  /** Returns reciprocal Task relations maintained by manager-owned Agent activity. */
  public async listDerivedTaskPropertyNames(): Promise<readonly string[]> {
    /** Agent data-source metadata containing the authoritative Working On relation. */
    const source = await this.transport.request({
      method: "GET",
      path: `/v1/data_sources/${this.tables.agents}`,
    });
    /** Configured Agent properties used to identify the reciprocal Task relation. */
    const properties = objectValue(source.properties, "Agent properties");
    /** Manager-owned Agent relation whose reciprocal value is provider-derived. */
    const workingOn = objectValue(
      properties["Working On"],
      "Agent Working On property",
    );
    if (workingOn.type !== "relation")
      throw new TypeError("Agent Working On must be relation");
    /** Relation metadata describing the target and reciprocal Notion property. */
    const relation = objectValue(
      workingOn.relation,
      "Agent Working On relation",
    );
    const target = relation.data_source_id ?? relation.database_id;
    if (target !== this.tables.tasks)
      throw new TypeError("Agent Working On must target Tasks");
    if (relation.type === "single_property") return [];
    if (relation.type !== "dual_property")
      throw new TypeError("Agent Working On relation type is invalid");
    /** Notion-created Task property updated whenever Agent Working On changes. */
    const reciprocal = objectValue(
      relation.dual_property,
      "Agent Working On reciprocal relation",
    );
    return [
      requiredString(
        reciprocal.synced_property_name,
        "Agent Working On reciprocal property name",
      ),
    ];
  }

  /** Returns task snapshot. */
  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    /** Result of `this.getPageInTable`, retained for `getTaskSnapshot`. */
    const page = await this.getPageInTable(taskId, this.tables.tasks, "Task");
    /** Result of `this.taskSummary`, retained for `getTaskSnapshot`. */
    const summary = this.taskSummary(page);
    /** Result of `objectValue`, retained for `getTaskSnapshot`. */
    const properties = objectValue(page.properties, "Task properties");
    /** Result of `this.relationIds`, retained for `getTaskSnapshot`. */
    const dependencies = await this.relationIds(page, "Dependencies");
    return {
      ...summary,
      body: await this.readPageMarkdown(taskId),
      dependencies,
      properties: decodeProperties(properties, [NOTION_TASK_MUTATION_PROPERTY]),
    };
  }

  /** Returns task mutation marker. */
  public async getTaskMutationMarker(taskId: string): Promise<string> {
    /** Result of `this.getPageInTable`, retained for `getTaskMutationMarker`. */
    const page = await this.getPageInTable(taskId, this.tables.tasks, "Task");
    return propertyText(page, NOTION_TASK_MUTATION_PROPERTY);
  }

  /** Returns task body mutation marker. */
  public async getTaskBodyMutationMarker(
    taskId: string,
  ): Promise<string | null> {
    return (
      activeTaskBodyGeneration(await this.readChildBlocks(taskId))?.digest ??
      null
    );
  }

  /** Returns resources. */
  public async getResources(
    refs: readonly ResourceRef[],
  ): Promise<readonly ResourceRecord[]> {
    /** Result of `this.queryDataSource`, retained for `getResources`. */
    const pages = await this.queryDataSource(this.tables.resources);
    /** Indexes entries in `indexed` for `getResources`. */
    const indexed = new Map<string, JsonObject[]>();
    for (const page of pages) {
      /** Result of `propertyText`, retained for `getResources`. */
      const key = propertyText(page, "Resource");
      indexed.set(key, [...(indexed.get(key) ?? []), page]);
    }
    /** Result of `indexed.get`, retained for `getResources`. */
    const records: ResourceRecord[] = [];
    for (const ref of refs) {
      /** Mutable state shared across `getResources`. */
      const candidates = indexed.get(ref.key) ?? [];
      if (candidates.length !== 1) {
        throw new Error(`Resource ${ref.key} must resolve to exactly one row`);
      }
      /** Result of `this.resourceRecord`, retained for `getResources`. */
      const record = await this.resourceRecord(
        requiredObject(candidates[0], "Resource page"),
      );
      if (ref.version !== null && ref.version !== record.version) {
        throw new Error(`Resource version mismatch: ${ref.key}`);
      }
      if (ref.digest !== null && ref.digest !== record.digest) {
        throw new Error(`Resource digest mismatch: ${ref.key}`);
      }
      records.push(record);
    }
    return records;
  }

  /** Returns optional resource. */
  public async getOptionalResource(
    key: string,
  ): Promise<ResourceRecord | null> {
    /** Result of `this.queryDataSource`, retained for `getOptionalResource`. */
    const pages = await this.queryDataSource(this.tables.resources, {
      property: "Resource",
      title: { equals: key },
    });
    if (pages.length > 1)
      throw new Error(`Resource ${key} must resolve to at most one row`);
    /** Page snapshot used consistently during `getOptionalResource`. */
    const page = pages[0];
    return page === undefined ? null : this.resourceRecord(page);
  }

  /** Returns manager-owned operational state by stable key. */
  public async getOptionalOperation(
    key: string,
  ): Promise<OperationRecord | null> {
    const pages = await this.queryDataSource(
      requiredString(this.tables.operations, "Operations data source id"),
      {
        property: "Operation",
        title: { equals: key },
      },
    );
    if (pages.length > 1)
      throw new Error(`Operation ${key} must resolve to at most one row`);
    const page = pages[0];
    return page === undefined ? null : this.operationRecord(page);
  }

  /** Queries data source. */
  public async queryDataSource(
    id: string,
    filter?: JsonObject,
    maxRecords = 1_000,
  ): Promise<readonly JsonObject[]> {
    return collectNotionPages(
      (cursor) =>
        this.transport.request({
          body:
            cursor === null
              ? { ...(filter === undefined ? {} : { filter }), page_size: 100 }
              : {
                  ...(filter === undefined ? {} : { filter }),
                  page_size: 100,
                  start_cursor: cursor,
                },
          method: "POST",
          path: `/v1/data_sources/${id}/query`,
        }),
      maxRecords,
    );
  }

  /** Reads page markdown. */
  public async readPageMarkdown(pageId: string): Promise<string> {
    /** Result of `this.readChildBlocks`, retained for `readPageMarkdown`. */
    const blocks = await this.readChildBlocks(pageId);
    /** Result of `activeTaskBodyGeneration`, retained for `readPageMarkdown`. */
    const activeGeneration = activeTaskBodyGeneration(blocks);
    if (activeGeneration !== null) return activeGeneration.body;
    if (blocks.length === 1 && blocks[0]?.type === "code") {
      /** Result of `objectValue`, retained for `readPageMarkdown`. */
      const code = objectValue(blocks[0].code, "Task body code");
      if (code.language === "markdown")
        return blockText(blocks[0]).replace(/\r\n?/gu, "\n").normalize("NFC");
    }
    /** Derived lines value for `readPageMarkdown`. */
    const lines: string[] = [];
    for (const block of blocks) {
      lines.push(await this.blockMarkdown(block));
    }
    return normalizeMarkdown(lines.filter((line) => line !== "").join("\n\n"));
  }

  /** Decodes Agent definition from Notion records. */
  private async agentDefinition(page: JsonObject): Promise<AgentDefinition> {
    assertPageParent(page, this.tables.agents, "Agent");
    if (page.archived === true || page.in_trash === true)
      throw new Error("Agent definition is archived");
    /** Result of `requiredString`, retained for `agentDefinition`. */
    const pageId = requiredString(page.id, "Agent page id");
    /** Result of `this.managedJson`, retained for `agentDefinition`. */
    const manifest = await this.managedJson(pageId, "Agent definition");
    /** Result of `parseAgentDefinitionManifest`, retained for `agentDefinition`. */
    const definition = parseAgentDefinitionManifest(manifest);
    /** Result of `propertyText`, retained for `agentDefinition`. */
    const name = propertyText(page, "Name");
    /** Result of `propertyBoolean`, retained for `agentDefinition`. */
    const enabled = propertyBoolean(page, "Enabled");
    /** Result of `propertyNumber`, retained for `agentDefinition`. */
    const revision = propertyNumber(page, "Revision");
    /** Result of `propertyText`, retained for `agentDefinition`. */
    const model = propertyText(page, "Model");
    if (
      definition.name !== name ||
      definition.enabled !== enabled ||
      definition.revision !== revision ||
      definition.model !== model
    ) {
      throw new Error(
        `Agent ${definition.id} manifest does not match its authoritative properties`,
      );
    }
    return definition;
  }

  /** Projects a Task snapshot into its bounded summary. */
  private taskSummary(page: JsonObject): TaskSummary {
    /** Result of `requiredString`, retained for `taskSummary`. */
    const id = requiredString(page.id, "Task page id");
    return {
      archived: page.archived === true || page.in_trash === true,
      id,
      priority: propertyNullableNumber(page, "Priority"),
      status: propertyOption(page, "Status"),
      title: propertyText(page, "Task"),
      version: requiredString(
        page.last_edited_time,
        `Task ${id} last_edited_time`,
      ),
    };
  }

  /** Builds record. */
  private async resourceRecord(page: JsonObject): Promise<ResourceRecord> {
    /** Result of `requiredString`, retained for `resourceRecord`. */
    const id = requiredString(page.id, "Resource page id");
    /** Reads the expected digest before selecting legacy Markdown compatibility. */
    const digest = propertyText(page, "Digest");
    /** Record kind controlling provider representation. */
    const kind = decodeResourceKindOption(propertyOption(page, "Kind"));
    /** Result of `isMarkdownResourceKind`, retained for `resourceRecord`. */
    const body = isMarkdownResourceKind(kind)
      ? await this.managedResourceMarkdown(id, digest)
      : await this.managedText(id, "Resource body");
    /** Result of `propertyText`, retained for `resourceRecord`. */
    const dependencyValue = propertyText(page, "Dependencies");
    /** Result of `parseResourceRefs`, retained for `resourceRecord`. */
    const parsed: unknown =
      dependencyValue === "" ? [] : JSON.parse(dependencyValue);
    /** Result of `parseResourceRefs`, retained for `resourceRecord`. */
    const dependencies = parseResourceRefs(toJsonValue(parsed));
    /** Record snapshot used consistently during `resourceRecord`. */
    const record: ResourceRecord = {
      body,
      dependencies,
      digest,
      key: propertyText(page, "Resource"),
      kind,
      state: decodeResourceStateOption(propertyOption(page, "State")),
      version: propertyText(page, "Version"),
    };
    if (record.digest !== sha256(body)) {
      throw new Error(
        `Resource ${record.key} body does not match its Digest property`,
      );
    }
    return record;
  }

  /** Decodes one manager-owned operational record. */
  private async operationRecord(page: JsonObject): Promise<OperationRecord> {
    const id = requiredString(page.id, "Operation page id");
    const body = await this.managedText(id, "Operation body");
    const digest = propertyText(page, "Digest");
    const dependencyValue = propertyText(page, "Dependencies");
    const parsed: unknown =
      dependencyValue === "" ? [] : JSON.parse(dependencyValue);
    const record: OperationRecord = {
      body,
      dependencies: parseResourceRefs(toJsonValue(parsed)),
      digest,
      key: propertyText(page, "Operation"),
      kind: propertyText(page, "Kind"),
      state: decodeResourceStateOption(propertyOption(page, "State")),
      version: propertyText(page, "Version"),
    };
    if (record.digest !== sha256(body))
      throw new Error(
        `Operation ${record.key} body does not match its Digest property`,
      );
    return record;
  }

  /** Parses a managed child-block section as JSON. */
  private async managedJson(
    pageId: string,
    heading: string,
  ): Promise<JsonObject> {
    /** Result of `this.managedText`, retained for `managedJson`. */
    const raw = await this.managedText(pageId, heading);
    return objectValue(toJsonValue(JSON.parse(raw)), `${heading} JSON`);
  }

  /** Reads text from a named managed child-block section. */
  private async managedText(pageId: string, heading: string): Promise<string> {
    /** Result of `this.readChildBlocks`, retained for `managedText`. */
    const blocks = await this.readChildBlocks(pageId);
    /** Managed headings whose text matches the requested section. */
    const matches = blocks
      .map((block, index) => ({ block, index }))
      .filter(
        ({ block }) =>
          block.type === "heading_2" && blockText(block) === heading,
      );
    if (matches.length !== 1)
      throw new Error(
        `Page ${pageId} must contain exactly one ## ${heading} section`,
      );
    /** Index counter used during `managedText`. */
    const index = matches[0]?.index;
    if (index === undefined)
      throw new Error(`Page ${pageId} managed section is missing`);
    /** Content snapshot used consistently during `managedText`. */
    const content = blocks[index + 1];
    if (content === undefined || content.type !== "code") {
      throw new Error(
        `## ${heading} must be followed by exactly one code block`,
      );
    }
    /** Next snapshot used consistently during `managedText`. */
    const next = blocks[index + 2];
    if (next?.type === "code")
      throw new Error(`## ${heading} must contain exactly one code block`);
    return blockText(content).replace(/\r\n?/gu, "\n").normalize("NFC");
  }

  /** Reads a readable Resource through Notion's native enhanced-Markdown endpoint. */
  private async managedResourceMarkdown(
    pageId: string,
    expectedDigest: string,
  ): Promise<string> {
    /** Retrieves the complete page projection and its truncation evidence. */
    const response = await this.transport.request({
      method: "GET",
      path: `/v1/pages/${pageId}/markdown`,
    });
    return resourceBodyFromMarkdownResponse(response, expectedDigest);
  }

  /** Reads IDs. */
  private async relationIds(
    page: JsonObject,
    propertyName: string,
  ): Promise<readonly string[]> {
    /** Result of `pageProperty`, retained for `relationIds`. */
    const property = pageProperty(page, propertyName);
    /** Result of `relationValues`, retained for `relationIds`. */
    const inline = relationValues(property);
    if (property.has_more !== true) return [...new Set(inline)].sort();
    /** Result of `requiredString`, retained for `relationIds`. */
    const pageId = requiredString(page.id, "Page id");
    /** Result of `requiredString`, retained for `relationIds`. */
    const propertyId = requiredString(
      property.id,
      `${propertyName} property id`,
    );
    /** Result of `collectNotionPages`, retained for `relationIds`. */
    const items = await collectNotionPages((cursor) =>
      this.transport.request({
        method: "GET",
        path: `/v1/pages/${pageId}/properties/${encodeURIComponent(propertyId)}`,
        query: { page_size: 100, start_cursor: cursor },
      }),
    );
    return [...new Set(items.flatMap((item) => relationValues(item)))].sort();
  }

  /** Returns page in table. */
  private async getPageInTable(
    id: string,
    tableId: string,
    label: string,
  ): Promise<JsonObject> {
    /** Result of `this.transport.request`, retained for `getPageInTable`. */
    const page = await this.transport.request({
      method: "GET",
      path: `/v1/pages/${id}`,
    });
    if (page.object !== "page")
      throw new TypeError(`${id} is not a Notion page`);
    assertPageParent(page, tableId, label);
    return page;
  }

  /** Reads child blocks. */
  private async readChildBlocks(
    blockId: string,
  ): Promise<readonly JsonObject[]> {
    return collectNotionPages((cursor) =>
      this.transport.request({
        method: "GET",
        path: `/v1/blocks/${blockId}/children`,
        query: { page_size: 100, start_cursor: cursor },
      }),
    );
  }

  /** Decodes block markdown from Notion records. */
  private async blockMarkdown(block: JsonObject): Promise<string> {
    /** Result of `requiredString`, retained for `blockMarkdown`. */
    const type = requiredString(block.type, "Block type");
    /** Result of `blockText`, retained for `blockMarkdown`. */
    const text = blockText(block);
    /** Rendered snapshot used consistently during `blockMarkdown`. */
    let rendered: string;
    switch (type) {
      case "heading_1":
        rendered = `# ${text}`;
        break;
      case "heading_2":
        rendered = `## ${text}`;
        break;
      case "heading_3":
        rendered = `### ${text}`;
        break;
      case "bulleted_list_item":
        rendered = `- ${text}`;
        break;
      case "numbered_list_item":
        rendered = `1. ${text}`;
        break;
      case "to_do":
        rendered = `- [${objectValue(block[type], type).checked === true ? "x" : " "}] ${text}`;
        break;
      case "code":
        rendered = `\`\`\`${stringValue(objectValue(block[type], type).language)}\n${text}\n\`\`\``;
        break;
      case "divider":
        rendered = "---";
        break;
      case "paragraph":
      case "quote":
      case "callout":
        rendered = text;
        break;
      default:
        throw new Error(`Unsupported Notion block type: ${type}`);
    }
    if (block.has_children === true) {
      /** Result of `requiredString`, retained for `blockMarkdown`. */
      const id = requiredString(block.id, "Block id");
      /** Result of `this.readChildBlocks`, retained for `blockMarkdown`. */
      const children = await this.readChildBlocks(id);
      /** Result of `Promise.all`, retained for `blockMarkdown`. */
      const childText = await Promise.all(
        children.map((child) => this.blockMarkdown(child)),
      );
      rendered += `\n${childText.join("\n")}`;
    }
    return rendered;
  }
}

/** Allowlist of Task fields accepted by summary predicates. */
const TASK_SUMMARY_KEYS = new Set([
  "archived",
  "id",
  "priority",
  "status",
  "title",
  "version",
]);

/** Builds predicate filter. */
function taskPredicateFilter(predicate: JsonObject): JsonObject | undefined {
  /** Derived filters value for `taskPredicateFilter`. */
  const filters: JsonObject[] = [];
  if (typeof predicate.status === "string")
    filters.push({ property: "Status", select: { equals: predicate.status } });
  if (Array.isArray(predicate.status))
    filters.push({
      or: predicate.status.map((status) => ({
        property: "Status",
        select: { equals: status },
      })),
    });
  if (typeof predicate.title === "string")
    filters.push({ property: "Task", title: { equals: predicate.title } });
  if (typeof predicate.priority === "number")
    filters.push({
      number: { equals: predicate.priority },
      property: "Priority",
    });
  if (filters.length === 0) return undefined;
  return filters.length === 1 ? filters[0] : { and: filters };
}

/** Decodes properties. */
function decodeProperties(
  properties: JsonObject,
  excluded: readonly string[] = [],
): JsonObject {
  /** Seen excluded names used to reject duplicates in `decodeProperties`. */
  const excludedNames = new Set(excluded);
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([name]) => !excludedNames.has(name))
      .map(([name, raw]) => {
        /** Result of `objectValue`, retained for `decodeProperties`. */
        const property = objectValue(raw, `Property ${name}`);
        /** Result of `requiredString`, retained for `decodeProperties`. */
        const type = requiredString(property.type, `Property ${name} type`);
        /** Value snapshot used consistently during `decodeProperties`. */
        const value = property[type];
        if (type === "title" || type === "rich_text")
          return [name, richText(value)];
        if (type === "status" || type === "select")
          return [name, optionName(value)];
        if (
          type === "number" ||
          type === "checkbox" ||
          type === "url" ||
          type === "date"
        )
          return [name, value ?? null];
        if (type === "relation") return [name, relationValues(property)];
        return [name, value ?? null];
      }),
  );
}

/** Extracts text from a title or rich-text page property. */
function propertyText(page: JsonObject, name: string): string {
  /** Result of `pageProperty`, retained for `propertyText`. */
  const property = pageProperty(page, name);
  /** Result of `requiredString`, retained for `propertyText`. */
  const type = requiredString(property.type, `${name} type`);
  if (type !== "title" && type !== "rich_text")
    throw new TypeError(`${name} must be title or rich_text`);
  return richText(property[type]);
}

/** Extracts the selected option from a page property. */
function propertyOption(page: JsonObject, name: string): string {
  /** Result of `pageProperty`, retained for `propertyOption`. */
  const property = pageProperty(page, name);
  /** Result of `requiredString`, retained for `propertyOption`. */
  const type = requiredString(property.type, `${name} type`);
  if (type !== "status" && type !== "select")
    throw new TypeError(`${name} must be status or select`);
  /** Result of `propertyOption`, retained for validation and reuse. */
  const result = optionName(property[type]);
  if (result === null) throw new TypeError(`${name} must have an option`);
  return result;
}

/** Extracts a checkbox value from a page property. */
function propertyBoolean(page: JsonObject, name: string): boolean {
  /** Result of `pageProperty`, retained for `propertyBoolean`. */
  const property = pageProperty(page, name);
  if (property.type !== "checkbox" || typeof property.checkbox !== "boolean")
    throw new TypeError(`${name} must be checkbox`);
  return property.checkbox;
}

/** Extracts a required numeric page property. */
function propertyNumber(page: JsonObject, name: string): number {
  /** Result of `propertyNumber`, retained for validation and reuse. */
  const result = propertyNullableNumber(page, name);
  if (result === null) throw new TypeError(`${name} must have a number`);
  return result;
}

/** Extracts an optional numeric page property. */
function propertyNullableNumber(page: JsonObject, name: string): number | null {
  /** Result of `pageProperty`, retained for `propertyNullableNumber`. */
  const property = pageProperty(page, name);
  if (
    property.type !== "number" ||
    (property.number !== null && typeof property.number !== "number")
  ) {
    throw new TypeError(`${name} must be number`);
  }
  return property.number;
}

/** Returns a named property from a Notion page. */
function pageProperty(page: JsonObject, name: string): JsonObject {
  /** Result of `objectValue`, retained for `pageProperty`. */
  const properties = objectValue(page.properties, "Page properties");
  /** Property snapshot used consistently during `pageProperty`. */
  const property = properties[name];
  if (property === undefined)
    throw new TypeError(`Page is missing property ${name}`);
  return objectValue(property, `Property ${name}`);
}

/** Reads values. */
function relationValues(property: JsonObject): readonly string[] {
  /** Derived value value for `relationValues`. */
  const value = property.relation;
  if (Array.isArray(value)) {
    return value.map((item) =>
      requiredString(objectValue(item, "Relation item").id, "Relation id"),
    );
  }
  if (value !== null && value !== undefined && typeof value === "object") {
    return [
      requiredString(objectValue(value, "Relation item").id, "Relation id"),
    ];
  }
  return [];
}

/** Converts text. */
function richText(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      /** Result of `objectValue`, retained for `richText`. */
      const object = objectValue(item, "Rich text item");
      if (typeof object.plain_text === "string") return object.plain_text;
      /** Result of `objectValue`, retained for `richText`. */
      const text = objectValue(object.text, "Rich text value");
      return typeof text.content === "string" ? text.content : "";
    })
    .join("");
}

/** Extracts plain text from a supported Notion block. */
function blockText(block: JsonObject): string {
  /** Result of `requiredString`, retained for `blockText`. */
  const type = requiredString(block.type, "Block type");
  /** Result of `objectValue`, retained for `blockText`. */
  const value = objectValue(block[type], `Block ${type}`);
  return richText(value.rich_text);
}

/** Decodes option name from Notion records. */
function optionName(value: JsonValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(objectValue(value, "Option").name, "Option name");
}

/** Parses and validates resource refs. */
function parseResourceRefs(value: JsonValue): readonly ResourceRef[] {
  if (!Array.isArray(value))
    throw new TypeError("Resource Dependencies must be a JSON array");
  return value.map((item, index) => {
    /** Result of `objectValue`, retained for `parseResourceRefs`. */
    const object = objectValue(item, `Dependency ${index}`);
    assertExactKeys(
      object,
      ["digest", "key", "version"],
      `Dependency ${index}`,
    );
    return {
      digest:
        object.digest === null
          ? null
          : requiredString(object.digest, `Dependency ${index}.digest`),
      key: requiredString(object.key, `Dependency ${index}.key`),
      version:
        object.version === null
          ? null
          : requiredString(object.version, `Dependency ${index}.version`),
    };
  });
}

/** Rejects values that violate the exact keys contract. */
function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  /** Expected actual used to validate `assertExactKeys`. */
  const actual = Object.keys(value).sort();
  /** Result of `sortedExpected.join`, retained for `assertExactKeys`. */
  const sortedExpected = [...expected].sort();
  if (actual.join("\0") !== sortedExpected.join("\0"))
    throw new TypeError(`${label} has unexpected or missing fields`);
}

/** Validates value. */
function stringValue(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Normalizes markdown. */
function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trimEnd();
}

/** Returns object or throws for invalid input. */
function requiredObject(
  value: JsonObject | undefined,
  label: string,
): JsonObject {
  if (value === undefined) throw new TypeError(`${label} is missing`);
  return value;
}

/** Returns definition or throws for invalid input. */
function requiredDefinition(
  value: AgentDefinition | undefined,
  id: string,
): AgentDefinition {
  if (value === undefined)
    throw new Error(`Agent definition is missing: ${id}`);
  return value;
}

/** Rejects values that violate the page parent contract. */
function assertPageParent(
  page: JsonObject,
  tableId: string,
  label: string,
): void {
  /** Result of `objectValue`, retained for `assertPageParent`. */
  const parent = objectValue(page.parent, `${label} parent`);
  /** Expected observed used to validate `assertPageParent`. */
  const observed = parent.data_source_id;
  if (
    typeof observed !== "string" ||
    compactIdentifier(observed) !== compactIdentifier(tableId)
  )
    throw new Error(`${label} does not belong to its configured table`);
}

/** Normalizes identifier. */
function compactIdentifier(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}
