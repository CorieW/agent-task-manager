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
  canonicalResourceMarkdown,
  isMarkdownResourceKind,
  resourceBodyFromMarkdownResponse,
  resourcePageMarkdown,
} from "./notion-resource-markdown.js";
import {
  decodeResourceKindOption,
  encodeErrorSeverityOption,
  encodeResourceKindOption,
  encodeResourceStateOption,
  encodeSelectFilter,
} from "./notion-option-codec.js";
import {
  collectNotionPages,
  type NotionTransport,
} from "./notion-transport.js";

/** Notion property values that can be verified but not updated through a page patch. */
const READ_ONLY_PROPERTY_TYPES = new Set([
  "created_by",
  "created_time",
  "formula",
  "last_edited_by",
  "last_edited_time",
  "rollup",
  "unique_id",
  "verification",
]);

/** Provider-neutral Notion mutable table IDs contract. */
export interface NotionMutableTableIds {
  /** Errors table data-source identifier. */
  readonly errors: string;
  /** Resources table data-source identifier. */
  readonly resources: string;
  /** Agents table data-source identifier. */
  readonly agents: string;
  /** Tasks table data-source identifier. */
  readonly tasks: string;
}

/** Provider-neutral located page contract. */
export interface LocatedPage {
  /** Stable identifier for located page. */
  readonly id: string;
  /** Raw Notion page paired with its normalized identifier. */
  readonly page: JsonObject;
  /** Carries the opaque located page version used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Provider-neutral Notion agent activity contract. */
export interface NotionAgentActivity {
  /** Ordered status used by Notion agent activity. */
  readonly status: string;
  /** Ordered task IDs for Notion agent activity. */
  readonly taskIds: readonly string[];
  /** Carries the opaque Notion agent activity version used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Implements Notion page store. */
export class NotionPageStore {
  /** Initializes Notion page store. */
  public constructor(
    /** Tables callback invoked by Notion page store. */ private readonly tables: NotionMutableTableIds,
    /** Transport callback invoked by Notion page store. */ private readonly transport: NotionTransport,
    /** Now callback invoked by Notion page store. */ private readonly now: () => Date = () =>
      new Date(),
  ) {}

  /** Finds unique by title. */
  public async findUniqueByTitle(
    table: TableKind,
    property: string,
    value: string,
  ): Promise<LocatedPage | null> {
    /** Pages matching the canonical title predicate. */
    const pages = await this.filteredPages(table, {
      property,
      title: { equals: value },
    });
    if (pages.length > 1)
      throw new Error(`${table}.${property}=${value} is not unique`);
    /** Sole matching page, if one exists. */
    const page = pages[0];
    return page === undefined ? null : located(page);
  }

  /** Finds unique by rich text. */
  public async findUniqueByRichText(
    table: TableKind,
    property: string,
    value: string,
  ): Promise<LocatedPage | null> {
    /** Pages matching the canonical rich-text predicate. */
    const pages = await this.filteredPages(table, {
      property,
      rich_text: { equals: value },
    });
    if (pages.length > 1)
      throw new Error(`${table}.${property}=${value} is not unique`);
    /** Sole matching page, if one exists. */
    const page = pages[0];
    return page === undefined ? null : located(page);
  }

  /** Returns pages whose select property exactly matches a canonical value in deterministic order. */
  public async listBySelect(
    table: TableKind,
    property: string,
    value: string,
  ): Promise<readonly LocatedPage[]> {
    /** Provider pages returned by the encoded select filter. */
    const pages = await this.filteredPages(table, {
      property,
      select: { equals: encodeSelectFilter(table, property, value) },
    });
    return pages.map((page) => located(page));
  }

