/** Decodes provider-owned Notion rows and managed content into domain records. */
import { sha256 } from "../../core/digest.js";
import { pageAfter } from "../../core/pagination.js";
import { parseAgentDefinitionManifest } from "../../core/agent-definition.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../domain/json.js";
import type {
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
import { NOTION_TASK_MUTATION_PROPERTY } from "./notion-schema.js";
import { activeTaskBodyGeneration } from "./notion-task-body-generation.js";
import { promptBodyText } from "./notion-prompt-body.js";

/** Defines Notion table IDs. */
export interface NotionTableIds {
  /** Contains errors for Notion table IDs. */
  readonly errors: string;
  /** Contains resources for Notion table IDs. */
  readonly resources: string;
  /** Contains Agents for Notion table IDs. */
  readonly agents: string;
  /** Contains tasks for Notion table IDs. */
  readonly tasks: string;
}

/** Implements Notion record reader. */
export class NotionRecordReader {
  /** Initializes Notion record reader. */
  public constructor(
    /** Contains tables for Notion record reader. */ private readonly tables: NotionTableIds,
    /** Contains transport for Notion record reader. */ private readonly transport: NotionTransport,
  ) {}

  /** Lists Agent definitions. */
  public async listAgentDefinitions(): Promise<readonly AgentDefinition[]> {
    /** Holds the `pages` intermediate used by `listAgentDefinitions`. */
    const pages = await this.queryDataSource(this.tables.agents);
    /** Holds the `definitions` intermediate used by `listAgentDefinitions`. */
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
    /** Holds the `matches` intermediate used by `getAgentDefinition`. */
    const matches = (await this.listAgentDefinitions()).filter(
      (definition) => definition.id === id,
    );
    if (matches.length !== 1)
      throw new Error(`Agent definition ${id} must resolve to exactly one row`);
    return requiredDefinition(matches[0], id);
  }

  /** Returns Agent page ID. */
  public async getAgentPageId(id: string): Promise<string> {
    /** Holds the `pages` intermediate used by `getAgentPageId`. */
    const pages = await this.queryDataSource(this.tables.agents);
    /** Holds the `matches` intermediate used by `getAgentPageId`. */
    const matches: string[] = [];
    for (const page of pages) {
      if ((await this.agentDefinition(page)).id === id)
        matches.push(requiredString(page.id, "Agent page id"));
    }
    if (matches.length !== 1)
      throw new Error(`Agent definition ${id} must resolve to exactly one row`);
    return requiredString(matches[0], "Agent page id");
  }

  /** Lists task summaries. */
  public async listTaskSummaries(
    query: TaskQuery,
  ): Promise<readonly TaskSummary[]> {
    /** Holds the `pages` intermediate used by `listTaskSummaries`. */
    const pages = await this.queryDataSource(
      this.tables.tasks,
      taskPredicateFilter(query.predicate),
      1_000,
    );
    /** Holds the `summaries` intermediate used by `listTaskSummaries`. */
    const summaries = pages.map((page) => this.taskSummary(page));
    for (const key of Object.keys(query.predicate)) {
      if (!TASK_SUMMARY_KEYS.has(key))
        throw new Error(`Unsupported task predicate: ${key}`);
    }
    /** Holds the `matches` intermediate used by `listTaskSummaries`. */
    const matches = summaries.filter((summary) =>
      Object.entries(query.predicate).every(([key, expected]) =>
        Object.is(summary[key as keyof TaskSummary], expected),
      ),
    );
    return pageAfter(matches, query, (summary) => summary.id);
  }

  /** Lists task status options. */
  public async listTaskStatusOptions(): Promise<readonly string[]> {
    /** Holds the `source` intermediate used by `listTaskStatusOptions`. */
    const source = await this.transport.request({
      method: "GET",
      path: `/v1/data_sources/${this.tables.tasks}`,
    });
    /** Holds the `status` intermediate used by `listTaskStatusOptions`. */
    const status = objectValue(
      objectValue(source.properties, "Task properties").Status,
      "Task Status property",
    );
    if (status.type !== "select")
      throw new TypeError("Task Status must be select");
    /** Holds the `options` intermediate used by `listTaskStatusOptions`. */
    const options = objectValue(status.select, "Task Status select").options;
    if (!Array.isArray(options))
      throw new TypeError("Task Status options must be an array");
    /** Holds the `names` intermediate used by `listTaskStatusOptions`. */
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

  /** Returns task snapshot. */
  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    /** Holds the `page` intermediate used by `getTaskSnapshot`. */
    const page = await this.getPageInTable(taskId, this.tables.tasks, "Task");
    /** Holds the `summary` intermediate used by `getTaskSnapshot`. */
    const summary = this.taskSummary(page);
    /** Holds the `properties` intermediate used by `getTaskSnapshot`. */
    const properties = objectValue(page.properties, "Task properties");
    /** Holds the `dependencies` intermediate used by `getTaskSnapshot`. */
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
    /** Holds the `page` intermediate used by `getTaskMutationMarker`. */
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
    /** Holds the `pages` intermediate used by `getResources`. */
    const pages = await this.queryDataSource(this.tables.resources);
    /** Indexes entries in `indexed` for `getResources`. */
    const indexed = new Map<string, JsonObject[]>();
    for (const page of pages) {
      /** Holds the `key` intermediate used by `getResources`. */
      const key = propertyText(page, "Resource");
      indexed.set(key, [...(indexed.get(key) ?? []), page]);
    }
    /** Holds the `records` intermediate used by `getResources`. */
    const records: ResourceRecord[] = [];
    for (const ref of refs) {
      /** Tracks the `candidates` condition in `getResources`. */
      const candidates = indexed.get(ref.key) ?? [];
      if (candidates.length !== 1) {
        throw new Error(`Resource ${ref.key} must resolve to exactly one row`);
      }
      /** Holds the `record` intermediate used by `getResources`. */
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
    /** Holds the `pages` intermediate used by `getOptionalResource`. */
    const pages = await this.queryDataSource(this.tables.resources, {
      property: "Resource",
      title: { equals: key },
    });
    if (pages.length > 1)
      throw new Error(`Resource ${key} must resolve to at most one row`);
    /** Holds the `page` intermediate used by `getOptionalResource`. */
    const page = pages[0];
    return page === undefined ? null : this.resourceRecord(page);
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
    /** Holds the `blocks` intermediate used by `readPageMarkdown`. */
    const blocks = await this.readChildBlocks(pageId);
    /** Holds the `activeGeneration` intermediate used by `readPageMarkdown`. */
    const activeGeneration = activeTaskBodyGeneration(blocks);
    if (activeGeneration !== null) return activeGeneration.body;
    if (blocks.length === 1 && blocks[0]?.type === "code") {
      /** Holds the `code` intermediate used by `readPageMarkdown`. */
      const code = objectValue(blocks[0].code, "Task body code");
      if (code.language === "markdown")
        return blockText(blocks[0]).replace(/\r\n?/gu, "\n").normalize("NFC");
    }
    /** Holds the `lines` intermediate used by `readPageMarkdown`. */
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
    /** Holds the `pageId` intermediate used by `agentDefinition`. */
    const pageId = requiredString(page.id, "Agent page id");
    /** Holds the `manifest` intermediate used by `agentDefinition`. */
    const manifest = await this.managedJson(pageId, "Agent definition");
    /** Holds the `definition` intermediate used by `agentDefinition`. */
    const definition = parseAgentDefinitionManifest(manifest);
    /** Holds the `name` intermediate used by `agentDefinition`. */
    const name = propertyText(page, "Name");
    /** Holds the `enabled` intermediate used by `agentDefinition`. */
    const enabled = propertyBoolean(page, "Enabled");
    /** Holds the `revision` intermediate used by `agentDefinition`. */
    const revision = propertyNumber(page, "Revision");
    /** Holds the `model` intermediate used by `agentDefinition`. */
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
    /** Holds the `id` intermediate used by `taskSummary`. */
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
    /** Holds the `id` intermediate used by `resourceRecord`. */
    const id = requiredString(page.id, "Resource page id");
    /** Holds the `body` intermediate used by `resourceRecord`. */
    const kind = propertyOption(page, "Kind");
    /** Holds the `body` intermediate used by `resourceRecord`. */
    const body =
      kind === "prompt"
        ? await this.managedPromptText(id, "Resource body")
        : await this.managedText(id, "Resource body");
    /** Holds the `dependencyValue` intermediate used by `resourceRecord`. */
    const dependencyValue = propertyText(page, "Dependencies");
    /** Holds the `parsed` intermediate used by `resourceRecord`. */
    const parsed: unknown =
      dependencyValue === "" ? [] : JSON.parse(dependencyValue);
    /** Holds the `dependencies` intermediate used by `resourceRecord`. */
    const dependencies = parseResourceRefs(toJsonValue(parsed));
    /** Holds the `record` intermediate used by `resourceRecord`. */
    const record: ResourceRecord = {
      body,
      dependencies,
      digest: propertyText(page, "Digest"),
      key: propertyText(page, "Resource"),
      kind,
      state: parseResourceState(propertyOption(page, "State")),
      version: propertyText(page, "Version"),
    };
    if (record.digest !== sha256(body)) {
      throw new Error(
        `Resource ${record.key} body does not match its Digest property`,
      );
    }
    return record;
  }

  /** Parses a managed child-block section as JSON. */
  private async managedJson(
    pageId: string,
    heading: string,
  ): Promise<JsonObject> {
    /** Holds the `raw` intermediate used by `managedJson`. */
    const raw = await this.managedText(pageId, heading);
    return objectValue(toJsonValue(JSON.parse(raw)), `${heading} JSON`);
  }

  /** Reads text from a named managed child-block section. */
  private async managedText(pageId: string, heading: string): Promise<string> {
    /** Holds the `blocks` intermediate used by `managedText`. */
    const blocks = await this.readChildBlocks(pageId);
    /** Holds the `matches` intermediate used by `managedText`. */
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
    /** Holds the `index` intermediate used by `managedText`. */
    const index = matches[0]?.index;
    if (index === undefined)
      throw new Error(`Page ${pageId} managed section is missing`);
    /** Holds the `content` intermediate used by `managedText`. */
    const content = blocks[index + 1];
    if (content === undefined || content.type !== "code") {
      throw new Error(
        `## ${heading} must be followed by exactly one code block`,
      );
    }
    /** Holds the `next` intermediate used by `managedText`. */
    const next = blocks[index + 2];
    if (next?.type === "code")
      throw new Error(`## ${heading} must contain exactly one code block`);
    return blockText(content).replace(/\r\n?/gu, "\n").normalize("NFC");
  }

  /** Reads a prompt Resource from readable paragraphs or its legacy code block. */
  private async managedPromptText(
    pageId: string,
    heading: string,
  ): Promise<string> {
    /** Reads every top-level page block once for deterministic section parsing. */
    const blocks = await this.readChildBlocks(pageId);
    /** Locates the unique managed prompt heading. */
    const matches = blocks
      .map((block, index) => ({ block, index }))
      .filter(
        ({ block }) =>
          block.type === "heading_2" && blockText(block) === heading,
      );
    if (matches.length !== 1) {
      throw new Error(
        `Page ${pageId} must contain exactly one ## ${heading} section`,
      );
    }
    /** Selects the first block owned by the prompt section. */
    const index = matches[0]?.index;
    if (index === undefined) {
      throw new Error(`Page ${pageId} managed prompt section is missing`);
    }
    return promptBodyText(blocks.slice(index + 1));
  }

  /** Reads IDs. */
  private async relationIds(
    page: JsonObject,
    propertyName: string,
  ): Promise<readonly string[]> {
    /** Holds the `property` intermediate used by `relationIds`. */
    const property = pageProperty(page, propertyName);
    /** Holds the `inline` intermediate used by `relationIds`. */
    const inline = relationValues(property);
    if (property.has_more !== true) return [...new Set(inline)].sort();
    /** Holds the `pageId` intermediate used by `relationIds`. */
    const pageId = requiredString(page.id, "Page id");
    /** Holds the `propertyId` intermediate used by `relationIds`. */
    const propertyId = requiredString(
      property.id,
      `${propertyName} property id`,
    );
    /** Holds the `items` intermediate used by `relationIds`. */
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
    /** Holds the `page` intermediate used by `getPageInTable`. */
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
    /** Holds the `type` intermediate used by `blockMarkdown`. */
    const type = requiredString(block.type, "Block type");
    /** Holds the `text` intermediate used by `blockMarkdown`. */
    const text = blockText(block);
    /** Holds the `rendered` intermediate used by `blockMarkdown`. */
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
      /** Holds the `id` intermediate used by `blockMarkdown`. */
      const id = requiredString(block.id, "Block id");
      /** Holds the `children` intermediate used by `blockMarkdown`. */
      const children = await this.readChildBlocks(id);
      /** Holds the `childText` intermediate used by `blockMarkdown`. */
      const childText = await Promise.all(
        children.map((child) => this.blockMarkdown(child)),
      );
      rendered += `\n${childText.join("\n")}`;
    }
    return rendered;
  }
}

/** Defines the module-level `TASK_SUMMARY_KEYS` value. */
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
  /** Holds the `filters` intermediate used by `taskPredicateFilter`. */
  const filters: JsonObject[] = [];
  if (typeof predicate.status === "string")
    filters.push({ property: "Status", select: { equals: predicate.status } });
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
  /** Tracks unique entries in `excludedNames` for `decodeProperties`. */
  const excludedNames = new Set(excluded);
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([name]) => !excludedNames.has(name))
      .map(([name, raw]) => {
        /** Holds the `property` intermediate used by `decodeProperties`. */
        const property = objectValue(raw, `Property ${name}`);
        /** Holds the `type` intermediate used by `decodeProperties`. */
        const type = requiredString(property.type, `Property ${name} type`);
        /** Holds the `value` intermediate used by `decodeProperties`. */
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
  /** Holds the `property` intermediate used by `propertyText`. */
  const property = pageProperty(page, name);
  /** Holds the `type` intermediate used by `propertyText`. */
  const type = requiredString(property.type, `${name} type`);
  if (type !== "title" && type !== "rich_text")
    throw new TypeError(`${name} must be title or rich_text`);
  return richText(property[type]);
}

/** Extracts the selected option from a page property. */
function propertyOption(page: JsonObject, name: string): string {
  /** Holds the `property` intermediate used by `propertyOption`. */
  const property = pageProperty(page, name);
  /** Holds the `type` intermediate used by `propertyOption`. */
  const type = requiredString(property.type, `${name} type`);
  if (type !== "status" && type !== "select")
    throw new TypeError(`${name} must be status or select`);
  /** Captures `result` returned by `propertyOption`. */
  const result = optionName(property[type]);
  if (result === null) throw new TypeError(`${name} must have an option`);
  return result;
}

/** Extracts a checkbox value from a page property. */
function propertyBoolean(page: JsonObject, name: string): boolean {
  /** Holds the `property` intermediate used by `propertyBoolean`. */
  const property = pageProperty(page, name);
  if (property.type !== "checkbox" || typeof property.checkbox !== "boolean")
    throw new TypeError(`${name} must be checkbox`);
  return property.checkbox;
}

/** Extracts a required numeric page property. */
function propertyNumber(page: JsonObject, name: string): number {
  /** Captures `result` returned by `propertyNumber`. */
  const result = propertyNullableNumber(page, name);
  if (result === null) throw new TypeError(`${name} must have a number`);
  return result;
}

/** Extracts an optional numeric page property. */
function propertyNullableNumber(page: JsonObject, name: string): number | null {
  /** Holds the `property` intermediate used by `propertyNullableNumber`. */
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
  /** Holds the `properties` intermediate used by `pageProperty`. */
  const properties = objectValue(page.properties, "Page properties");
  /** Holds the `property` intermediate used by `pageProperty`. */
  const property = properties[name];
  if (property === undefined)
    throw new TypeError(`Page is missing property ${name}`);
  return objectValue(property, `Property ${name}`);
}

/** Reads values. */
function relationValues(property: JsonObject): readonly string[] {
  /** Holds the `value` intermediate used by `relationValues`. */
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
      /** Holds the `object` intermediate used by `richText`. */
      const object = objectValue(item, "Rich text item");
      if (typeof object.plain_text === "string") return object.plain_text;
      /** Holds the `text` intermediate used by `richText`. */
      const text = objectValue(object.text, "Rich text value");
      return typeof text.content === "string" ? text.content : "";
    })
    .join("");
}

/** Extracts plain text from a supported Notion block. */
function blockText(block: JsonObject): string {
  /** Holds the `type` intermediate used by `blockText`. */
  const type = requiredString(block.type, "Block type");
  /** Holds the `value` intermediate used by `blockText`. */
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
    /** Holds the `object` intermediate used by `parseResourceRefs`. */
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

/** Parses and validates resource state. */
function parseResourceState(value: string): ResourceRecord["state"] {
  if (value !== "active" && value !== "draft" && value !== "retired")
    throw new TypeError(`Invalid Resource state: ${value}`);
  return value;
}

/** Rejects values that violate the exact keys contract. */
function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  /** Defines `actual` for comparison in `assertExactKeys`. */
  const actual = Object.keys(value).sort();
  /** Holds the `sortedExpected` intermediate used by `assertExactKeys`. */
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
  /** Holds the `parent` intermediate used by `assertPageParent`. */
  const parent = objectValue(page.parent, `${label} parent`);
  /** Defines `observed` for comparison in `assertPageParent`. */
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

/** Returns a validated JSON object. */
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new TypeError(`${label} must be an object`);
  return value;
}

/** Returns a required non-empty string or throws. */
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
