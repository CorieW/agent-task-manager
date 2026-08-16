/** Owns deterministic Notion page lookup, managed-content writes, and post-verification. */
import { digestJson, sha256 } from "../../core/digest.js";
import { taskPropertiesWithStatus } from "../../core/task-properties.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../domain/json.js";
import type {
  ActivityMutation,
  ConditionalTaskMutation,
  ErrorMutation,
  ResourceMutation,
} from "../../domain/records.js";
import type { TableKind, WriteReceipt } from "../../domain/provider.js";
import {
  NOTION_TASK_MUTATION_CAPTION_PREFIX,
  NOTION_TASK_MUTATION_PROPERTY,
} from "./notion-schema.js";
import { activeTaskBodyGeneration } from "./notion-task-body-generation.js";
import {
  canonicalPromptMarkdown,
  promptBodyFromMarkdownResponse,
  promptPageMarkdown,
} from "./notion-prompt-markdown.js";
import {
  collectNotionPages,
  type NotionTransport,
} from "./notion-transport.js";

/** Defines Notion mutable table IDs. */
export interface NotionMutableTableIds {
  /** Contains errors for Notion mutable table IDs. */
  readonly errors: string;
  /** Contains resources for Notion mutable table IDs. */
  readonly resources: string;
  /** Contains Agents for Notion mutable table IDs. */
  readonly agents: string;
  /** Contains tasks for Notion mutable table IDs. */
  readonly tasks: string;
}

/** Defines located page. */
export interface LocatedPage {
  /** Identifies located page. */
  readonly id: string;
  /** Contains page for located page. */
  readonly page: JsonObject;
  /** Carries the opaque located page version used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Defines Notion agent activity. */
export interface NotionAgentActivity {
  /** Records the status for Notion agent activity. */
  readonly status: string;
  /** Lists task IDs for Notion agent activity. */
  readonly taskIds: readonly string[];
  /** Carries the opaque Notion agent activity version used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Implements Notion page store. */
export class NotionPageStore {
  /** Initializes Notion page store. */
  public constructor(
    /** Contains tables for Notion page store. */ private readonly tables: NotionMutableTableIds,
    /** Contains transport for Notion page store. */ private readonly transport: NotionTransport,
    /** Contains now for Notion page store. */ private readonly now: () => Date = () =>
      new Date(),
  ) {}

  /** Finds unique by title. */
  public async findUniqueByTitle(
    table: TableKind,
    property: string,
    value: string,
  ): Promise<LocatedPage | null> {
    /** Holds the `pages` intermediate used by `findUniqueByTitle`. */
    const pages = await this.filteredPages(table, {
      property,
      title: { equals: value },
    });
    if (pages.length > 1)
      throw new Error(`${table}.${property}=${value} is not unique`);
    /** Holds the `page` intermediate used by `findUniqueByTitle`. */
    const page = pages[0];
    return page === undefined ? null : located(page);
  }

  /** Finds unique by rich text. */
  public async findUniqueByRichText(
    table: TableKind,
    property: string,
    value: string,
  ): Promise<LocatedPage | null> {
    /** Holds the `pages` intermediate used by `findUniqueByRichText`. */
    const pages = await this.filteredPages(table, {
      property,
      rich_text: { equals: value },
    });
    if (pages.length > 1)
      throw new Error(`${table}.${property}=${value} is not unique`);
    /** Holds the `page` intermediate used by `findUniqueByRichText`. */
    const page = pages[0];
    return page === undefined ? null : located(page);
  }

  /** Lists by select. */
  public async listBySelect(
    table: TableKind,
    property: string,
    value: string,
  ): Promise<readonly LocatedPage[]> {
    /** Holds the `pages` intermediate used by `listBySelect`. */
    const pages = await this.filteredPages(table, {
      property,
      select: { equals: value },
    });
    return pages.map((page) => located(page));
  }

  /** Creates resource. */
  public async createResource(record: ResourceMutation): Promise<WriteReceipt> {
    /** Holds the `existing` intermediate used by `createResource`. */
    const existing = await this.findUniqueByTitle(
      "resources",
      "Resource",
      record.key,
    );
    if (existing !== null) return this.updateResource(existing, record);
    /** Holds the `created` intermediate used by `createResource`. */
    const created =
      record.kind === "prompt"
        ? await this.createPromptResourcePage(record)
        : await this.createManagedPage(
            "resources",
            resourceProperties(record),
            "Resource body",
            record.body,
          );
    return this.receipt("resources", created, record.idempotencyKey);
  }