  /** Creates or updates a Resource in the representation selected by its kind. */
  public async createResource(record: ResourceMutation): Promise<WriteReceipt> {
    assertResourceBodyDigest(record);
    /** Existing Resource page reused for idempotent create-or-update behavior. */
    const existing = await this.findUniqueByTitle(
      "resources",
      "Resource",
      record.key,
    );
    if (existing !== null) return this.updateResource(existing, record);
    /** Provider page created in the representation dependency consumed by the Resource kind. */
    const created = isMarkdownResourceKind(record.kind)
      ? await this.createMarkdownResourcePage(record)
      : await this.createManagedPage(
          "resources",
          resourceProperties(record),
          "Resource body",
          record.body,
        );
    return this.receipt("resources", created, record.idempotencyKey);
  }

  /** Replaces Resource metadata and its complete manager-owned body. */
  public async updateResource(
    existing: LocatedPage,
    record: ResourceMutation,
  ): Promise<WriteReceipt> {
    assertResourceBodyDigest(record);
    await this.transport.request({
      body: { properties: resourceProperties(record) },
      method: "PATCH",
      path: `/v1/pages/${existing.id}`,
    });
    if (isMarkdownResourceKind(record.kind)) {
      await this.replaceManagedResourceMarkdown(existing.id, record.body);
    } else {
      await this.replaceManagedResourceBlocks(existing.id, record.body);
    }
    /** Read-after-write snapshot used to verify the authoritative properties. */
    const verified = await this.getPage(existing.id);
    verifyPropertyText(verified.page, "Resource", record.key);
    verifyPropertyText(verified.page, "Digest", record.digest);
    return this.receipt("resources", verified, record.idempotencyKey);
  }

  /** Reports whether raw Resource properties equal a staged mutation target. */
  public async resourceTargetMetadataMatches(
    record: ResourceMutation,
  ): Promise<boolean> {
    /** Existing page whose raw properties may describe the staged target. */
    const existing = await this.findUniqueByTitle(
      "resources",
      "Resource",
      record.key,
    );
    if (existing === null) return false;
    try {
      return (
        propertyText(existing.page, "Resource") === record.key &&
        propertyText(existing.page, "Digest") === record.digest &&
        decodeResourceKindOption(
          propertyOption(existing.page, "Kind") ?? "",
        ) === record.kind &&
        propertyOption(existing.page, "State") ===
          encodeResourceStateOption(record.state) &&
        propertyText(existing.page, "Version") === record.version &&
        propertyText(existing.page, "Dependencies") ===
          JSON.stringify(record.dependencies)
      );
    } catch {
      return false;
    }
  }

  /** Creates or updates the Error identified by Error Key. */
  public async createOrUpdateError(
    error: ErrorMutation,
  ): Promise<WriteReceipt> {
    /** Existing Error row identified by its stable Error Key. */
    const existing = await this.findUniqueByRichText(
      "errors",
      "Error Key",
      error.errorKey,
    );
    /** Complete Notion property projection for the requested Error state. */
    const properties = errorProperties(error);
    /** Written Error page used to construct the provider receipt. */
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
    /** Existing Error row that may already equal the requested target. */
    const existing = await this.findUniqueByRichText(
      "errors",
      "Error Key",
      error.errorKey,
    );
    if (existing === null) return null;
    /** Current Error properties decoded from the provider page. */
    const current = await this.getPage(existing.id);
    /** Whether every manager-owned Error field matches the target mutation. */
    const exact =
      propertyText(current.page, "Error") === error.title &&
      propertyText(current.page, "Error Key") === error.errorKey &&
      propertyOption(current.page, "Severity") ===
        encodeErrorSeverityOption(error.severity) &&
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
    /** Current agent activity used as the conditional-write basis. */
    const current = await this.getPage(change.agentId);
    /** Canonically ordered Task relations in the current activity projection. */
    const currentTaskIds = await this.relationIds(current.page, "Working On");
    if (!sameSet(currentTaskIds, change.expectedTaskIds))
      throw new Error("Agent Working On conflict");
    /** Current Online/Offline projection derived from active run leases. */
    const currentStatus = propertyOption(current.page, "Status");
    /** Expected status used to validate `updateAgentActivity`. */
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
    /** Current agent page and its provider version. */
    const current = await this.getPage(agentId);
    return {
      status: propertyOption(current.page, "Status") ?? "",
      taskIds: normalizedSet(
        await this.relationIds(current.page, "Working On"),
      ),
      version: current.version,
    };
  }

