// Owns deterministic Notion page lookup, managed-content writes, and post-verification.
import { sha256 } from "../../core/digest.js";
import { toJsonValue, type JsonObject, type JsonValue } from "../../domain/json.js";
import type {
  ActivityMutation,
  ConditionalTaskMutation,
  ErrorMutation,
  ResourceMutation,
} from "../../domain/records.js";
import type { TableKind, WriteReceipt } from "../../domain/provider.js";
import { collectNotionPages, type NotionTransport } from "./notion-transport.js";

export interface NotionMutableTableIds {
  readonly errors: string;
  readonly resources: string;
  readonly subAgents: string;
  readonly tasks: string;
}

export interface LocatedPage {
  readonly id: string;
  readonly page: JsonObject;
  readonly version: string;
}

export interface NotionAgentActivity {
  readonly status: string;
  readonly taskIds: readonly string[];
  readonly version: string;
}

export class NotionPageStore {
  public constructor(
    private readonly tables: NotionMutableTableIds,
    private readonly transport: NotionTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async findUniqueByTitle(
    table: TableKind,
    property: string,
    value: string,
  ): Promise<LocatedPage | null> {
    const pages = await this.filteredPages(table, { property, title: { equals: value } });
    if (pages.length > 1) throw new Error(`${table}.${property}=${value} is not unique`);
    const page = pages[0];
    return page === undefined ? null : located(page);
  }

  public async findUniqueByRichText(
    table: TableKind,
    property: string,
    value: string,
  ): Promise<LocatedPage | null> {
    const pages = await this.filteredPages(table, { property, rich_text: { equals: value } });
    if (pages.length > 1) throw new Error(`${table}.${property}=${value} is not unique`);
    const page = pages[0];
    return page === undefined ? null : located(page);
  }

  public async listBySelect(table: TableKind, property: string, value: string): Promise<readonly LocatedPage[]> {
    const pages = await this.filteredPages(table, { property, select: { equals: value } });
    return pages.map((page) => located(page));
  }

  public async createResource(record: ResourceMutation): Promise<WriteReceipt> {
    const existing = await this.findUniqueByTitle("resources", "Resource", record.key);
    if (existing !== null) return this.updateResource(existing, record);
    const created = await this.createManagedPage(
      "resources",
      resourceProperties(record),
      "Resource body",
      record.body,
    );
    return this.receipt("resources", created, record.idempotencyKey);
  }

  public async updateResource(existing: LocatedPage, record: ResourceMutation): Promise<WriteReceipt> {
    await this.transport.request({
      body: { properties: resourceProperties(record) },
      method: "PATCH",
      path: `/v1/pages/${existing.id}`,
    });
    await this.replaceManagedText(existing.id, "Resource body", record.body);
    const verified = await this.getPage(existing.id);
    verifyPropertyText(verified.page, "Resource", record.key);
    verifyPropertyText(verified.page, "Digest", record.digest);
    return this.receipt("resources", verified, record.idempotencyKey);
  }

  public async createOrUpdateError(error: ErrorMutation): Promise<WriteReceipt> {
    const existing = await this.findUniqueByRichText("errors", "Error Key", error.errorKey);
    const properties = errorProperties(error);
    let locatedPage: LocatedPage;
    if (existing === null) {
      locatedPage = await this.createManagedPage(
        "errors",
        properties,
        "Error Description",
        error.description,
        [{ heading: "Error Resolution", text: error.resolution }],
      );
    } else {
      await this.transport.request({
        body: { properties },
        method: "PATCH",
        path: `/v1/pages/${existing.id}`,
      });
      await this.replaceManagedText(existing.id, "Error Description", error.description);
      await this.replaceManagedText(existing.id, "Error Resolution", error.resolution);
      locatedPage = await this.getPage(existing.id);
    }
    verifyPropertyText(locatedPage.page, "Error Key", error.errorKey);
    return this.receipt("errors", locatedPage, error.idempotencyKey);
  }

  public async updateSubAgentActivity(change: ActivityMutation): Promise<WriteReceipt> {
    const current = await this.getPage(change.subAgentId);
    const currentTaskIds = await this.relationIds(current.page, "Working On");
    if (!sameSet(currentTaskIds, change.expectedTaskIds)) throw new Error("Sub-agent Working On conflict");
    const currentStatus = propertyOption(current.page, "Status");
    const expectedStatus = activityStatus(change.expectedRunLeaseIds);
    if (currentStatus !== expectedStatus) {
      throw new Error("Sub-agent Status conflict");
    }
    return this.setSubAgentActivity(
      change.subAgentId,
      expectedStatus,
      change.expectedTaskIds,
      activityStatus(change.nextRunLeaseIds),
      change.nextTaskIds,
      change.idempotencyKey,
    );
  }

  public async getSubAgentActivity(subAgentId: string): Promise<NotionAgentActivity> {
    const current = await this.getPage(subAgentId);
    return {
      status: propertyOption(current.page, "Status") ?? "",
      taskIds: normalizedSet(await this.relationIds(current.page, "Working On")),
      version: current.version,
    };
  }

  public async setSubAgentActivity(
    subAgentId: string,
    expectedStatus: string,
    expectedTaskIds: readonly string[],
    nextStatus: "Offline" | "Online",
    nextTaskIds: readonly string[],
    idempotencyKey: string,
  ): Promise<WriteReceipt> {
    const current = await this.getPage(subAgentId);
    if (propertyOption(current.page, "Status") !== expectedStatus || !sameSet(await this.relationIds(current.page, "Working On"), expectedTaskIds)) {
      throw new Error("Sub-agent activity changed before reconciliation");
    }
    await this.transport.request({
      body: {
        properties: {
          Status: { select: { name: nextStatus } },
          "Working On": { relation: normalizedSet(nextTaskIds).map((id) => ({ id })) },
        },
      },
      method: "PATCH",
      path: `/v1/pages/${subAgentId}`,
    });
    const verified = await this.getPage(subAgentId);
    const status = propertyOption(verified.page, "Status");
    if (status !== nextStatus) {
      throw new Error("Sub-agent Status post-verification failed");
    }
    if (!sameSet(await this.relationIds(verified.page, "Working On"), nextTaskIds)) {
      throw new Error("Sub-agent Working On post-verification failed");
    }
    return this.receipt("subAgents", verified, idempotencyKey);
  }

  public async applyTaskMutation(mutation: ConditionalTaskMutation): Promise<WriteReceipt> {
    const current = await this.getPage(mutation.taskId);
    if (current.version !== mutation.expectedVersion) throw new Error("Task version conflict");
    await this.transport.request({
      body: { properties: encodeGenericProperties(mutation.nextProperties, current.page) },
      method: "PATCH",
      path: `/v1/pages/${mutation.taskId}`,
    });
    if (mutation.nextBody !== null) {
      await this.replaceAllContent(mutation.taskId, mutation.nextBody);
      if ((await this.readManagedTaskBody(mutation.taskId)) !== normalizeText(mutation.nextBody)) {
        throw new Error("Task body post-verification failed");
      }
    }
    const verified = await this.getPage(mutation.taskId);
    if (verified.version === current.version) throw new Error("Task write did not advance last_edited_time");
    for (const [name, expected] of Object.entries(mutation.nextProperties)) {
      if (!propertyMatches(verified.page, name, expected)) {
        throw new Error(`Task property ${name} post-verification failed`);
      }
    }
    return this.receipt("tasks", verified, mutation.idempotencyKey);
  }

  public async getPage(pageId: string): Promise<LocatedPage> {
    const page = await this.transport.request({ method: "GET", path: `/v1/pages/${pageId}` });
    if (page.object !== "page") throw new TypeError(`${pageId} is not a Notion page`);
    return located(page);
  }

  public async managedText(pageId: string, heading: string): Promise<string> {
    const section = await this.findManagedSection(pageId, heading);
    return blockText(section.content);
  }

  private async createManagedPage(
    table: TableKind,
    properties: JsonObject,
    heading: string,
    text: string,
    additional: readonly { readonly heading: string; readonly text: string }[] = [],
  ): Promise<LocatedPage> {
    const children = [managedHeading(heading), managedCode(text)];
    for (const section of additional) children.push(managedHeading(section.heading), managedCode(section.text));
    const response = await this.transport.request({
      body: { children, parent: { data_source_id: this.tables[table] }, properties },
      method: "POST",
      path: "/v1/pages",
    });
    const id = requiredString(response.id, "Created page id");
    const verified = await this.getPage(id);
    if ((await this.managedText(id, heading)) !== normalizeText(text)) {
      throw new Error(`Created ## ${heading} content did not verify`);
    }
    return verified;
  }

  private async replaceManagedText(pageId: string, heading: string, text: string): Promise<void> {
    const section = await this.findManagedSection(pageId, heading);
    const type = requiredString(section.content.type, "Managed content block type");
    if (type !== "code") throw new Error(`Managed ## ${heading} content is not a code block`);
    await this.transport.request({
      body: { code: codeValue(text) },
      method: "PATCH",
      path: `/v1/blocks/${requiredString(section.content.id, "Managed content block id")}`,
    });
    if ((await this.managedText(pageId, heading)) !== normalizeText(text)) {
      throw new Error(`Updated ## ${heading} content did not verify`);
    }
  }

  private async replaceAllContent(pageId: string, text: string): Promise<void> {
    const blocks = await this.childBlocks(pageId);
    for (const block of blocks) {
      await this.transport.request({
        body: { in_trash: true },
        method: "PATCH",
        path: `/v1/blocks/${requiredString(block.id, "Block id")}`,
      });
    }
    await this.transport.request({
      body: { children: [managedCode(text, "markdown")] },
      method: "PATCH",
      path: `/v1/blocks/${pageId}/children`,
    });
  }

  private async readManagedTaskBody(pageId: string): Promise<string | null> {
    const blocks = await this.childBlocks(pageId);
    if (blocks.length !== 1 || blocks[0]?.type !== "code") return null;
    const code = objectValue(blocks[0].code, "Task body code");
    return code.language === "markdown" ? blockText(blocks[0]) : null;
  }

  private async relationIds(page: JsonObject, propertyName: string): Promise<readonly string[]> {
    const property = pageProperty(page, propertyName);
    if (property.has_more !== true) return normalizedSet(relationIds(property));
    const pageId = requiredString(page.id, "Page id");
    const propertyId = requiredString(property.id, `${propertyName} property id`);
    const items = await collectNotionPages((cursor) => this.transport.request({
      method: "GET",
      path: `/v1/pages/${pageId}/properties/${encodeURIComponent(propertyId)}`,
      query: { page_size: 100, start_cursor: cursor },
    }));
    return normalizedSet(items.flatMap((item) => relationIds(item)));
  }

  private async findManagedSection(pageId: string, heading: string): Promise<{ readonly content: JsonObject }> {
    const blocks = await this.childBlocks(pageId);
    const matches = blocks.map((block, index) => ({ block, index })).filter(({ block }) => block.type === "heading_2" && blockText(block) === heading);
    if (matches.length !== 1) throw new Error(`Page ${pageId} must contain exactly one ## ${heading}`);
    const match = matches[0];
    if (match === undefined) throw new Error(`Page ${pageId} managed heading is missing`);
    const content = blocks[match.index + 1];
    if (content === undefined || content.type !== "code") throw new Error(`## ${heading} must be followed by a code block`);
    return { content };
  }

  private async filteredPages(table: TableKind, filter: JsonObject): Promise<readonly JsonObject[]> {
    return collectNotionPages((cursor) => this.transport.request({
      body: { filter, page_size: 100, ...(cursor === null ? {} : { start_cursor: cursor }) },
      method: "POST",
      path: `/v1/data_sources/${this.tables[table]}/query`,
    }));
  }

  private async childBlocks(pageId: string): Promise<readonly JsonObject[]> {
    return collectNotionPages((cursor) =>
      this.transport.request({
        method: "GET",
        path: `/v1/blocks/${pageId}/children`,
        query: { page_size: 100, start_cursor: cursor },
      }),
    );
  }

  private receipt(table: TableKind, page: LocatedPage, idempotencyKey: string): WriteReceipt {
    return {
      idempotencyKey,
      observedVersion: page.version,
      providerRecord: { id: page.id, table },
      writtenAt: this.now().toISOString(),
    };
  }
}

function resourceProperties(record: ResourceMutation): JsonObject {
  return {
    Dependencies: richTextProperty(JSON.stringify(record.dependencies)),
    Digest: richTextProperty(record.digest),
    Kind: selectProperty(record.kind),
    Resource: titleProperty(record.key),
    State: selectProperty(record.state),
    Version: richTextProperty(record.version),
  };
}

function errorProperties(error: ErrorMutation): JsonObject {
  return {
    Error: titleProperty(error.title),
    "Error Key": richTextProperty(error.errorKey),
    "Run ID": richTextProperty(error.relatedRunId ?? ""),
    Severity: selectProperty(error.severity),
    "Sub-agent": relationProperty(error.relatedSubAgentId === null ? [] : [error.relatedSubAgentId]),
    Task: relationProperty(error.relatedTaskId === null ? [] : [error.relatedTaskId]),
  };
}

function encodeGenericProperties(properties: JsonObject, page: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(properties).map(([name, value]) => {
    const current = pageProperty(page, name);
    return [name, encodeProperty(value, requiredString(current.type, `${name} type`))];
  }));
}