  /** Updates resource. */
  public async updateResource(
    existing: LocatedPage,
    record: ResourceMutation,
  ): Promise<WriteReceipt> {
    await this.transport.request({
      body: { properties: resourceProperties(record) },
      method: "PATCH",
      path: `/v1/pages/${existing.id}`,
    });
    if (record.kind === "prompt") {
      await this.replaceManagedPromptMarkdown(existing.id, record.body);
    } else {
      await this.replaceManagedText(existing.id, "Resource body", record.body);
    }
    /** Holds the `verified` intermediate used by `updateResource`. */
    const verified = await this.getPage(existing.id);
    verifyPropertyText(verified.page, "Resource", record.key);
    verifyPropertyText(verified.page, "Digest", record.digest);
    return this.receipt("resources", verified, record.idempotencyKey);
  }

  /** Creates or updates the Error identified by Error Key. */
  public async createOrUpdateError(
    error: ErrorMutation,
  ): Promise<WriteReceipt> {
    /** Holds the `existing` intermediate used by `createOrUpdateError`. */
    const existing = await this.findUniqueByRichText(
      "errors",
      "Error Key",
      error.errorKey,
    );
    /** Holds the `properties` intermediate used by `createOrUpdateError`. */
    const properties = errorProperties(error);
    /** Holds the `locatedPage` intermediate used by `createOrUpdateError`. */
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
      await this.replaceManagedText(
        existing.id,
        "Error Description",
        error.description,
      );
      await this.replaceManagedText(
        existing.id,
        "Error Resolution",
        error.resolution,
      );
      locatedPage = await this.getPage(existing.id);
    }
    verifyPropertyText(locatedPage.page, "Error Key", error.errorKey);
    return this.receipt("errors", locatedPage, error.idempotencyKey);
  }

  /** Returns a receipt only when the existing Error exactly matches the intended target. */
  public async errorTargetReceipt(
    error: ErrorMutation,
  ): Promise<WriteReceipt | null> {
    /** Holds the `existing` intermediate used by `errorTargetReceipt`. */
    const existing = await this.findUniqueByRichText(
      "errors",
      "Error Key",
      error.errorKey,
    );
    if (existing === null) return null;
    /** Holds the `current` intermediate used by `errorTargetReceipt`. */
    const current = await this.getPage(existing.id);
    /** Holds the `exact` intermediate used by `errorTargetReceipt`. */
    const exact =
      propertyText(current.page, "Error") === error.title &&
      propertyText(current.page, "Error Key") === error.errorKey &&
      propertyOption(current.page, "Severity") === error.severity &&
      propertyOption(current.page, "Status") === error.status &&
      propertyText(current.page, "Run ID") === (error.relatedRunId ?? "") &&
      sameSet(
        await this.relationIds(current.page, "Agent"),
        error.relatedAgentId === null ? [] : [error.relatedAgentId],
      ) &&
      sameSet(
        await this.relationIds(current.page, "Task"),
        error.relatedTaskId === null ? [] : [error.relatedTaskId],
      ) &&
      (await this.managedText(current.id, "Error Description")) ===
        normalizeText(error.description) &&
      (await this.managedText(current.id, "Error Resolution")) ===
        normalizeText(error.resolution);
    if (!exact)
      throw new Error(
        `Pending Error intent conflicts with newer state: ${error.errorKey}`,
      );
    return this.receipt("errors", current, error.idempotencyKey);
  }

  /** Updates Agent activity. */
  public async updateAgentActivity(
    change: ActivityMutation,
  ): Promise<WriteReceipt> {
    /** Holds the `current` intermediate used by `updateAgentActivity`. */
    const current = await this.getPage(change.agentId);
    /** Holds the `currentTaskIds` intermediate used by `updateAgentActivity`. */
    const currentTaskIds = await this.relationIds(current.page, "Working On");
    if (!sameSet(currentTaskIds, change.expectedTaskIds))
      throw new Error("Agent Working On conflict");
    /** Holds the `currentStatus` intermediate used by `updateAgentActivity`. */
    const currentStatus = propertyOption(current.page, "Status");
    /** Defines `expectedStatus` for comparison in `updateAgentActivity`. */
    const expectedStatus = activityStatus(change.expectedRunLeaseIds);
    if (currentStatus !== expectedStatus) {
      throw new Error("Agent Status conflict");
    }
    return this.setAgentActivity(
      change.agentId,
      expectedStatus,
      change.expectedTaskIds,
      activityStatus(change.nextRunLeaseIds),
      change.nextTaskIds,
      change.idempotencyKey,
    );
  }