  /** Persists Agent activity with optimistic concurrency. */
  public async setAgentActivity(
    agentId: string,
    expectedStatus: string,
    expectedTaskIds: readonly string[],
    nextStatus: "Offline" | "Online",
    nextTaskIds: readonly string[],
    idempotencyKey: string,
  ): Promise<WriteReceipt> {
    /** Current activity projection that must match the requested basis. */
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
    /** Read-after-write activity projection used to verify the replacement. */
    const verified = await this.getPage(agentId);
    /** Status decoded from the verified provider page. */
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
    /** Current Task snapshot used for version and replay checks. */
    const current = await this.getPage(mutation.taskId);
    assertPageParent(current.page, this.tables.tasks, "Task");
    if (current.version !== mutation.expectedVersion)
      throw new Error("Task version conflict");
    /** Current Task status decoded before applying the conditional mutation. */
    const currentStatus = propertyOption(current.page, "Status");
    if (currentStatus === null) throw new Error("Task Status is missing");
    /** Digest that identifies the complete requested Task mutation. */
    const mutationDigest = digestJson(toJsonValue(mutation));
    /** Canonical target properties including the requested status. */
    const targetProperties = {
      ...taskPropertiesWithStatus(
        mutation.nextProperties,
        mutation.nextStatus ?? currentStatus,
      ),
      [NOTION_TASK_MUTATION_PROPERTY]: mutationDigest,
    };
    /** Provider property payload with the recovery marker attached. */
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
    /** Read-after-write Task snapshot used to verify body and properties. */
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
    /** Current Task snapshot compared with the requested mutation target. */
    const current = await this.getPage(taskId);
    assertPageParent(current.page, this.tables.tasks, "Task");
    return this.receipt("tasks", current, idempotencyKey);
  }

  /** Completes marked task properties. */
  public async completeMarkedTaskProperties(
    mutation: ConditionalTaskMutation,
  ): Promise<WriteReceipt> {
    /** Marked Task snapshot recovered after a property-write interruption. */
    const current = await this.getPage(mutation.taskId);
    assertPageParent(current.page, this.tables.tasks, "Task");
    /** Digest parsed from the Task's manager-owned recovery marker. */
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
    /** Status captured in the original conditional mutation basis. */
    const sourceStatus = propertyOption(current.page, "Status");
    if (sourceStatus === null) throw new Error("Task Status is missing");
    /** Final Task properties reconstructed from the frozen mutation. */
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
    /** Read-after-write Task snapshot confirming recovery completion. */
    const verified = await this.getPage(mutation.taskId);
    for (const [name, expected] of Object.entries(targetProperties))
      if (!propertyMatches(verified.page, name, expected))
        throw new Error(`Task property ${name} post-verification failed`);
    return this.receipt("tasks", verified, mutation.idempotencyKey);
  }

  /** Retrieves a page and verifies that it belongs to its configured data source. */
  public async getPage(pageId: string): Promise<LocatedPage> {
    /** Provider response for the requested page identifier. */
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
    /** Unique manager-owned heading and following content block. */
    const section = await this.findManagedSection(pageId, heading);
    return blockText(section.content);
  }