function encodeProperty(value: JsonValue, type: string): JsonObject {
  if (type === "checkbox" && typeof value === "boolean") return { checkbox: value };
  if (type === "number" && (typeof value === "number" || value === null)) return { number: value };
  if (type === "title" && typeof value === "string") return titleProperty(value);
  if (type === "rich_text" && typeof value === "string") return richTextProperty(value);
  if ((type === "select" || type === "status") && (typeof value === "string" || value === null)) {
    return { [type]: value === null ? null : { name: value } };
  }
  if (type === "url" && (typeof value === "string" || value === null)) return { url: value };
  if (type === "relation" && Array.isArray(value) && value.every((item) => typeof item === "string")) return relationProperty(value as string[]);
  if (type === "date" && (value === null || (typeof value === "object" && !Array.isArray(value)))) return { date: value };
  throw new TypeError(`Task mutation value is invalid for Notion property type ${type}`);
}

function propertyMatches(page: JsonObject, name: string, expected: JsonValue): boolean {
  const property = pageProperty(page, name);
  const type = property.type;
  if (type === "checkbox") return property.checkbox === expected;
  if (type === "number") return property.number === expected;
  if (type === "rich_text" || type === "title") return propertyText(page, name) === expected;
  if (type === "select" || type === "status") return propertyOption(page, name) === expected;
  if (type === "relation" && Array.isArray(expected)) return sameSet(relationIds(property), expected.filter((item): item is string => typeof item === "string"));
  return false;
}