  /** Returns Agent activity. */
  public async getAgentActivity(agentId: string): Promise<NotionAgentActivity> {
    /** Holds the `current` intermediate used by `getAgentActivity`. */
    const current = await this.getPage(agentId);
    return {
      status: propertyOption(current.page, "Status") ?? "",
      taskIds: normalizedSet(
        await this.relationIds(current.page, "Working On"),
      ),
      version: current.version,
    };
  }

  /** Sets Agent activity. */
  public async setAgentActivity(
    agentId: string,
    expectedStatus: string,
    expectedTaskIds: readonly string[],
    nextStatus: "Offline" | "Online",
    nextTaskIds: readonly string[],
    idempotencyKey: string,
  ): Promise<WriteReceipt> {
    /** Holds the `current` intermediate used by `setAgentActivity`. */
    const current = await this.getPage(agentId);
    if (
      propertyOption(current.page, "Status") !== expectedStatus ||
      !sameSet(
        await this.relationIds(current.page, "Working On"),
        expectedTaskIds,
      )
    ) {
      throw new Error("Agent activity changed before reconciliation");
    }
    await this.transport.request({
      body: {
        properties: {
          Status: { select: { name: nextStatus } },
          "Working On": {
            relation: normalizedSet(nextTaskIds).map((id) => ({ id })),
          },
        },
      },
      method: "PATCH",
      path: `/v1/pages/${agentId}`,
    });
    /** Holds the `verified` intermediate used by `setAgentActivity`. */
    const verified = await this.getPage(agentId);
    /** Holds the `status` intermediate used by `setAgentActivity`. */
    const status = propertyOption(verified.page, "Status");
    if (status !== nextStatus) {
      throw new Error("Agent Status post-verification failed");
    }
    if (
      !sameSet(await this.relationIds(verified.page, "Working On"), nextTaskIds)
    ) {
      throw new Error("Agent Working On post-verification failed");
    }
    return this.receipt("agents", verified, idempotencyKey);
  }

  /** Applies task mutation. */
  public async applyTaskMutation(
    mutation: ConditionalTaskMutation,
  ): Promise<WriteReceipt> {
    /** Holds the `current` intermediate used by `applyTaskMutation`. */
    const current = await this.getPage(mutation.taskId);
    assertPageParent(current.page, this.tables.tasks, "Task");
    if (current.version !== mutation.expectedVersion)
      throw new Error("Task version conflict");
    /** Holds the `currentStatus` intermediate used by `applyTaskMutation`. */
    const currentStatus = propertyOption(current.page, "Status");
    if (currentStatus === null) throw new Error("Task Status is missing");
    /** Holds the `mutationDigest` intermediate used by `applyTaskMutation`. */
    const mutationDigest = digestJson(toJsonValue(mutation));
    /** Holds the `targetProperties` intermediate used by `applyTaskMutation`. */
    const targetProperties = {
      ...taskPropertiesWithStatus(
        mutation.nextProperties,
        mutation.nextStatus ?? currentStatus,
      ),
      [NOTION_TASK_MUTATION_PROPERTY]: mutationDigest,
    };
    /** Holds the `nextProperties` intermediate used by `applyTaskMutation`. */
    const nextProperties = encodeGenericProperties(
      targetProperties,
      current.page,
    );
    if (mutation.nextBody !== null) {
      await this.appendTaskBodyGeneration(
        mutation.taskId,
        mutation.nextBody,
        mutationDigest,
      );
      if (
        (await this.readManagedTaskBody(mutation.taskId)) !==
        normalizeText(mutation.nextBody)
      )
        throw new Error("Task body post-verification failed");
    }
    await this.transport.request({
      body: { properties: nextProperties },
      method: "PATCH",
      path: `/v1/pages/${mutation.taskId}`,
    });
    /** Holds the `verified` intermediate used by `applyTaskMutation`. */
    const verified = await this.getPage(mutation.taskId);
    if (verified.version === current.version)
      throw new Error("Task write did not advance last_edited_time");
    for (const [name, expected] of Object.entries(targetProperties)) {
      if (!propertyMatches(verified.page, name, expected)) {
        throw new Error(`Task property ${name} post-verification failed`);
      }
    }
    if (
      mutation.nextStatus !== null &&
      propertyOption(verified.page, "Status") !== mutation.nextStatus
    )
      throw new Error("Task Status post-verification failed");
    return this.receipt("tasks", verified, mutation.idempotencyKey);
  }