  /** Creates a readable Resource through Notion's native Markdown surface. */
  private async createMarkdownResourcePage(
    record: ResourceMutation,
  ): Promise<LocatedPage> {
    /** Rejects a non-canonical or unsafe body before the external mutation. */
    const canonicalBody = canonicalResourceMarkdown(record.body);
    /** Creates properties and canonical Markdown in one provider request. */
    const response = await this.transport.request({
      body: {
        markdown: resourcePageMarkdown(canonicalBody),
        parent: { data_source_id: this.tables.resources },
        properties: resourceProperties(record),
      },
      method: "POST",
      path: "/v1/pages",
    });
    /** Page ID returned after creating the readable Resource. */
    const id = requiredString(response.id, "Created readable Resource page id");
    if ((await this.readResourceMarkdown(id)) !== canonicalBody) {
      throw new Error("Created readable Resource Markdown did not verify");
    }
    return this.getPage(id);
  }

  /** Replaces a readable Resource through Notion's native Markdown surface. */
  private async replaceManagedResourceMarkdown(
    pageId: string,
    resourceBody: string,
  ): Promise<void> {
    /** Rejects a non-canonical or unsafe body before the external mutation. */
    const canonicalBody = canonicalResourceMarkdown(resourceBody);
    /** Replaces the complete manager-owned readable Resource body. */
    const response = await this.transport.request({
      body: {
        replace_content: { new_str: resourcePageMarkdown(canonicalBody) },
        type: "replace_content",
      },
      method: "PATCH",
      path: `/v1/pages/${pageId}/markdown`,
    });
    if (resourceBodyFromMarkdownResponse(response) !== canonicalBody) {
      throw new Error(
        "Updated readable Resource Markdown response did not verify",
      );
    }

    if ((await this.readResourceMarkdown(pageId)) !== canonicalBody) {
      throw new Error("Updated readable Resource Markdown did not verify");
    }
  }

  /** Rebuilds the complete machine-readable Resource body idempotently. */
  private async replaceManagedResourceBlocks(
    pageId: string,
    resourceBody: string,
  ): Promise<void> {
    /** Canonical machine-readable body written into the managed code block. */
    const canonicalBody = normalizeText(resourceBody);
    for (const block of await this.childBlocks(pageId)) {
      await this.transport.request({
        body: { in_trash: true },
        method: "PATCH",
        path: `/v1/blocks/${requiredString(block.id, "Resource block id")}`,
      });
    }
    await this.transport.request({
      body: {
        children: [managedHeading("Resource body"), managedCode(canonicalBody)],
      },
      method: "PATCH",
      path: `/v1/blocks/${pageId}/children`,
    });

    if ((await this.managedText(pageId, "Resource body")) !== canonicalBody) {
      throw new Error("Updated ## Resource body content did not verify");
    }
  }

  /** Reads and validates the complete native Markdown projection of a Resource. */
  private async readResourceMarkdown(pageId: string): Promise<string> {
    /** Retrieves canonical Markdown plus truncation and unknown-block evidence. */
    const response = await this.transport.request({
      method: "GET",
      path: `/v1/pages/${pageId}/markdown`,
    });
    return resourceBodyFromMarkdownResponse(response);
  }

