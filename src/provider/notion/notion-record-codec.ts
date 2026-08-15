/** Decodes provider-owned Notion rows and managed content into domain records. */
import { sha256 } from "../../core/digest.js";
import { pageAfter } from "../../core/pagination.js";
import { parseSubAgentDefinitionManifest } from "../../core/sub-agent-definition.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../domain/json.js";
import type {
  ResourceRecord,
  ResourceRef,
  SubAgentDefinition,
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

export interface NotionTableIds {
  readonly errors: string;
  readonly resources: string;
  readonly subAgents: string;
  readonly tasks: string;
}

export class NotionRecordReader {
  public constructor(
    private readonly tables: NotionTableIds,
    private readonly transport: NotionTransport,
  ) {}

  public async listSubAgentDefinitions(): Promise<
    readonly SubAgentDefinition[]
  > {
    const pages = await this.queryDataSource(this.tables.subAgents);
    const definitions = await Promise.all(
      pages.map((page) => this.subAgentDefinition(page)),
    );
    if (
      new Set(definitions.map((definition) => definition.id)).size !==
      definitions.length
    )
      throw new Error("Sub-agent definition IDs must be unique");
    return definitions.sort((left, right) => left.id.localeCompare(right.id));
  }

  public async getSubAgentDefinition(id: string): Promise<SubAgentDefinition> {
    const matches = (await this.listSubAgentDefinitions()).filter(
      (definition) => definition.id === id,
    );
    if (matches.length !== 1)
      throw new Error(
        `Sub-agent definition ${id} must resolve to exactly one row`,
      );
    return requiredDefinition(matches[0], id);
  }

  public async getSubAgentPageId(id: string): Promise<string> {
    const pages = await this.queryDataSource(this.tables.subAgents);
    const matches: string[] = [];
    for (const page of pages) {
      if ((await this.subAgentDefinition(page)).id === id)
        matches.push(requiredString(page.id, "Sub-agent page id"));
    }
    if (matches.length !== 1)
      throw new Error(
        `Sub-agent definition ${id} must resolve to exactly one row`,
      );
    return requiredString(matches[0], "Sub-agent page id");
  }

  public async listTaskSummaries(
    query: TaskQuery,
  ): Promise<readonly TaskSummary[]> {
    const pages = await this.queryDataSource(
      this.tables.tasks,
      taskPredicateFilter(query.predicate),
      1_000,
    );
    const summaries = pages.map((page) => this.taskSummary(page));
    for (const key of Object.keys(query.predicate)) {
      if (!TASK_SUMMARY_KEYS.has(key))
        throw new Error(`Unsupported task predicate: ${key}`);
    }
    const matches = summaries.filter((summary) =>
      Object.entries(query.predicate).every(([key, expected]) =>
        Object.is(summary[key as keyof TaskSummary], expected),
      ),
    );
    return pageAfter(matches, query, (summary) => summary.id);
  }

  public async listTaskStatusOptions(): Promise<readonly string[]> {
    const source = await this.transport.request({
      method: "GET",
      path: `/v1/data_sources/${this.tables.tasks}`,
    });
    const status = objectValue(
      objectValue(source.properties, "Task properties").Status,
      "Task Status property",
    );
    if (status.type !== "select")
      throw new TypeError("Task Status must be select");
    const options = objectValue(status.select, "Task Status select").options;
    if (!Array.isArray(options))
      throw new TypeError("Task Status options must be an array");
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

  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    const page = await this.getPageInTable(taskId, this.tables.tasks, "Task");
    const summary = this.taskSummary(page);
    const properties = objectValue(page.properties, "Task properties");
    const dependencies = await this.relationIds(page, "Dependencies");
    return {
      ...summary,
      body: await this.readPageMarkdown(taskId),
      dependencies,
      properties: decodeProperties(properties, [NOTION_TASK_MUTATION_PROPERTY]),
    };
  }

  public async getTaskMutationMarker(taskId: string): Promise<string> {
    const page = await this.getPageInTable(taskId, this.tables.tasks, "Task");
    return propertyText(page, NOTION_TASK_MUTATION_PROPERTY);
  }

  public async getTaskBodyMutationMarker(
    taskId: string,
  ): Promise<string | null> {
    return (
      activeTaskBodyGeneration(await this.readChildBlocks(taskId))?.digest ??
      null
    );
  }

  public async getResources(
    refs: readonly ResourceRef[],
  ): Promise<readonly ResourceRecord[]> {
    const pages = await this.queryDataSource(this.tables.resources);
    const indexed = new Map<string, JsonObject[]>();
    for (const page of pages) {
      const key = propertyText(page, "Resource");
      indexed.set(key, [...(indexed.get(key) ?? []), page]);
    }
    const records: ResourceRecord[] = [];
    for (const ref of refs) {
      const candidates = indexed.get(ref.key) ?? [];
      if (candidates.length !== 1) {
        throw new Error(`Resource ${ref.key} must resolve to exactly one row`);
      }
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

  public async getOptionalResource(
    key: string,
  ): Promise<ResourceRecord | null> {
    const pages = await this.queryDataSource(this.tables.resources, {
      property: "Resource",
      title: { equals: key },
    });
    if (pages.length > 1)
      throw new Error(`Resource ${key} must resolve to at most one row`);
    const page = pages[0];
    return page === undefined ? null : this.resourceRecord(page);
  }

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

  public async readPageMarkdown(pageId: string): Promise<string> {
    const blocks = await this.readChildBlocks(pageId);
    const activeGeneration = activeTaskBodyGeneration(blocks);
    if (activeGeneration !== null) return activeGeneration.body;
    if (blocks.length === 1 && blocks[0]?.type === "code") {
      const code = objectValue(blocks[0].code, "Task body code");
      if (code.language === "markdown")
        return blockText(blocks[0]).replace(/\r\n?/gu, "\n").normalize("NFC");
    }
    const lines: string[] = [];
    for (const block of blocks) {
      lines.push(await this.blockMarkdown(block));
    }
    return normalizeMarkdown(lines.filter((line) => line !== "").join("\n\n"));
  }

  private async subAgentDefinition(
    page: JsonObject,
  ): Promise<SubAgentDefinition> {
    assertPageParent(page, this.tables.subAgents, "Sub-agent");
    if (page.archived === true || page.in_trash === true)
      throw new Error("Sub-agent definition is archived");
    const pageId = requiredString(page.id, "Sub-agent page id");
    const manifest = await this.managedJson(pageId, "Sub-agent definition");
    const definition = parseSubAgentDefinitionManifest(manifest);
    const name = propertyText(page, "Name");
    const enabled = propertyBoolean(page, "Enabled");
    const revision = propertyNumber(page, "Revision");
    const model = propertyText(page, "Model");
    if (
      definition.name !== name ||
      definition.enabled !== enabled ||
      definition.revision !== revision ||
      definition.model !== model
    ) {
      throw new Error(
        `Sub-agent ${definition.id} manifest does not match its authoritative properties`,
      );
    }
    return definition;
  }

  private taskSummary(page: JsonObject): TaskSummary {
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

  private async resourceRecord(page: JsonObject): Promise<ResourceRecord> {
    const id = requiredString(page.id, "Resource page id");
    const body = await this.managedText(id, "Resource body");
    const dependencyValue = propertyText(page, "Dependencies");
    const parsed: unknown =
      dependencyValue === "" ? [] : JSON.parse(dependencyValue);
    const dependencies = parseResourceRefs(toJsonValue(parsed));
    const record: ResourceRecord = {
      body,
      dependencies,
      digest: propertyText(page, "Digest"),
      key: propertyText(page, "Resource"),
      kind: propertyOption(page, "Kind"),
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

  private async managedJson(
    pageId: string,
    heading: string,
  ): Promise<JsonObject> {
    const raw = await this.managedText(pageId, heading);
    return objectValue(toJsonValue(JSON.parse(raw)), `${heading} JSON`);
  }

  private async managedText(pageId: string, heading: string): Promise<string> {
    const blocks = await this.readChildBlocks(pageId);
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
    const index = matches[0]?.index;
    if (index === undefined)
      throw new Error(`Page ${pageId} managed section is missing`);
    const content = blocks[index + 1];
    if (content === undefined || content.type !== "code") {
      throw new Error(
        `## ${heading} must be followed by exactly one code block`,
      );
    }
    const next = blocks[index + 2];
    if (next?.type === "code")
      throw new Error(`## ${heading} must contain exactly one code block`);
    return blockText(content).replace(/\r\n?/gu, "\n").normalize("NFC");
  }

  private async relationIds(
    page: JsonObject,
    propertyName: string,
  ): Promise<readonly string[]> {
    const property = pageProperty(page, propertyName);
    const inline = relationValues(property);
    if (property.has_more !== true) return [...new Set(inline)].sort();
    const pageId = requiredString(page.id, "Page id");
    const propertyId = requiredString(
      property.id,
      `${propertyName} property id`,
    );
    const items = await collectNotionPages((cursor) =>
      this.transport.request({
        method: "GET",
        path: `/v1/pages/${pageId}/properties/${encodeURIComponent(propertyId)}`,
        query: { page_size: 100, start_cursor: cursor },
      }),
    );
    return [...new Set(items.flatMap((item) => relationValues(item)))].sort();
  }

  private async getPageInTable(
    id: string,
    tableId: string,
    label: string,
  ): Promise<JsonObject> {
    const page = await this.transport.request({
      method: "GET",
      path: `/v1/pages/${id}`,
    });
    if (page.object !== "page")
      throw new TypeError(`${id} is not a Notion page`);
    assertPageParent(page, tableId, label);
    return page;
  }

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

  private async blockMarkdown(block: JsonObject): Promise<string> {
    const type = requiredString(block.type, "Block type");
    const text = blockText(block);
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
      const id = requiredString(block.id, "Block id");
      const children = await this.readChildBlocks(id);
      const childText = await Promise.all(
        children.map((child) => this.blockMarkdown(child)),
      );
      rendered += `\n${childText.join("\n")}`;
    }
    return rendered;
  }
}

const TASK_SUMMARY_KEYS = new Set([
  "archived",
  "id",
  "priority",
  "status",
  "title",
  "version",
]);

function taskPredicateFilter(predicate: JsonObject): JsonObject | undefined {
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

function decodeProperties(
  properties: JsonObject,
  excluded: readonly string[] = [],
): JsonObject {
  const excludedNames = new Set(excluded);
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([name]) => !excludedNames.has(name))
      .map(([name, raw]) => {
        const property = objectValue(raw, `Property ${name}`);
        const type = requiredString(property.type, `Property ${name} type`);
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

function propertyText(page: JsonObject, name: string): string {
  const property = pageProperty(page, name);
  const type = requiredString(property.type, `${name} type`);
  if (type !== "title" && type !== "rich_text")
    throw new TypeError(`${name} must be title or rich_text`);
  return richText(property[type]);
}

function propertyOption(page: JsonObject, name: string): string {
  const property = pageProperty(page, name);
  const type = requiredString(property.type, `${name} type`);
  if (type !== "status" && type !== "select")
    throw new TypeError(`${name} must be status or select`);
  const result = optionName(property[type]);
  if (result === null) throw new TypeError(`${name} must have an option`);
  return result;
}

function propertyBoolean(page: JsonObject, name: string): boolean {
  const property = pageProperty(page, name);
  if (property.type !== "checkbox" || typeof property.checkbox !== "boolean")
    throw new TypeError(`${name} must be checkbox`);
  return property.checkbox;
}

function propertyNumber(page: JsonObject, name: string): number {
  const result = propertyNullableNumber(page, name);
  if (result === null) throw new TypeError(`${name} must have a number`);
  return result;
}

function propertyNullableNumber(page: JsonObject, name: string): number | null {
  const property = pageProperty(page, name);
  if (
    property.type !== "number" ||
    (property.number !== null && typeof property.number !== "number")
  ) {
    throw new TypeError(`${name} must be number`);
  }
  return property.number;
}

function pageProperty(page: JsonObject, name: string): JsonObject {
  const properties = objectValue(page.properties, "Page properties");
  const property = properties[name];
  if (property === undefined)
    throw new TypeError(`Page is missing property ${name}`);
  return objectValue(property, `Property ${name}`);
}

function relationValues(property: JsonObject): readonly string[] {
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

function richText(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const object = objectValue(item, "Rich text item");
      if (typeof object.plain_text === "string") return object.plain_text;
      const text = objectValue(object.text, "Rich text value");
      return typeof text.content === "string" ? text.content : "";
    })
    .join("");
}

function blockText(block: JsonObject): string {
  const type = requiredString(block.type, "Block type");
  const value = objectValue(block[type], `Block ${type}`);
  return richText(value.rich_text);
}

function optionName(value: JsonValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(objectValue(value, "Option").name, "Option name");
}

function parseResourceRefs(value: JsonValue): readonly ResourceRef[] {
  if (!Array.isArray(value))
    throw new TypeError("Resource Dependencies must be a JSON array");
  return value.map((item, index) => {
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

function parseResourceState(value: string): ResourceRecord["state"] {
  if (value !== "active" && value !== "draft" && value !== "retired")
    throw new TypeError(`Invalid Resource state: ${value}`);
  return value;
}

function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.join("\0") !== sortedExpected.join("\0"))
    throw new TypeError(`${label} has unexpected or missing fields`);
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trimEnd();
}

function requiredObject(
  value: JsonObject | undefined,
  label: string,
): JsonObject {
  if (value === undefined) throw new TypeError(`${label} is missing`);
  return value;
}

function requiredDefinition(
  value: SubAgentDefinition | undefined,
  id: string,
): SubAgentDefinition {
  if (value === undefined)
    throw new Error(`Sub-agent definition is missing: ${id}`);
  return value;
}

function assertPageParent(
  page: JsonObject,
  tableId: string,
  label: string,
): void {
  const parent = objectValue(page.parent, `${label} parent`);
  const observed = parent.data_source_id;
  if (
    typeof observed !== "string" ||
    compactIdentifier(observed) !== compactIdentifier(tableId)
  )
    throw new Error(`${label} does not belong to its configured table`);
}

function compactIdentifier(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}

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

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