  /** Creates a receipt from the current verified Task page. */
  public async taskReceipt(
    taskId: string,
    idempotencyKey: string,
  ): Promise<WriteReceipt> {
    /** Holds the `current` intermediate used by `taskReceipt`. */
    const current = await this.getPage(taskId);
    assertPageParent(current.page, this.tables.tasks, "Task");
    return this.receipt("tasks", current, idempotencyKey);
  }

  /** Completes marked task properties. */
  public async completeMarkedTaskProperties(
    mutation: ConditionalTaskMutation,
  ): Promise<WriteReceipt> {
    /** Holds the `current` intermediate used by `completeMarkedTaskProperties`. */
    const current = await this.getPage(mutation.taskId);
    assertPageParent(current.page, this.tables.tasks, "Task");
    /** Holds the `mutationDigest` intermediate used by `completeMarkedTaskProperties`. */
    const mutationDigest = digestJson(toJsonValue(mutation));
    if (
      (await this.taskBodyGenerationMarker(mutation.taskId)) !==
        mutationDigest ||
      mutation.nextBody === null ||
      (await this.readManagedTaskBody(mutation.taskId)) !==
        normalizeText(mutation.nextBody)
    )
      throw new Error(
        "Task body generation does not authorize property completion",
      );
    for (const [name, expected] of Object.entries(mutation.nextProperties)) {
      if (name === NOTION_TASK_MUTATION_PROPERTY) continue;
      if (!propertyMatches(current.page, name, expected))
        throw new Error(`Task source property ${name} changed before recovery`);
    }
    /** Holds the `sourceStatus` intermediate used by `completeMarkedTaskProperties`. */
    const sourceStatus = propertyOption(current.page, "Status");
    if (sourceStatus === null) throw new Error("Task Status is missing");
    /** Holds the `targetProperties` intermediate used by `completeMarkedTaskProperties`. */
    const targetProperties = {
      ...taskPropertiesWithStatus(
        mutation.nextProperties,
        mutation.nextStatus ?? sourceStatus,
      ),
      [NOTION_TASK_MUTATION_PROPERTY]: mutationDigest,
    };
    await this.transport.request({
      body: {
        properties: encodeGenericProperties(targetProperties, current.page),
      },
      method: "PATCH",
      path: `/v1/pages/${mutation.taskId}`,
    });
    /** Holds the `verified` intermediate used by `completeMarkedTaskProperties`. */
    const verified = await this.getPage(mutation.taskId);
    for (const [name, expected] of Object.entries(targetProperties))
      if (!propertyMatches(verified.page, name, expected))
        throw new Error(`Task property ${name} post-verification failed`);
    return this.receipt("tasks", verified, mutation.idempotencyKey);
  }

  /** Returns page. */
  public async getPage(pageId: string): Promise<LocatedPage> {
    /** Holds the `page` intermediate used by `getPage`. */
    const page = await this.transport.request({
      method: "GET",
      path: `/v1/pages/${pageId}`,
    });
    if (page.object !== "page")
      throw new TypeError(`${pageId} is not a Notion page`);
    return located(page);
  }

  /** Reads the body of a named managed child-block section. */
  public async managedText(pageId: string, heading: string): Promise<string> {
    /** Holds the `section` intermediate used by `managedText`. */
    const section = await this.findManagedSection(pageId, heading);
    return blockText(section.content);
  }