function located(page: JsonObject): LocatedPage {
  const id = requiredString(page.id, "Page id");
  return { id, page, version: requiredString(page.last_edited_time, `Page ${id} last_edited_time`) };
}

function titleProperty(text: string): JsonObject { return { title: richText(text) }; }
function richTextProperty(text: string): JsonObject { return { rich_text: richText(text) }; }
function selectProperty(name: string): JsonObject { return { select: { name } }; }
function relationProperty(ids: readonly string[]): JsonObject { return { relation: normalizedSet(ids).map((id) => ({ id })) }; }

function managedHeading(text: string): JsonObject {
  return { heading_2: { rich_text: richText(text) }, object: "block", type: "heading_2" };
}

function managedCode(text: string, language = "json"): JsonObject {
  return { code: codeValue(text, language), object: "block", type: "code" };
}

function codeValue(text: string, language = "json"): JsonObject {
  return { language, rich_text: richText(normalizeText(text)) };
}

function richText(text: string): JsonValue[] {
  const normalized = normalizeText(text);
  if (normalized === "") return [];
  const chunks: JsonValue[] = [];
  for (let index = 0; index < normalized.length; index += 2000) {
    chunks.push({ text: { content: normalized.slice(index, index + 2000) }, type: "text" });
  }
  return chunks;
}