  /** Creates managed page. */
  private async createManagedPage(
    table: TableKind,
    properties: JsonObject,
    heading: string,
    text: string,
    additional: readonly {
      /** Managed section heading. */
      readonly heading: string;
      /** Canonical code-block text beneath the heading. */
      readonly text: string;
    }[] = [],
  ): Promise<LocatedPage> {
    /** Optional heading and code block used for manager-owned page content. */
    const children = [managedHeading(heading), managedCode(text)];
    for (const section of additional)
      children.push(managedHeading(section.heading), managedCode(section.text));
    /** Notion response containing the newly created page identifier. */
    const response = await this.transport.request({
      body: {
        children,
        parent: { data_source_id: this.tables[table] },
        properties,
      },
      method: "POST",
      path: "/v1/pages",
    });
    /** Page identifier returned by the Notion create operation. */
    const id = requiredString(response.id, "Created page id");
    /** Read-after-create page used to verify the managed body. */
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
    /** Existing managed section whose content block will be replaced. */
    const section = await this.findManagedSection(pageId, heading);
    /** Notion block type of the managed content block. */
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
    /** Complete Task block tree used to identify marked body generations. */
    const blocks = await this.childBlocks(pageId);
    /** Valid manager-generated Task body candidates. */
    const generated = activeTaskBodyGeneration(blocks);
    if (generated !== null) return generated.body;
    /** Latest valid marked generation selected as authoritative. */
    const active = blocks.length === 1 ? blocks[0] : undefined;
    if (active?.type !== "code") return null;
    /** Code block immediately following the active generation marker. */
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
    /** Inline relation property and its pagination metadata. */
    const property = pageProperty(page, propertyName);
    if (property.has_more !== true) return normalizedSet(relationIds(property));
    /** Page identifier required for relation-property pagination. */
    const pageId = requiredString(page.id, "Page id");
    /** Property identifier required for relation-property pagination. */
    const propertyId = requiredString(
      property.id,
      `${propertyName} property id`,
    );
    /** Relation targets accumulated across every property page. */
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
    /** Code block immediately following the unique managed heading. */ readonly content: JsonObject;
  }> {
    /** Complete child-block sequence searched for the managed heading. */
    const blocks = await this.childBlocks(pageId);
    /** Indexes whose heading text exactly matches the managed section. */
    const matches = blocks
      .map((block, index) => ({ block, index }))
      .filter(
        ({ block }) =>
          block.type === "heading_2" && blockText(block) === heading,
      );
    if (matches.length !== 1)
      throw new Error(`Page ${pageId} must contain exactly one ## ${heading}`);
    /** Sole managed heading index after uniqueness validation. */
    const match = matches[0];
    if (match === undefined)
      throw new Error(`Page ${pageId} managed heading is missing`);
    /** Block immediately following the managed heading, if present. */
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

  /** Returns every direct child block across all Notion result pages. */
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
    Kind: selectProperty(encodeResourceKindOption(record.kind)),
    Resource: titleProperty(record.key),
    State: selectProperty(encodeResourceStateOption(record.state)),
    Version: richTextProperty(record.version),
  };
}

/** Rejects a Resource whose digest does not bind its canonical stored body. */
function assertResourceBodyDigest(record: ResourceMutation): void {
  /** Canonical representation that the provider will persist and verify. */
  const canonicalBody = isMarkdownResourceKind(record.kind)
    ? canonicalResourceMarkdown(record.body)
    : normalizeText(record.body);
  if (
    canonicalBody !== record.body ||
    sha256(canonicalBody) !== record.digest
  ) {
    throw new TypeError(
      `Resource ${record.key} body and Digest must be canonical`,
    );
  }
}

/** Encodes an Error mutation as Notion page properties. */
function errorProperties(error: ErrorMutation): JsonObject {
  return {
    Error: titleProperty(error.title),
    "Error Key": richTextProperty(error.errorKey),
    "Run ID": richTextProperty(error.relatedRunId ?? ""),
    Severity: selectProperty(encodeErrorSeverityOption(error.severity)),
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
  /** Writable Notion updates derived from the provider-neutral mutation. */
  const encoded: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(properties)) {
    /** Existing Task property used to preserve the provider property type. */
    const current = pageProperty(page, name);
    /** Provider property type controlling whether and how the value can be patched. */
    const type = requiredString(current.type, `${name} type`);
    if (!READ_ONLY_PROPERTY_TYPES.has(type))
      encoded[name] = encodeProperty(value, type);
  }
  return encoded;
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
  if (type === "multi_select" && Array.isArray(value))
    return {
      multi_select: multiSelectOptionNames(value).map((name) => ({ name })),
    };
  if (type === "people" && Array.isArray(value))
    return {
      people: propertyReferenceIds(value, "People").map((id) => ({ id })),
    };
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
  /** Raw Notion property compared with the provider-neutral target. */
  const property = pageProperty(page, name);
  /** Notion property type that determines comparison semantics. */
  const type = property.type;
  if (READ_ONLY_PROPERTY_TYPES.has(String(type)))
    return (
      digestJson(toJsonValue(property[String(type)] ?? null)) ===
      digestJson(expected)
    );
  if (type === "checkbox") return property.checkbox === expected;
  if (type === "number") return property.number === expected;
  if (type === "url" || type === "email" || type === "phone_number")
    return property[type] === expected;
  if (type === "date" || type === "files")
    return (
      digestJson(toJsonValue(property[type] ?? null)) === digestJson(expected)
    );
  if (type === "rich_text" || type === "title")
    return propertyText(page, name) === expected;
  if (type === "select" || type === "status")
    return propertyOption(page, name) === expected;
  if (type === "multi_select" && Array.isArray(expected))
    return sameSet(
      multiSelectNames(property),
      multiSelectOptionNames(expected),
    );
  if (type === "people" && Array.isArray(expected))
    return sameSet(
      propertyReferenceIds(property.people, "People"),
      propertyReferenceIds(expected, "People"),
    );
  if (type === "relation" && Array.isArray(expected))
    return sameSet(
      relationIds(property),
      expected.filter((item): item is string => typeof item === "string"),
    );
  return false;
}

/** Extracts option names from a Notion multi-select property. */
function multiSelectNames(property: JsonObject): readonly string[] {
  if (!Array.isArray(property.multi_select))
    throw new TypeError("Notion multi_select property must contain an array");
  return property.multi_select.map((item, index) =>
    requiredString(
      objectValue(item, `Multi-select item ${index}`).name,
      `Multi-select item ${index} name`,
    ),
  );
}

/** Normalizes caller-supplied multi-select names or decoded Notion options. */
function multiSelectOptionNames(
  value: readonly JsonValue[],
): readonly string[] {
  return value.map((item, index) => {
    if (typeof item === "string") return item;
    return requiredString(
      objectValue(item, `Multi-select option ${index}`).name,
      `Multi-select option ${index} name`,
    );
  });
}

/** Extracts IDs from provider references or caller-supplied identity strings. */
function propertyReferenceIds(
  value: JsonValue | undefined,
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) =>
    typeof item === "string"
      ? item
      : requiredString(
          objectValue(item, `${label} item ${index}`).id,
          `${label} item ${index} id`,
        ),
  );
}