  /** Creates a prompt Resource through Notion's native Markdown surface. */
  private async createPromptResourcePage(
    record: ResourceMutation,
  ): Promise<LocatedPage> {
    /** Rejects a non-canonical or unsafe body before the external mutation. */
    const canonicalBody = canonicalPromptMarkdown(record.body);
    /** Creates properties and canonical Markdown in one provider request. */
    const response = await this.transport.request({
      body: {
        markdown: promptPageMarkdown(canonicalBody),
        parent: { data_source_id: this.tables.resources },
        properties: resourceProperties(record),
      },
      method: "POST",
      path: "/v1/pages",
    });
    /** Identifies the newly created prompt Resource page. */
    const id = requiredString(response.id, "Created prompt Resource page id");
    if ((await this.readPromptMarkdown(id)) !== canonicalBody) {
      throw new Error("Created prompt Resource Markdown did not verify");
    }
    return this.getPage(id);
  }

  /** Replaces a prompt Resource through Notion's native Markdown surface. */
  private async replaceManagedPromptMarkdown(
    pageId: string,
    text: string,
  ): Promise<void> {
    /** Rejects a non-canonical or unsafe body before the external mutation. */
    const canonicalBody = canonicalPromptMarkdown(text);
    /** Replaces the complete manager-owned prompt page body. */
    const response = await this.transport.request({
      body: {
        replace_content: { new_str: promptPageMarkdown(canonicalBody) },
        type: "replace_content",
      },
      method: "PATCH",
      path: `/v1/pages/${pageId}/markdown`,
    });
    if (promptBodyFromMarkdownResponse(response) !== canonicalBody) {
      throw new Error(
        "Updated prompt Resource Markdown response did not verify",
      );
    }
    if ((await this.readPromptMarkdown(pageId)) !== canonicalBody) {
      throw new Error("Updated prompt Resource Markdown did not verify");
    }
  }

  /** Reads and validates the complete native Markdown projection of a prompt. */
  private async readPromptMarkdown(pageId: string): Promise<string> {
    /** Retrieves canonical Markdown plus truncation and unknown-block evidence. */
    const response = await this.transport.request({
      method: "GET",
      path: `/v1/pages/${pageId}/markdown`,
    });
    return promptBodyFromMarkdownResponse(response);
  }

  /** Creates managed page. */
  private async createManagedPage(
    table: TableKind,
    properties: JsonObject,
    heading: string,
    text: string,
    additional: readonly {
      /** Contains heading for create managed page. */
      readonly heading: string;
      /** Contains text for create managed page. */
      readonly text: string;
    }[] = [],
  ): Promise<LocatedPage> {
    /** Holds the `children` intermediate used by `createManagedPage`. */
    const children = [managedHeading(heading), managedCode(text)];
    for (const section of additional)
      children.push(managedHeading(section.heading), managedCode(section.text));
    /** Captures `response` returned by `createManagedPage`. */
    const response = await this.transport.request({
      body: {
        children,
        parent: { data_source_id: this.tables[table] },
        properties,
      },
      method: "POST",
      path: "/v1/pages",
    });
    /** Holds the `id` intermediate used by `createManagedPage`. */
    const id = requiredString(response.id, "Created page id");
    /** Holds the `verified` intermediate used by `createManagedPage`. */
    const verified = await this.getPage(id);
    if ((await this.managedText(id, heading)) !== normalizeText(text)) {
      throw new Error(`Created ## ${heading} content did not verify`);
    }
    return verified;
  }

  /** Replaces managed text. */
  private async replaceManagedText(
    pageId: string,
    heading: string,
    text: string,
  ): Promise<void> {
    /** Holds the `section` intermediate used by `replaceManagedText`. */
    const section = await this.findManagedSection(pageId, heading);
    /** Holds the `type` intermediate used by `replaceManagedText`. */
    const type = requiredString(
      section.content.type,
      "Managed content block type",
    );
    if (type !== "code")
      throw new Error(`Managed ## ${heading} content is not a code block`);
    await this.transport.request({
      body: { code: codeValue(text) },
      method: "PATCH",
      path: `/v1/blocks/${requiredString(section.content.id, "Managed content block id")}`,
    });
    if ((await this.managedText(pageId, heading)) !== normalizeText(text)) {
      throw new Error(`Updated ## ${heading} content did not verify`);
    }
  }

  /** Appends task body generation. */
  private async appendTaskBodyGeneration(
    pageId: string,
    text: string,
    mutationDigest: string,
  ): Promise<void> {
    await this.transport.request({
      body: {
        children: [
          managedCode(
            text,
            "markdown",
            `${NOTION_TASK_MUTATION_CAPTION_PREFIX}${mutationDigest}`,
          ),
        ],
      },
      method: "PATCH",
      path: `/v1/blocks/${pageId}/children`,
    });
  }