function blockText(block: JsonObject): string {
  const type = requiredString(block.type, "Block type");
  return richTextValue(objectValue(block[type], `Block ${type}`).rich_text);
}

function propertyText(page: JsonObject, name: string): string {
  const property = pageProperty(page, name);
  const type = requiredString(property.type, `${name} type`);
  return richTextValue(property[type]);
}

function propertyOption(page: JsonObject, name: string): string | null {
  const property = pageProperty(page, name);
  const type = requiredString(property.type, `${name} type`);
  const value = property[type];
  if (value === null || value === undefined) return null;
  return requiredString(objectValue(value, `${name} option`).name, `${name} option name`);
}

function richTextValue(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const object = objectValue(item, "Rich text item");
    if (typeof object.plain_text === "string") return object.plain_text;
    return requiredString(objectValue(object.text, "Rich text value").content, "Rich text content");
  }).join("").normalize("NFC");
}

function relationIds(property: JsonObject): readonly string[] {
  if (Array.isArray(property.relation)) {
    return property.relation.map((item) => requiredString(objectValue(item, "Relation item").id, "Relation id"));
  }
  if (property.relation !== null && property.relation !== undefined && typeof property.relation === "object") {
    return [requiredString(objectValue(property.relation, "Relation item").id, "Relation id")];
  }
  return [];
}

function pageProperty(page: JsonObject, name: string): JsonObject {
  const properties = objectValue(page.properties, "Page properties");
  return objectValue(properties[name], `Property ${name}`);
}

function verifyPropertyText(page: JsonObject, name: string, expected: string): void {
  if (propertyText(page, name) !== expected) throw new Error(`${name} post-verification failed`);
}

function normalizedSet(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(); }
function sameSet(left: readonly string[], right: readonly string[]): boolean { return normalizedSet(left).join("\0") === normalizedSet(right).join("\0"); }
function activityStatus(runLeaseIds: readonly string[]): "Offline" | "Online" {
  return runLeaseIds.length === 0 ? "Offline" : "Online";
}
function normalizeText(text: string): string { return text.replace(/\r\n?/gu, "\n").normalize("NFC"); }

function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  const checked = toJsonValue(value);
  if (checked === null || typeof checked !== "object" || Array.isArray(checked)) throw new TypeError(`${label} must be an object`);
  return checked;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

export function resourceMutationDigest(record: Omit<ResourceMutation, "idempotencyKey">): string {
  return sha256(JSON.stringify(toJsonValue(record)));
}
