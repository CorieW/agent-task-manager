#!/usr/bin/env node
/** One-time Management v2 migration entry point. */
import { isAbsolute } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../src/domain/json.js";
import {
  auditManagedResourceContract,
  LEGACY_PROPERTIES_BY_TABLE,
  MANAGEMENT_V2_DATABASES,
  MANAGEMENT_V2_DATABASE_PAGES,
  MANAGEMENT_V2_PARENT,
  materializeMigrationBodies,
  planManagementV2Migration,
  type ManagementInventory,
  type ManagementMigrationPlan,
  type MigrationRow,
  type MigrationTable,
} from "../src/migration/management-v2.js";
import { normalizeNotionId } from "../src/provider/notion/notion-id.js";
import { NotionProvider } from "../src/provider/notion/notion-provider.js";
import { SingleHostMutex } from "../src/provider/notion/single-host-mutex.js";
import {
  NOTION_SCHEMA_DIGEST,
  notionTable,
} from "../src/provider/notion/notion-schema.js";
import {
  asObject,
  collectNotionPages,
  decodeCompletePageMarkdown,
  NotionApiError,
  NotionHttpTransport,
  type NotionTransport,
} from "../src/provider/notion/notion-transport.js";

/** Migration mode, table override, and optional apply authorization. */
interface Arguments {
  /** Configured Active Agents database page ID. */
  readonly activeAgentsId: string | null;
  /** Whether to execute the authorized migration plan. */
  readonly apply: boolean;
  /** Plan digest required to authorize apply mode. */
  readonly expectedDigest: string | null;
  /** Whether to print a non-mutating migration plan. */
  readonly plan: boolean;
}

/** Runs the guarded management-v2 migration command. */
async function main(): Promise<void> {
  /** Validated migration mode selected from process arguments. */
  const args = parseArguments(process.argv.slice(2));
  if (args.plan === args.apply)
    throw new Error("Specify exactly one of --plan or --apply");
  if (args.apply && args.expectedDigest === null)
    throw new Error("--apply requires --expected-plan-digest");
  /** Notion token required for migration API calls. */
  const token = process.env.NOTION_TOKEN;
  if (token === undefined || token.trim() === "")
    throw new Error("NOTION_TOKEN is required");
  /** Authenticated Notion transport for the migration. */
  const transport = new NotionHttpTransport({ token });
  /** Reads, authorizes, and optionally applies one internally consistent snapshot. */
  const execute = async (): Promise<void> => {
    /** Authorized snapshot of the current management workspace. */
    const inventory = await readManagementInventory(
      transport,
      args.activeAgentsId,
    );
    /** Digest-bound mutations derived from the inventory snapshot. */
    const plan = planManagementV2Migration(inventory);
    if (args.plan) {
      write(toJsonValue({ mode: "plan", plan, summary: summarize(inventory) }));
      return;
    }
    if (plan.digest !== args.expectedDigest)
      throw new Error(
        `Migration plan drifted: expected ${args.expectedDigest}, observed ${plan.digest}`,
      );
    /** Post-apply validation report returned to the operator. */
    const report = await applyMigration(transport, inventory, plan);
    write(report);
  };
  if (args.plan) await execute();
  else {
    /** Environment mutex shared with the management-v2 runtime CLI. */
    const mutex = new SingleHostMutex(
      { environmentId: "management-v2", scope: "environment" },
      migrationCoordinationDirectory(process.env),
    );
    await mutex.run(execute);
  }
}