  /** Reads managed task body. */
  private async readManagedTaskBody(pageId: string): Promise<string | null> {
    /** Holds the `blocks` intermediate used by `readManagedTaskBody`. */
    const blocks = await this.childBlocks(pageId);
    /** Holds the `generated` intermediate used by `readManagedTaskBody`. */
    const generated = activeTaskBodyGeneration(blocks);
    if (generated !== null) return generated.body;
    /** Holds the `active` intermediate used by `readManagedTaskBody`. */
    const active = blocks.length === 1 ? blocks[0] : undefined;
    if (active?.type !== "code") return null;
    /** Holds the `code` intermediate used by `readManagedTaskBody`. */
    const code = objectValue(active.code, "Task body code");
    return code.language === "markdown" ? blockText(active) : null;
  }

  /** Builds body generation marker. */
  private async taskBodyGenerationMarker(
    pageId: string,
  ): Promise<string | null> {
    return (
      activeTaskBodyGeneration(await this.childBlocks(pageId))?.digest ?? null
    );
  }

  /** Reads IDs. */
  private async relationIds(
    page: JsonObject,
    propertyName: string,
  ): Promise<readonly string[]> {
    /** Holds the `property` intermediate used by `relationIds`. */
    const property = pageProperty(page, propertyName);
    if (property.has_more !== true) return normalizedSet(relationIds(property));
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
    return normalizedSet(items.flatMap((item) => relationIds(item)));
  }

  /** Finds managed section. */
  private async findManagedSection(
    pageId: string,
    heading: string,
  ): Promise<{
    /** Contains content for find managed section. */ readonly content: JsonObject;
  }> {
    /** Holds the `blocks` intermediate used by `findManagedSection`. */
    const blocks = await this.childBlocks(pageId);
    /** Holds the `matches` intermediate used by `findManagedSection`. */
    const matches = blocks
      .map((block, index) => ({ block, index }))
      .filter(
        ({ block }) =>
          block.type === "heading_2" && blockText(block) === heading,
      );
    if (matches.length !== 1)
      throw new Error(`Page ${pageId} must contain exactly one ## ${heading}`);
    /** Holds the `match` intermediate used by `findManagedSection`. */
    const match = matches[0];
    if (match === undefined)
      throw new Error(`Page ${pageId} managed heading is missing`);
    /** Holds the `content` intermediate used by `findManagedSection`. */
    const content = blocks[match.index + 1];
    if (content === undefined || content.type !== "code")
      throw new Error(`## ${heading} must be followed by a code block`);
    return { content };
  }

  /** Queries all Notion pages matching one property filter. */
  private async filteredPages(
    table: TableKind,
    filter: JsonObject,
  ): Promise<readonly JsonObject[]> {
    return collectNotionPages((cursor) =>
      this.transport.request({
        body: {
          filter,
          page_size: 100,
          ...(cursor === null ? {} : { start_cursor: cursor }),
        },
        method: "POST",
        path: `/v1/data_sources/${this.tables[table]}/query`,
      }),
    );
  }

  /** Lists blocks. */
  private async childBlocks(pageId: string): Promise<readonly JsonObject[]> {
    return collectNotionPages((cursor) =>
      this.transport.request({
        method: "GET",
        path: `/v1/blocks/${pageId}/children`,
        query: { page_size: 100, start_cursor: cursor },
      }),
    );
  }

