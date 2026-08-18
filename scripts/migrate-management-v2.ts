#!/usr/bin/env node
/** One-time Management v2 migration entry point. */
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../src/domain/json.js";
import {
  agentDefinitionMarkdown,
  auditManagedResourceContract,
  LEGACY_PROPERTIES_BY_TABLE,
  MANAGEMENT_V2_DATABASES,
  MANAGEMENT_V2_DATABASE_PAGES,
  MANAGEMENT_V2_PARENT,
  planManagementV2Migration,
  rewriteResource,
  type ManagementInventory,
  type ManagementMigrationPlan,
  type MigrationRow,
  type MigrationTable,
} from "../src/migration/management-v2.js";
import { normalizeNotionId as compactId } from "../src/provider/notion/notion-id.js";
import { NotionProvider } from "../src/provider/notion/notion-provider.js";
import {
  NOTION_SCHEMA_DIGEST,
  notionTable,
} from "../src/provider/notion/notion-schema.js";
import {
  asObject,
  collectNotionPages,
  NotionApiError,
  NotionHttpTransport,
  type NotionTransport,
} from "../src/provider/notion/notion-transport.js";

interface Arguments {
  readonly activeAgentsId: string | null;
  readonly apply: boolean;
  readonly expectedDigest: string | null;
  readonly plan: boolean;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.plan === args.apply)
    throw new Error("Specify exactly one of --plan or --apply");
  if (args.apply && args.expectedDigest === null)
    throw new Error("--apply requires --expected-plan-digest");
  const token = process.env.NOTION_TOKEN;
  if (token === undefined || token.trim() === "")
    throw new Error("NOTION_TOKEN is required");
  const transport = new NotionHttpTransport({ token });
  const inventory = await readManagementInventory(
    transport,
    args.activeAgentsId,
  );
  const plan = planManagementV2Migration(inventory);
  if (args.plan) {
    write(toJsonValue({ mode: "plan", plan, summary: summarize(inventory) }));
    return;
  }
  if (plan.digest !== args.expectedDigest)
    throw new Error(
      `Migration plan drifted: expected ${args.expectedDigest}, observed ${plan.digest}`,
    );
  const report = await applyMigration(transport, inventory, plan);
  write(report);
}