/** Reads and normalizes every table required for migration planning. */
export async function readManagementInventory(
  transport: NotionTransport,
  activeAgentsId: string | null,
): Promise<ManagementInventory> {
  /** Legacy Active Agents source resolved from its database when needed. */
  const resolvedActiveAgentsId = await resolveActiveAgentsId(
    transport,
    activeAgentsId,
  );
  /** Managed tables loaded concurrently from the authorized IDs. */
  const [tasks, agents, errors, resources, operations, activeAgents] =
    await Promise.all([
      readTable(transport, MANAGEMENT_V2_DATABASES.tasks),
      readTable(transport, MANAGEMENT_V2_DATABASES.agents),
      readTable(transport, MANAGEMENT_V2_DATABASES.errors),
      readTable(transport, MANAGEMENT_V2_DATABASES.resources),
      readOptionalTable(transport, MANAGEMENT_V2_DATABASES.operations),
      resolvedActiveAgentsId === null
        ? Promise.resolve(null)
        : readOptionalTable(transport, resolvedActiveAgentsId),
    ]);
  return {
    activeAgents,
    agents,
    errors,
    operations,
    parentId: MANAGEMENT_V2_PARENT,
    resources,
    tasks,
  };
}

/** Validates a supplied Active Agents database or discovers its unique child. */
export async function resolveActiveAgentsId(
  transport: NotionTransport,
  suppliedId: string | null,
): Promise<string | null> {
  if (suppliedId !== null) {
    await assertActiveAgentsIdentity(transport, suppliedId);
    return normalizeNotionId(suppliedId);
  }
  /** Child databases beneath the management page. */
  const children = await collectNotionPages((cursor) =>
    transport.request({
      method: "GET",
      path: `/v1/blocks/${MANAGEMENT_V2_PARENT}/children?page_size=100${
        cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`
      }`,
    }),
  );
  /** Child database IDs whose title is exactly Active Agents. */
  const databaseIds = children
    .filter((child) => {
      if (child.type !== "child_database" || child.in_trash === true)
        return false;
      /** Strict object view of one child block. */
      const value = asObject(
        requirePresent(child.child_database, "Child database is missing"),
        "Child database",
      );
      return jsonText(value.title) === "Active Agents";
    })
    .map((child) => normalizeNotionId(jsonText(child.id)));
  if (databaseIds.length > 1)
    throw new Error(
      "Multiple Active Agents databases exist under Management v2",
    );
  /** Unique legacy Active Agents database ID. */
  const databaseId = databaseIds[0];
  if (databaseId === undefined) return null;
  /** Legacy database metadata used to find its data source. */
  const database = await activeAgentsDatabase(transport, databaseId);
  /** Data sources attached to the legacy database. */
  const sources = Array.isArray(database.data_sources)
    ? database.data_sources.map((value) =>
        normalizeNotionId(
          jsonText(asObject(value, "Active Agents data source").id),
        ),
      )
    : [];
  if (sources.length !== 1)
    throw new Error(
      "Active Agents database must contain exactly one data source",
    );
  await assertActiveAgentsIdentity(transport, sources[0]!);
  return sources[0]!;
}

/** Verifies that an Active Agents source belongs to the authorized database. */
async function assertActiveAgentsIdentity(
  transport: NotionTransport,
  dataSourceId: string,
): Promise<void> {
  /** Active Agents data-source metadata. */
  const source = await transport.request({
    method: "GET",
    path: `/v1/data_sources/${normalizeNotionId(dataSourceId)}`,
  });
  /** Database parent declared by the data source. */
  const parent = asObject(
    requirePresent(
      source.parent,
      "Active Agents data source parent is missing",
    ),
    "Active Agents data source parent",
  );
  /** Normalized parent database ID. */
  const databaseId = normalizeNotionId(jsonText(parent.database_id));
  /** Parent database metadata. */
  const database = await activeAgentsDatabase(transport, databaseId);
  /** Data sources currently attached to the parent database. */
  const sources = Array.isArray(database.data_sources)
    ? database.data_sources.map((value) =>
        normalizeNotionId(
          jsonText(asObject(value, "Active Agents data source").id),
        ),
      )
    : [];
  if (!sources.includes(normalizeNotionId(dataSourceId)))
    throw new Error(
      "Active Agents data source does not belong to its database",
    );
}

/** Loads and validates the legacy Active Agents database. */
async function activeAgentsDatabase(
  transport: NotionTransport,
  databaseId: string,
): Promise<JsonObject> {
  /** Database metadata returned by Notion. */
  const database = await transport.request({
    method: "GET",
    path: `/v1/databases/${normalizeNotionId(databaseId)}`,
  });
  /** Parent page metadata for the legacy database. */
  const parent = asObject(
    requirePresent(database.parent, "Active Agents database parent is missing"),
    "Active Agents database parent",
  );
  /** Plain-text database title assembled from rich text. */
  const title = Array.isArray(database.title)
    ? database.title
        .map((value) => jsonText(asObject(value, "Database title").plain_text))
        .join("")
    : "";
  if (
    parent.type !== "page_id" ||
    normalizeNotionId(jsonText(parent.page_id)) !== MANAGEMENT_V2_PARENT ||
    title !== "Active Agents"
  )
    throw new Error(
      "Active Agents database must have the exact Management v2 parent and title",
    );
  return database;
}

/** Applies the authorized migration plan in its fail-closed phase order. */
async function applyMigration(
  transport: NotionTransport,
  inventory: ManagementInventory,
  authorizedPlan: ManagementMigrationPlan,
): Promise<JsonValue> {
  /** Checked-in environment configuration guarding authorized IDs. */
  const environment = {
    bootstrapParent: MANAGEMENT_V2_PARENT,
    connection: {},
    tables: {
      activeAgents: inventory.activeAgents?.id ?? null,
      agents: MANAGEMENT_V2_DATABASES.agents,
      errors: MANAGEMENT_V2_DATABASES.errors,
      resources: MANAGEMENT_V2_DATABASES.resources,
      tasks: MANAGEMENT_V2_DATABASES.tasks,
    },
    type: "notion",
  } as const;
  /** Table kinds whose configured IDs must match migration constants. */
  const authorizedKinds = new Set(
    authorizedPlan.actions.map((action) => action.kind),
  );
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new NotionProvider(environment, transport);
  /** Inventory tables indexed by managed table kind. */
  let tables = Object.fromEntries(
    Object.entries(environment.tables).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  if (
    authorizedKinds.has("add_schema") ||
    authorizedKinds.has("create_active_agents")
  ) {
    /** Additive schema plan produced from the live workspace. */
    const additivePlan = await provider.planWorkspace("management-v2");
    tables = await provider.applyWorkspacePlan(additivePlan);
  }
  /** Configured Active Agents database page ID. */
  const activeAgentsId = tables.activeAgents ?? inventory.activeAgents?.id;
  if (activeAgentsId === undefined)
    throw new Error("Active Agents was not created or discovered");

  /** Canonical Agent bodies expected after conversion. */
  const expectedBodies = new Map<string, string>();

  for (const artifact of materializeMigrationBodies(
    inventory,
    authorizedPlan.actions.filter((entry) => entry.kind === "rewrite_resource"),
  )) {
    /** Legacy property labels that must not survive conversion. */
    const forbidden = auditManagedResourceContract(artifact.markdown);
    if (forbidden.length > 0)
      throw new Error(
        `Managed Resource contract audit failed for ${artifact.title}: ${forbidden.join(", ")}`,
      );
    expectedBodies.set(normalizeNotionId(artifact.targetId), artifact.markdown);
    await replaceMarkdown(
      transport,
      artifact.targetId,
      artifact.sourceBody,
      artifact.markdown,
    );
  }
  for (const artifact of materializeMigrationBodies(
    inventory,
    authorizedPlan.actions.filter((entry) => entry.kind === "convert_agent"),
  )) {
    expectedBodies.set(normalizeNotionId(artifact.targetId), artifact.markdown);
    await replaceMarkdown(
      transport,
      artifact.targetId,
      artifact.sourceBody,
      artifact.markdown,
    );
  }

  await assertInventoryState(
    transport,
    inventory,
    activeAgentsId,
    expectedBodies,
    new Set(),
    true,
  );

  /** Legacy run and operation pages archived by this apply. */
  const archivedIds = new Set(
    authorizedPlan.actions
      .filter(
        (entry) =>
          entry.kind === "archive_error" || entry.kind === "archive_resource",
      )
      .map((entry) => normalizeNotionId(entry.targetId)),
  );
  for (const action of authorizedPlan.actions.filter(
    (entry) =>
      entry.kind === "archive_error" || entry.kind === "archive_resource",
  )) {
    await archivePage(transport, action.targetId);
  }
  if (
    authorizedPlan.actions.some((entry) => entry.kind === "archive_operations")
  ) {
    for (const row of inventory.operations?.rows ?? [])
      await archivePage(transport, row.id);
    try {
      await transport.request({
        body: { in_trash: true },
        method: "PATCH",
        path: `/v1/databases/${MANAGEMENT_V2_DATABASE_PAGES.operations}`,
      });
    } catch (error) {
      if (!(error instanceof NotionApiError && error.status === 404))
        throw error;
    }
  }
  if (authorizedKinds.has("add_schema")) await configureSelects(transport);
  await assertInventoryState(
    transport,
    inventory,
    activeAgentsId,
    expectedBodies,
    archivedIds,
    false,
  );
  if (authorizedKinds.has("drop_legacy_schema"))
    await dropLegacyProperties(transport);

  /** Fresh workspace snapshot after all authorized mutations. */
  const finalInventory = await readManagementInventory(
    transport,
    activeAgentsId,
  );
  /** Residual migration plan; must be empty for idempotence. */
  const finalPlan = planManagementV2Migration({
    ...finalInventory,
    operations: null,
  });
  /** Post-apply invariant report. */
  const validation = await new NotionProvider(
    {
      ...environment,
      tables: { ...environment.tables, activeAgents: activeAgentsId },
    },
    transport,
  ).validateWorkspace();
  /** Legacy properties still present after schema cleanup. */
  const remaining = finalPlan.actions.filter(
    (entry) => entry.kind !== "verify",
  );
  if (!validation.valid || remaining.length > 0)
    throw new Error(
      `Post-migration verification failed: ${JSON.stringify({ remaining, validation })}`,
    );
  return toJsonValue({
    appliedPlanDigest: authorizedPlan.digest,
    counts: summarize({ ...finalInventory, operations: null }),
    finalInventoryDigest: finalPlan.inventoryDigest,
    finalSchemaDigest: NOTION_SCHEMA_DIGEST,
    mode: "apply",
    observedIds: {
      ...tables,
      operations: MANAGEMENT_V2_DATABASES.operations,
      parent: MANAGEMENT_V2_PARENT,
    },
    validation,
  });
}

/** Reads one Notion data source and decodes all of its rows. */
async function readTable(
  transport: NotionTransport,
  id: string,
): Promise<MigrationTable> {
  /** Data-source metadata returned by Notion. */
  const source = await transport.request({
    method: "GET",
    path: `/v1/data_sources/${normalizeNotionId(id)}`,
  });
  /** Canonical schema descriptor for the managed table. */
  const schema = asObject(
    requirePresent(source.properties, "Data source properties are missing"),
    "Data source properties",
  );
  /** Observed Notion property types keyed by name. */
  const properties = Object.fromEntries(
    Object.entries(schema).map(([name, value]) => [
      name,
      jsonText(asObject(value, name).type),
    ]),
  );
  /** All pages currently contained in the data source. */
  const pages = await collectNotionPages((cursor) =>
    transport.request({
      body: {
        page_size: 100,
        ...(cursor === null ? {} : { start_cursor: cursor }),
      },
      method: "POST",
      path: `/v1/data_sources/${normalizeNotionId(id)}/query`,
    }),
  );
  /** Domain-neutral migration rows decoded from the pages. */
  const rows = await Promise.all(
    pages.map(async (page) => pageToRow(transport, page)),
  );
  return { id: normalizeNotionId(id), properties, rows };
}

/** Reads a migration table, treating only a typed Notion 404 as absence. */
async function readOptionalTable(
  transport: NotionTransport,
  id: string,
): Promise<MigrationTable | null> {
  try {
    return await readTable(transport, id);
  } catch (error) {
    if (error instanceof NotionApiError && error.status === 404) return null;
    throw error;
  }
}

/** Decodes a Notion page and its markdown body into a migration row. */
async function pageToRow(
  transport: NotionTransport,
  page: JsonObject,
): Promise<MigrationRow> {
  /** Strict object view of the page's property payload. */
  const rawProperties = asObject(
    requirePresent(page.properties, "Page properties are missing"),
    "Page properties",
  );
  /** Decoded migration values keyed by property name. */
  const properties = Object.fromEntries(
    Object.entries(rawProperties).map(([name, value]) => [
      name,
      decodeProperty(asObject(value, name)),
    ]),
  );
  /** First title-typed property used as the row title. */
  const titleEntry = Object.values(rawProperties).find(
    (value) => asObject(value, "Page property").type === "title",
  );
  /** Markdown body returned by Notion's page-content endpoint. */
  const bodyResult = await transport.request({
    method: "GET",
    path: `/v1/pages/${normalizeNotionId(jsonText(page.id))}/markdown`,
  });
  return {
    body: decodeCompletePageMarkdown(bodyResult, {
      incomplete: "Notion returned incomplete migration Markdown",
      invalidMarkdown: "Migration Markdown must be a string",
      invalidMetadata: "Notion returned incomplete migration Markdown",
    }),
    id: jsonText(page.id),
    properties,
    title:
      titleEntry === undefined ? "" : decodeText(asObject(titleEntry, "Title")),
  };
}

/** Decodes a supported Notion property into a migration value. */
function decodeProperty(property: JsonObject): JsonValue {
  /** Notion property type discriminator. */
  const type = jsonText(property.type);
  if (type === "title" || type === "rich_text") return decodeText(property);
  if (type === "checkbox") return property.checkbox === true;
  if (type === "number")
    return typeof property.number === "number" ? property.number : null;
  if (type === "select") {
    /** Strict select payload, or null for an empty select. */
    const value = property.select;
    return value === null || value === undefined
      ? null
      : jsonText(asObject(value, "Select").name);
  }
  if (type === "relation")
    if (property.has_more === true)
      throw new Error("Notion relation exceeds the inline reference limit");
    else
      return Array.isArray(property.relation)
        ? property.relation.map((entry) =>
            jsonText(asObject(entry, "Relation").id),
          )
        : [];
  if (type === "date") {
    /** Strict date payload, or null for an empty date. */
    const value = property.date;
    return value === null || value === undefined
      ? null
      : jsonText(asObject(value, "Date").start);
  }
  return null;
}

/** Concatenates plain text from a Notion rich-text array. */
function decodeText(property: JsonObject): string {
  /** Rich-text entries before strict object decoding. */
  const value = property.type === "title" ? property.title : property.rich_text;
  return Array.isArray(value)
    ? value
        .map((entry) => jsonText(asObject(entry, "Rich text").plain_text))
        .join("")
    : "";
}

/** Applies the management-v2 select schemas. */
async function configureSelects(transport: NotionTransport): Promise<void> {
  await patchProperties(transport, MANAGEMENT_V2_DATABASES.errors, {
    Source: selectSchema("errors", "Source"),
    Status: selectSchema("errors", "Status"),
  });
  await patchProperties(transport, MANAGEMENT_V2_DATABASES.resources, {
    Kind: selectSchema("resources", "Kind"),
  });
}

/** Builds a Notion select schema from the canonical table descriptor. */
function selectSchema(kind: "errors" | "resources", name: string): JsonObject {
  /** Canonical schema descriptor for the requested property. */
  const descriptor = notionTable(kind).properties.find(
    (property) => property.name === name && property.type === "select",
  );
  if (descriptor === undefined)
    throw new Error(`Canonical select property is missing: ${kind}.${name}`);
  return { select: { options: selectOptions(descriptor.options) } };
}

/** Removes properties that only belong to the legacy schema. */
async function dropLegacyProperties(transport: NotionTransport): Promise<void> {
  for (const [kind, names] of Object.entries(LEGACY_PROPERTIES_BY_TABLE)) {
    /** Authorized data-source ID for the current table. */
    const sourceId =
      MANAGEMENT_V2_DATABASES[kind as keyof typeof LEGACY_PROPERTIES_BY_TABLE];
    /** Current data-source schema. */
    const source = await transport.request({
      method: "GET",
      path: `/v1/data_sources/${normalizeNotionId(sourceId)}`,
    });
    /** Observed provider value compared with the canonical expectation. */
    const observed = asObject(
      requirePresent(source.properties, "Data source properties are missing"),
      "Data source properties",
    );
    /** Null-valued patch that deletes present legacy fields. */
    const properties = Object.fromEntries(
      names
        .filter((name) => observed[name] !== undefined)
        .map((name) => [name, null]),
    );
    if (Object.keys(properties).length > 0)
      await patchProperties(transport, sourceId, properties);
  }
}

/** Applies a property-schema patch to a Notion data source. */
async function patchProperties(
  transport: NotionTransport,
  sourceId: string,
  properties: JsonObject,
): Promise<void> {
  await transport.request({
    body: { properties },
    method: "PATCH",
    path: `/v1/data_sources/${normalizeNotionId(sourceId)}`,
  });
}

/** Atomically replaces the exact inventoried page Markdown. */
export async function replaceMarkdown(
  transport: NotionTransport,
  pageId: string,
  expectedMarkdown: string,
  markdown: string,
): Promise<void> {
  await transport.request({
    body: {
      type: "update_content",
      update_content: {
        content_updates: [{ new_str: markdown, old_str: expectedMarkdown }],
      },
    },
    method: "PATCH",
    path: `/v1/pages/${normalizeNotionId(pageId)}/markdown`,
  });
}

/** Verifies post-apply row parity, archives, and converted Agent bodies. */
async function assertInventoryState(
  transport: NotionTransport,
  original: ManagementInventory,
  activeAgentsId: string,
  expectedBodies: ReadonlyMap<string, string>,
  archivedIds: ReadonlySet<string>,
  includeOperations: boolean,
): Promise<void> {
  /** Current inventory tables indexed by managed kind. */
  const current = await readManagementInventory(transport, activeAgentsId);
  for (const kind of ["agents", "errors", "resources", "tasks"] as const) {
    /** Authorized pre-migration table snapshot. */
    const before = original[kind];
    /** Post-migration table snapshot under validation. */
    const after = current[kind];
    for (const [name, type] of Object.entries(before.properties))
      if (after.properties[name] !== type)
        throw new Error(
          `Migration drift detected before destructive cleanup: ${kind}.${name}`,
        );
    /** Baseline rows transformed for the expected final state. */
    const expectedRows = before.rows.filter(
      (row) => !archivedIds.has(normalizeNotionId(row.id)),
    );
    if (after.rows.length !== expectedRows.length)
      throw new Error(
        `Migration drift detected before destructive cleanup: ${kind} row set`,
      );
    /** Final rows indexed by provider ID for comparison. */
    const byId = new Map(
      after.rows.map((row) => [normalizeNotionId(row.id), row] as const),
    );
    for (const expected of expectedRows) {
      /** Provider ID matching the expected and final row. */
      const id = normalizeNotionId(expected.id);
      /** Observed provider value compared with the canonical expectation. */
      const observed = byId.get(id);
      if (observed === undefined || observed.title !== expected.title)
        throw new Error(
          `Migration drift detected before destructive cleanup: ${kind} row ${id}`,
        );
      for (const [name, value] of Object.entries(expected.properties))
        if (JSON.stringify(observed.properties[name]) !== JSON.stringify(value))
          throw new Error(
            `Migration drift detected before destructive cleanup: ${kind}.${name} on ${id}`,
          );
      if (observed.body !== (expectedBodies.get(id) ?? expected.body))
        throw new Error(
          `Migration drift detected before destructive cleanup: ${kind} body ${id}`,
        );
    }
  }
  if (includeOperations && original.operations !== null) {
    /** Observed provider value compared with the canonical expectation. */
    const observed = current.operations;
    if (
      observed === null ||
      observed.rows.length !== original.operations.rows.length
    )
      throw new Error(
        "Migration drift detected before destructive cleanup: operations row set",
      );
    /** Archived rows indexed by normalized provider ID. */
    const byId = new Map(
      observed.rows.map((row) => [normalizeNotionId(row.id), row] as const),
    );
    for (const expected of original.operations.rows) {
      /** Migration inventory row currently planned or validated. */
      const row = byId.get(normalizeNotionId(expected.id));
      if (
        row === undefined ||
        row.title !== expected.title ||
        row.body !== expected.body ||
        JSON.stringify(row.properties) !== JSON.stringify(expected.properties)
      )
        throw new Error(
          `Migration drift detected before destructive cleanup: operations row ${expected.id}`,
        );
    }
  }
}

/** Moves a migrated legacy page to the Notion trash. */
async function archivePage(
  transport: NotionTransport,
  pageId: string,
): Promise<void> {
  await transport.request({
    body: { in_trash: true },
    method: "PATCH",
    path: `/v1/pages/${normalizeNotionId(pageId)}`,
  });
}

/** Counts the rows in each management inventory table. */
function summarize(inventory: ManagementInventory): JsonObject {
  return {
    activeAgents: inventory.activeAgents?.rows.length ?? 0,
    agents: inventory.agents.rows.length,
    errors: inventory.errors.rows.length,
    operations: inventory.operations?.rows.length ?? 0,
    resources: inventory.resources.rows.length,
    tasks: inventory.tasks.rows.length,
  };
}

/** Parses the migration mode and digest authorization flags. */
function parseArguments(argv: readonly string[]): Arguments {
  /** Whether plan mode has been requested. */
  let plan = false;
  /** Whether apply mode has been requested. */
  let apply = false;
  /** Digest supplied to authorize apply mode. */
  let expectedDigest: string | null = null;
  /** Configured Active Agents database page ID. */
  let activeAgentsId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    /** Current command-line token. */
    const value = argv[index]!;
    if (value === "--plan") plan = true;
    else if (value === "--apply") apply = true;
    else if (value === "--expected-plan-digest")
      expectedDigest = requirePresent(argv[++index], value);
    else if (value === "--active-agents-id")
      activeAgentsId = requirePresent(argv[++index], value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return { activeAgentsId, apply, expectedDigest, plan };
}

/** Resolves the manager-owned coordination directory required for apply mode. */
function migrationCoordinationDirectory(env: NodeJS.ProcessEnv): string {
  /** Absolute host-private lock root shared with the runtime CLI. */
  const value = env.AGENT_TASK_MANAGER_COORDINATION_DIRECTORY;
  if (value === undefined || value.trim() === "" || !isAbsolute(value))
    throw new Error(
      "AGENT_TASK_MANAGER_COORDINATION_DIRECTORY must be an absolute path",
    );
  return value;
}

/** Encodes select labels as Notion option objects. */
function selectOptions(names: readonly string[]): JsonObject[] {
  return names.map((name) => ({ name }));
}

/** Requires a JSON string and preserves the empty-string contract. */
function jsonText(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Returns a value or throws the supplied message when it is absent. */
function requirePresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

/** Writes a formatted JSON result to standard output. */
function write(value: JsonValue): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