  /** Creates a provider write receipt from verified record state. */
  private receipt(
    table: TableKind,
    page: LocatedPage,
    idempotencyKey: string,
  ): WriteReceipt {
    return {
      idempotencyKey,
      observedVersion: page.version,
      providerRecord: { id: page.id, table },
      writtenAt: this.now().toISOString(),
    };
  }
}

/** Encodes a Resource mutation as Notion page properties. */
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

/** Encodes an Error mutation as Notion page properties. */
function errorProperties(error: ErrorMutation): JsonObject {
  return {
    Error: titleProperty(error.title),
    "Error Key": richTextProperty(error.errorKey),
    "Run ID": richTextProperty(error.relatedRunId ?? ""),
    Severity: selectProperty(error.severity),
    Status: selectProperty(error.status),
    Agent: relationProperty(
      error.relatedAgentId === null ? [] : [error.relatedAgentId],
    ),
    Task: relationProperty(
      error.relatedTaskId === null ? [] : [error.relatedTaskId],
    ),
  };
}

/** Encodes generic properties. */
function encodeGenericProperties(
  properties: JsonObject,
  page: JsonObject,
): JsonObject {
  return Object.fromEntries(
    Object.entries(properties).map(([name, value]) => {
      /** Holds the `current` intermediate used by `encodeGenericProperties`. */
      const current = pageProperty(page, name);
      return [
        name,
        encodeProperty(value, requiredString(current.type, `${name} type`)),
      ];
    }),
  );
}

/** Encodes property. */
function encodeProperty(value: JsonValue, type: string): JsonObject {
  if (type === "checkbox" && typeof value === "boolean")
    return { checkbox: value };
  if (type === "number" && (typeof value === "number" || value === null))
    return { number: value };
  if (type === "title" && typeof value === "string")
    return titleProperty(value);
  if (type === "rich_text" && typeof value === "string")
    return richTextProperty(value);
  if (
    (type === "select" || type === "status") &&
    (typeof value === "string" || value === null)
  ) {
    return { [type]: value === null ? null : { name: value } };
  }
  if (type === "url" && (typeof value === "string" || value === null))
    return { url: value };
  if (
    type === "relation" &&
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  )
    return relationProperty(value as string[]);
  if (
    type === "date" &&
    (value === null || (typeof value === "object" && !Array.isArray(value)))
  )
    return { date: value };
  throw new TypeError(
    `Task mutation value is invalid for Notion property type ${type}`,
  );
}

/** Reports whether a Notion property equals the requested filter value. */
function propertyMatches(
  page: JsonObject,
  name: string,
  expected: JsonValue,
): boolean {
  /** Holds the `property` intermediate used by `propertyMatches`. */
  const property = pageProperty(page, name);
  /** Holds the `type` intermediate used by `propertyMatches`. */
  const type = property.type;
  if (type === "checkbox") return property.checkbox === expected;
  if (type === "number") return property.number === expected;
  if (type === "rich_text" || type === "title")
    return propertyText(page, name) === expected;
  if (type === "select" || type === "status")
    return propertyOption(page, name) === expected;
  if (type === "relation" && Array.isArray(expected))
    return sameSet(
      relationIds(property),
      expected.filter((item): item is string => typeof item === "string"),
    );
  return false;
}

/** Builds a located page with its opaque version. */
function located(page: JsonObject): LocatedPage {
  /** Holds the `id` intermediate used by `located`. */
  const id = requiredString(page.id, "Page id");
  return {
    id,
    page,
    version: requiredString(
      page.last_edited_time,
      `Page ${id} last_edited_time`,
    ),
  };
}

/** Rejects values that violate the page parent contract. */
function assertPageParent(
  page: JsonObject,
  tableId: string,
  label: string,
): void {
  /** Holds the `parent` intermediate used by `assertPageParent`. */
  const parent = objectValue(page.parent, `${label} parent`);
  if (
    typeof parent.data_source_id !== "string" ||
    compactIdentifier(parent.data_source_id) !== compactIdentifier(tableId)
  ) {
    throw new Error(`${label} does not belong to its configured table`);
  }
}

/** Normalizes identifier. */
function compactIdentifier(value: string): string {
  return value.replaceAll("-", "").toLowerCase();
}

/** Encodes property. */
function titleProperty(text: string): JsonObject {
  return { title: richText(text) };
}
/** Converts text property. */
function richTextProperty(text: string): JsonObject {
  return { rich_text: richText(text) };
}
/** Builds property. */
function selectProperty(name: string): JsonObject {
  return { select: { name } };
}
/** Reads property. */
function relationProperty(ids: readonly string[]): JsonObject {
  return { relation: normalizedSet(ids).map((id) => ({ id })) };
}

/** Builds the heading block that starts a managed section. */
function managedHeading(text: string): JsonObject {
  return {
    heading_2: { rich_text: richText(text) },
    object: "block",
    type: "heading_2",
  };
}

/** Builds code blocks containing one managed-section payload. */
function managedCode(
  text: string,
  language = "json",
  caption: string | null = null,
): JsonObject {
  return {
    code: codeValue(text, language, caption),
    object: "block",
    type: "code",
  };
}

/** Encodes one chunk of managed content as a Notion code block. */
function codeValue(
  text: string,
  language = "json",
  caption: string | null = null,
): JsonObject {
  return {
    ...(caption === null ? {} : { caption: richText(caption) }),
    language,
    rich_text: richText(normalizeText(text)),
  };
}

/** Converts text. */
function richText(text: string): JsonValue[] {
  /** Holds the `normalized` intermediate used by `richText`. */
  const normalized = normalizeText(text);
  if (normalized === "") return [];
  /** Holds the `chunks` intermediate used by `richText`. */
  const chunks: JsonValue[] = [];
  for (let index = 0; index < normalized.length; index += 2000) {
    chunks.push({
      text: { content: normalized.slice(index, index + 2000) },
      type: "text",
    });
  }
  return chunks;
}

/** Extracts plain text from a supported Notion block. */
function blockText(block: JsonObject): string {
  /** Holds the `type` intermediate used by `blockText`. */
  const type = requiredString(block.type, "Block type");
  return richTextValue(objectValue(block[type], `Block ${type}`).rich_text);
}

/** Extracts text from a title or rich-text page property. */
function propertyText(page: JsonObject, name: string): string {
  /** Holds the `property` intermediate used by `propertyText`. */
  const property = pageProperty(page, name);
  /** Holds the `type` intermediate used by `propertyText`. */
  const type = requiredString(property.type, `${name} type`);
  return richTextValue(property[type]);
}

/** Extracts an optional select value from a page property. */
function propertyOption(page: JsonObject, name: string): string | null {
  /** Holds the `property` intermediate used by `propertyOption`. */
  const property = pageProperty(page, name);
  /** Holds the `type` intermediate used by `propertyOption`. */
  const type = requiredString(property.type, `${name} type`);
  /** Holds the `value` intermediate used by `propertyOption`. */
  const value = property[type];
  if (value === null || value === undefined) return null;
  return requiredString(
    objectValue(value, `${name} option`).name,
    `${name} option name`,
  );
}

/** Converts text value. */
function richTextValue(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      /** Holds the `object` intermediate used by `richTextValue`. */
      const object = objectValue(item, "Rich text item");
      if (typeof object.plain_text === "string") return object.plain_text;
      return requiredString(
        objectValue(object.text, "Rich text value").content,
        "Rich text content",
      );
    })
    .join("")
    .normalize("NFC");
}