/** Builds a located page with its opaque version. */
function located(page: JsonObject): LocatedPage {
  /** Stable Notion page identifier paired with the raw page object. */
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
  /** Parent descriptor used to verify data-source ownership. */
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
  /** NFC-normalized text split to Notion's rich-text size bound. */
  const normalized = normalizeText(text);
  if (normalized === "") return [];
  /** Unicode-safe chunks accepted by individual Notion text objects. */
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
  /** Notion block type whose rich text is being decoded. */
  const type = requiredString(block.type, "Block type");
  return richTextValue(objectValue(block[type], `Block ${type}`).rich_text);
}

/** Extracts text from a title or rich-text page property. */
function propertyText(page: JsonObject, name: string): string {
  /** Raw Notion property expected to contain title or rich text. */
  const property = pageProperty(page, name);
  /** Property type that selects the supported text projection. */
  const type = requiredString(property.type, `${name} type`);
  return richTextValue(property[type]);
}

/** Extracts an optional select value from a page property. */
function propertyOption(page: JsonObject, name: string): string | null {
  /** Raw Notion property expected to contain a select-like option. */
  const property = pageProperty(page, name);
  /** Property type that selects the supported option projection. */
  const type = requiredString(property.type, `${name} type`);
  /** Selected option object, or null when the property is unset. */
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
      /** Rich-text fragment validated before extracting plain text. */
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
  /** Page property map containing the requested canonical property name. */
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
  /** Non-array object accepted at the JSON boundary. */
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