export async function readManagementInventory(
  transport: NotionTransport,
  activeAgentsId: string | null,
): Promise<ManagementInventory> {
  const resolvedActiveAgentsId = await resolveActiveAgentsId(
    transport,
    activeAgentsId,
  );
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

export async function resolveActiveAgentsId(
  transport: NotionTransport,
  suppliedId: string | null,
): Promise<string | null> {
  if (suppliedId !== null) {
    await assertActiveAgentsIdentity(transport, suppliedId);
    return compactId(suppliedId);
  }
  const children = await collectNotionPages((cursor) =>
    transport.request({
      method: "GET",
      path: `/v1/blocks/${MANAGEMENT_V2_PARENT}/children?page_size=100${
        cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`
      }`,
    }),
  );
  const databaseIds = children
    .filter((child) => {
      if (child.type !== "child_database" || child.in_trash === true)
        return false;
      const value = asObject(
        required(child.child_database, "Child database is missing"),
        "Child database",
      );
      return text(value.title) === "Active Agents";
    })
    .map((child) => compactId(text(child.id)));
  if (databaseIds.length > 1)
    throw new Error(
      "Multiple Active Agents databases exist under Management v2",
    );
  const databaseId = databaseIds[0];
  if (databaseId === undefined) return null;
  const database = await activeAgentsDatabase(transport, databaseId);
  const sources = Array.isArray(database.data_sources)
    ? database.data_sources.map((value) =>
        compactId(text(asObject(value, "Active Agents data source").id)),
      )
    : [];
  if (sources.length !== 1)
    throw new Error(
      "Active Agents database must contain exactly one data source",
    );
  await assertActiveAgentsIdentity(transport, sources[0]!);
  return sources[0]!;
}

async function assertActiveAgentsIdentity(
  transport: NotionTransport,
  dataSourceId: string,
): Promise<void> {
  const source = await transport.request({
    method: "GET",
    path: `/v1/data_sources/${compactId(dataSourceId)}`,
  });
  const parent = asObject(
    required(source.parent, "Active Agents data source parent is missing"),
    "Active Agents data source parent",
  );
  const databaseId = compactId(text(parent.database_id));
  const database = await activeAgentsDatabase(transport, databaseId);
  const sources = Array.isArray(database.data_sources)
    ? database.data_sources.map((value) =>
        compactId(text(asObject(value, "Active Agents data source").id)),
      )
    : [];
  if (!sources.includes(compactId(dataSourceId)))
    throw new Error(
      "Active Agents data source does not belong to its database",
    );
}

async function activeAgentsDatabase(
  transport: NotionTransport,
  databaseId: string,
): Promise<JsonObject> {
  const database = await transport.request({
    method: "GET",
    path: `/v1/databases/${compactId(databaseId)}`,
  });
  const parent = asObject(
    required(database.parent, "Active Agents database parent is missing"),
    "Active Agents database parent",
  );
  const title = Array.isArray(database.title)
    ? database.title
        .map((value) => text(asObject(value, "Database title").plain_text))
        .join("")
    : "";
  if (
    parent.type !== "page_id" ||
    compactId(text(parent.page_id)) !== MANAGEMENT_V2_PARENT ||
    title !== "Active Agents"
  )
    throw new Error(
      "Active Agents database must have the exact Management v2 parent and title",
    );
  return database;
}

async function applyMigration(
  transport: NotionTransport,
  inventory: ManagementInventory,
  authorizedPlan: ManagementMigrationPlan,
): Promise<JsonValue> {
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
  const authorizedKinds = new Set(
    authorizedPlan.actions.map((action) => action.kind),
  );
  const provider = new NotionProvider(environment, transport);
  let tables = Object.fromEntries(
    Object.entries(environment.tables).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  if (
    authorizedKinds.has("add_v2_schema") ||
    authorizedKinds.has("create_active_agents")
  ) {
    const additivePlan = await provider.planWorkspace("management-v2");
    tables = await provider.applyWorkspacePlan(additivePlan);
  }
  const activeAgentsId = tables.activeAgents ?? inventory.activeAgents?.id;
  if (activeAgentsId === undefined)
    throw new Error("Active Agents was not created or discovered");

  const resourceKeyById = new Map(
    inventory.resources.rows.map((row) => [compactId(row.id), row.title]),
  );
  const expectedBodies = new Map<string, string>();

  for (const action of authorizedPlan.actions.filter(
    (entry) => entry.kind === "rewrite_resource",
  )) {
    const row = inventory.resources.rows.find(
      (entry) => entry.id === action.targetId,
    )!;
    const body = rewriteResource(row.title, row.body);
    const forbidden = auditManagedResourceContract(body);
    if (forbidden.length > 0)
      throw new Error(
        `Managed Resource contract audit failed for ${row.title}: ${forbidden.join(", ")}`,
      );
    expectedBodies.set(compactId(row.id), body);
    await replaceMarkdown(transport, row.id, row.body, body);
  }
  for (const action of authorizedPlan.actions.filter(
    (entry) => entry.kind === "convert_agent",
  )) {
    const row = inventory.agents.rows.find(
      (entry) => entry.id === action.targetId,
    )!;
    const relationValue = row.properties.Resources;
    const resourceKeys = Array.isArray(relationValue)
      ? relationValue.map((value) =>
          required(
            resourceKeyById.get(compactId(text(value))),
            `Missing related Resource ${text(value)}`,
          ),
        )
      : [];
    const body = agentDefinitionMarkdown(row, resourceKeys);
    expectedBodies.set(compactId(row.id), body);
    await replaceMarkdown(transport, row.id, row.body, body);
  }

  await assertInventoryState(
    transport,
    inventory,
    activeAgentsId,
    expectedBodies,
    new Set(),
    true,
  );

  const archivedIds = new Set(
    authorizedPlan.actions
      .filter(
        (entry) =>
          entry.kind === "archive_error" || entry.kind === "archive_resource",
      )
      .map((entry) => compactId(entry.targetId)),
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
  if (authorizedKinds.has("add_v2_schema")) await configureSelects(transport);
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

  const finalInventory = await readManagementInventory(
    transport,
    activeAgentsId,
  );
  const finalPlan = planManagementV2Migration({
    ...finalInventory,
    operations: null,
  });
  const validation = await new NotionProvider(
    {
      ...environment,
      tables: { ...environment.tables, activeAgents: activeAgentsId },
    },
    transport,
  ).validateWorkspace();
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

async function readTable(
  transport: NotionTransport,
  id: string,
): Promise<MigrationTable> {
  const source = await transport.request({
    method: "GET",
    path: `/v1/data_sources/${compactId(id)}`,
  });
  const schema = asObject(
    required(source.properties, "Data source properties are missing"),
    "Data source properties",
  );
  const properties = Object.fromEntries(
    Object.entries(schema).map(([name, value]) => [
      name,
      text(asObject(value, name).type),
    ]),
  );
  const pages = await collectNotionPages((cursor) =>
    transport.request({
      body: {
        page_size: 100,
        ...(cursor === null ? {} : { start_cursor: cursor }),
      },
      method: "POST",
      path: `/v1/data_sources/${compactId(id)}/query`,
    }),
  );
  const rows = await Promise.all(
    pages.map(async (page) => pageToRow(transport, page)),
  );
  return { id: compactId(id), properties, rows };
}
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
async function pageToRow(
  transport: NotionTransport,
  page: JsonObject,
): Promise<MigrationRow> {
  const rawProperties = asObject(
    required(page.properties, "Page properties are missing"),
    "Page properties",
  );
  const properties = Object.fromEntries(
    Object.entries(rawProperties).map(([name, value]) => [
      name,
      decodeProperty(asObject(value, name)),
    ]),
  );
  const titleEntry = Object.values(rawProperties).find(
    (value) => asObject(value, "Page property").type === "title",
  );
  const bodyResult = await transport.request({
    method: "GET",
    path: `/v1/pages/${compactId(text(page.id))}/markdown`,
  });
  return {
    body: text(bodyResult.markdown).replace(/\r\n?/gu, "\n").normalize("NFC"),
    id: text(page.id),
    properties,
    title:
      titleEntry === undefined ? "" : decodeText(asObject(titleEntry, "Title")),
  };
}
function decodeProperty(property: JsonObject): JsonValue {
  const type = text(property.type);
  if (type === "title" || type === "rich_text") return decodeText(property);
  if (type === "checkbox") return property.checkbox === true;
  if (type === "number")
    return typeof property.number === "number" ? property.number : null;
  if (type === "select") {
    const value = property.select;
    return value === null || value === undefined
      ? null
      : text(asObject(value, "Select").name);
  }
  if (type === "relation")
    return Array.isArray(property.relation)
      ? property.relation.map((entry) => text(asObject(entry, "Relation").id))
      : [];
  if (type === "date") {
    const value = property.date;
    return value === null || value === undefined
      ? null
      : text(asObject(value, "Date").start);
  }
  return null;
}
function decodeText(property: JsonObject): string {
  const value = property.type === "title" ? property.title : property.rich_text;
  return Array.isArray(value)
    ? value
        .map((entry) => text(asObject(entry, "Rich text").plain_text))
        .join("")
    : "";
}

async function configureSelects(transport: NotionTransport): Promise<void> {
  await patchProperties(transport, MANAGEMENT_V2_DATABASES.errors, {
    Source: selectSchema("errors", "Source"),
    Status: selectSchema("errors", "Status"),
  });
  await patchProperties(transport, MANAGEMENT_V2_DATABASES.resources, {
    Kind: selectSchema("resources", "Kind"),
  });
}
function selectSchema(kind: "errors" | "resources", name: string): JsonObject {
  const descriptor = notionTable(kind).properties.find(
    (property) => property.name === name && property.type === "select",
  );
  if (descriptor === undefined)
    throw new Error(`Canonical select property is missing: ${kind}.${name}`);
  return { select: { options: options(descriptor.options) } };
}
async function dropLegacyProperties(transport: NotionTransport): Promise<void> {
  for (const [kind, names] of Object.entries(LEGACY_PROPERTIES_BY_TABLE)) {
    const sourceId =
      MANAGEMENT_V2_DATABASES[kind as keyof typeof LEGACY_PROPERTIES_BY_TABLE];
    const source = await transport.request({
      method: "GET",
      path: `/v1/data_sources/${compactId(sourceId)}`,
    });
    const observed = asObject(
      required(source.properties, "Data source properties are missing"),
      "Data source properties",
    );
    const properties = Object.fromEntries(
      names
        .filter((name) => observed[name] !== undefined)
        .map((name) => [name, null]),
    );
    if (Object.keys(properties).length > 0)
      await patchProperties(transport, sourceId, properties);
  }
}
async function patchProperties(
  transport: NotionTransport,
  sourceId: string,
  properties: JsonObject,
): Promise<void> {
  await transport.request({
    body: { properties },
    method: "PATCH",
    path: `/v1/data_sources/${compactId(sourceId)}`,
  });
}
export async function replaceMarkdown(
  transport: NotionTransport,
  pageId: string,
  expectedMarkdown: string,
  markdown: string,
): Promise<void> {
  await transport.request({
    body: {
      type: "update_content",
      update_content: { new_str: markdown, old_str: expectedMarkdown },
    },
    method: "PATCH",
    path: `/v1/pages/${compactId(pageId)}/markdown`,
  });
}

async function assertInventoryState(
  transport: NotionTransport,
  original: ManagementInventory,
  activeAgentsId: string,
  expectedBodies: ReadonlyMap<string, string>,
  archivedIds: ReadonlySet<string>,
  includeOperations: boolean,
): Promise<void> {
  const current = await readManagementInventory(transport, activeAgentsId);
  for (const kind of ["agents", "errors", "resources", "tasks"] as const) {
    const before = original[kind];
    const after = current[kind];
    for (const [name, type] of Object.entries(before.properties))
      if (after.properties[name] !== type)
        throw new Error(
          `Migration drift detected before destructive cleanup: ${kind}.${name}`,
        );
    const expectedRows = before.rows.filter(
      (row) => !archivedIds.has(compactId(row.id)),
    );
    if (after.rows.length !== expectedRows.length)
      throw new Error(
        `Migration drift detected before destructive cleanup: ${kind} row set`,
      );
    const byId = new Map(
      after.rows.map((row) => [compactId(row.id), row] as const),
    );
    for (const expected of expectedRows) {
      const id = compactId(expected.id);
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
    const observed = current.operations;
    if (
      observed === null ||
      observed.rows.length !== original.operations.rows.length
    )
      throw new Error(
        "Migration drift detected before destructive cleanup: operations row set",
      );
    const byId = new Map(
      observed.rows.map((row) => [compactId(row.id), row] as const),
    );
    for (const expected of original.operations.rows) {
      const row = byId.get(compactId(expected.id));
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
async function archivePage(
  transport: NotionTransport,
  pageId: string,
): Promise<void> {
  await transport.request({
    body: { in_trash: true },
    method: "PATCH",
    path: `/v1/pages/${compactId(pageId)}`,
  });
}

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
function parseArguments(argv: readonly string[]): Arguments {
  let plan = false;
  let apply = false;
  let expectedDigest: string | null = null;
  let activeAgentsId: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--plan") plan = true;
    else if (value === "--apply") apply = true;
    else if (value === "--expected-plan-digest")
      expectedDigest = required(argv[++index], value);
    else if (value === "--active-agents-id")
      activeAgentsId = required(argv[++index], value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return { activeAgentsId, apply, expectedDigest, plan };
}
function options(names: readonly string[]): JsonObject[] {
  return names.map((name) => ({ name }));
}
function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}
function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
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