/** Reads IDs. */
function relationIds(property: JsonObject): readonly string[] {
  if (Array.isArray(property.relation)) {
    return property.relation.map((item) =>
      requiredString(objectValue(item, "Relation item").id, "Relation id"),
    );
  }
  if (
    property.relation !== null &&
    property.relation !== undefined &&
    typeof property.relation === "object"
  ) {
    return [
      requiredString(
        objectValue(property.relation, "Relation item").id,
        "Relation id",
      ),
    ];
  }
  return [];
}

/** Returns a named property from a Notion page. */
function pageProperty(page: JsonObject, name: string): JsonObject {
  /** Holds the `properties` intermediate used by `pageProperty`. */
  const properties = objectValue(page.properties, "Page properties");
  return objectValue(properties[name], `Property ${name}`);
}

/** Verifies property text. */
function verifyPropertyText(
  page: JsonObject,
  name: string,
  expected: string,
): void {
  if (propertyText(page, name) !== expected)
    throw new Error(`${name} post-verification failed`);
}

/** Returns unique strings in deterministic order. */
function normalizedSet(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
/** Compares two string collections as normalized sets. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return normalizedSet(left).join("\0") === normalizedSet(right).join("\0");
}
/** Derives Agent activity from active run leases. */
function activityStatus(runLeaseIds: readonly string[]): "Offline" | "Online" {
  return runLeaseIds.length === 0 ? "Offline" : "Online";
}
/** Normalizes text. */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").normalize("NFC");
}

/** Returns a validated JSON object. */
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  /** Holds the `checked` intermediate used by `objectValue`. */
  const checked = toJsonValue(value);
  if (checked === null || typeof checked !== "object" || Array.isArray(checked))
    throw new TypeError(`${label} must be an object`);
  return checked;
}

/** Returns a required non-empty string or throws. */
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Builds mutation digest. */
export function resourceMutationDigest(
  record: Omit<ResourceMutation, "idempotencyKey">,
): string {
  return sha256(JSON.stringify(toJsonValue(record)));
}
