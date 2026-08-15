// Plans, applies, and reconciles additive Notion workspace bootstrap operations.
import { canonicalize } from "../../core/canonical-json.js";
import { finalizeMigrationPlan } from "../../core/migration-plan.js";
import { compareWorkspaceSchema } from "../../core/schema-diff.js";
import { sha256 } from "../../core/digest.js";
import { toJsonValue, type JsonObject, type JsonValue } from "../../domain/json.js";
import { TABLE_KINDS, type ProviderEnvironment, type ReconciliationResult, type TableKind, type WriteReceipt } from "../../domain/provider.js";
import type {
  PropertyDescriptor,
  WorkspaceMigrationPlan,
  WorkspaceMigrationStep,
  WorkspaceSchemaDescriptor,
  WorkspaceSchemaRequest,
  WorkspaceSchemaSnapshot,
} from "../../domain/schema.js";
import { NotionPageStore, type NotionMutableTableIds } from "./notion-page-store.js";
import { normalizeNotionIdentifier, notionSchemaDigest, NotionWorkspaceReader } from "./notion-workspace-reader.js";
import { collectNotionPages, type NotionTransport } from "./notion-transport.js";

const TABLE_ORDER: readonly TableKind[] = ["resources", "errors", "tasks", "subAgents"];

export class NotionWorkspaceManager {
  readonly #resolved = new Map<TableKind, string>();

  public constructor(
    private readonly environmentId: string,
    private readonly environment: ProviderEnvironment,
    private readonly target: WorkspaceSchemaDescriptor,
    private readonly transport: NotionTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    await this.resolveTables();
    const reader = new NotionWorkspaceReader(this.resolvedEnvironment(), this.target, this.transport, this.now);
    return reader.inspectWorkspaceSchema();
  }

  public async planWorkspaceChanges(request: WorkspaceSchemaRequest): Promise<WorkspaceMigrationPlan> {
    if (request.environmentId !== this.environmentId) throw new Error("Workspace request environment does not match manager");
    if (request.target.digest !== this.target.digest) throw new Error("Workspace request target does not match configured target");
    const report = compareWorkspaceSchema(request.observed, request.target);
    if (report.state === "blocked_incompatible") throw new Error("Cannot plan over an incompatible Notion workspace");
    const drafts: Array<Pick<WorkspaceMigrationStep, "id" | "kind" | "payload">> = [];
    for (const kind of TABLE_ORDER) {
      const expected = tableDescriptor(this.target, kind);
      const observed = request.observed.tables.find((table) => table.kind === kind);
      if (observed === undefined) {
        drafts.push({ id: `notion:${this.target.version}:create:${kind}`, kind: "create_table", payload: { kind } });
      } else {
        for (const property of expected.properties.filter((item) => item.targetTable === null)) {
          if (!observed.properties.some((item) => item.name === property.physicalName)) {
            drafts.push({
              id: `notion:${this.target.version}:property:${kind}:${property.physicalName}`,
              kind: "add_property",
              payload: { kind, physicalName: property.physicalName },
            });
          }
        }
      }
    }
    for (const kind of TABLE_ORDER) {
      const expected = tableDescriptor(this.target, kind);
      const observed = request.observed.tables.find((table) => table.kind === kind);
      for (const property of expected.properties.filter((item) => item.targetTable !== null)) {
        if (observed === undefined || !observed.properties.some((item) => item.name === property.physicalName)) {
          drafts.push({
            id: `notion:${this.target.version}:relation:${kind}:${property.physicalName}`,
            kind: "add_relation",
            payload: { kind, physicalName: property.physicalName },
          });
        }
      }
    }
    drafts.push({
      id: `notion:${this.target.version}:schema-state`,
      kind: "record_schema_state",
      payload: { kind: "resources", targetDigest: this.target.digest, targetVersion: this.target.version },
    });

    let simulated = request.observed;
    const steps: WorkspaceMigrationStep[] = [];
    for (const [index, draft] of drafts.entries()) {
      const next = simulateWorkspaceStep(simulated, draft, this.target);
      steps.push({
        dependsOn: index === 0 ? [] : [requiredDraft(drafts[index - 1]).id],
        expectedPostSchemaDigest: next.digest,
        expectedPreSchemaDigest: simulated.digest,
        id: draft.id,
        kind: draft.kind,
        payload: draft.payload,
        reversibility: "additive",
      });
      simulated = next;
    }
    return finalizeMigrationPlan({
      environmentId: request.environmentId,
      mode: request.mode,
      observedSchemaDigest: request.observed.digest,
      parentIdentity: this.environment.bootstrapParent,
      providerIdentity: request.observed.providerIdentity,
      steps,
      targetSchemaDigest: request.target.digest,
      targetSchemaVersion: request.target.version,
    });
  }

  public async applyWorkspaceStep(step: WorkspaceMigrationStep): Promise<WriteReceipt> {
    await this.resolveTables();
    if (this.#resolved.has("resources")) await this.ensureBootstrapRoot();
    const prior = await this.readStepReceipt(step.id);
    if (prior !== null) {
      if (prior.stepDigest !== stepDigest(step)) throw new Error(`Workspace step ${step.id} changed after it was applied`);
      return prior.receipt;
    }
    for (const dependency of step.dependsOn) {
      if ((await this.readStepReceipt(dependency)) === null) throw new Error(`Workspace step dependency is incomplete: ${dependency}`);
    }
    const current = await this.inspectWorkspaceSchema();
    if (current.digest !== step.expectedPreSchemaDigest) throw new Error(`Workspace precondition changed: ${step.id}`);

    if (step.kind === "create_table") await this.createTable(tableKind(step));
    else if (step.kind === "add_property" || step.kind === "add_relation") await this.addProperty(step);
    else if (step.kind === "record_schema_state") await this.recordSchemaState();
    else throw new Error(`Unsupported Notion workspace step: ${step.kind}`);

    const reconciliation = await this.reconcileWorkspaceStep(step.id, step);
    if (reconciliation.state !== "applied") throw new Error(`Workspace step post-verification failed: ${step.id}`);
    const verifiedSnapshot = await this.inspectWorkspaceSchema();
    if (verifiedSnapshot.digest !== step.expectedPostSchemaDigest) throw new Error(`Workspace postcondition changed: ${step.id}`);
    const table = tableKind(step);
    const tableId = requiredResolved(this.#resolved, table);
    const observed = (await this.inspectWorkspaceSchema()).tables.find((candidate) => candidate.kind === table);
    if (observed === undefined) throw new Error(`Workspace step did not produce ${table}`);
    const receipt: WriteReceipt = {
      idempotencyKey: step.id,
      observedVersion: observed.version,
      providerRecord: { id: tableId, table },
      writtenAt: this.now().toISOString(),
    };
    await this.writeStepReceipt(step, receipt);
    return receipt;
  }

  public async reconcileWorkspaceStep(stepId: string, supplied?: WorkspaceMigrationStep): Promise<ReconciliationResult> {
    const stored = await this.readStepReceipt(stepId);
    if (stored !== null) return { evidence: { receipt: toJsonValue(stored.receipt), stepDigest: stored.stepDigest }, state: "applied" };
    if (supplied === undefined) return { evidence: {}, state: "not_applied" };
    await this.resolveTables();
    const kind = tableKind(supplied);
    if (supplied.kind === "create_table") {
      return this.#resolved.has(kind)
        ? { evidence: { dataSourceId: requiredResolved(this.#resolved, kind) }, state: "applied" }
        : { evidence: {}, state: "not_applied" };
    }
    if (supplied.kind === "add_property" || supplied.kind === "add_relation") {
      const physicalName = requiredString(supplied.payload.physicalName, "Workspace property name");
      const table = (await this.inspectWorkspaceSchema()).tables.find((candidate) => candidate.kind === kind);
      const expected = tableDescriptor(this.target, kind).properties.find((item) => item.physicalName === physicalName);
      const observed = table?.properties.find((item) => item.name === physicalName);
      const applied = expected !== undefined && observed !== undefined && observed.type === expected.type && observed.writable === expected.writable;
      return applied ? { evidence: { property: physicalName }, state: "applied" } : { evidence: {}, state: "not_applied" };
    }
    if (supplied.kind === "record_schema_state") {
      const state = await this.readSchemaState();
      return state?.targetDigest === this.target.digest && state.targetVersion === this.target.version
        ? { evidence: state, state: "applied" }
        : { evidence: {}, state: "not_applied" };
    }
    return { evidence: {}, state: "failed" };
  }

  public configuredTablePatch(): Readonly<Record<TableKind, string>> {
    return Object.fromEntries(TABLE_KINDS.map((kind) => [kind, requiredResolved(this.#resolved, kind)])) as unknown as Readonly<Record<TableKind, string>>;
  }

  public async resolveTableIds(): Promise<Partial<Record<TableKind, string>>> {
    await this.resolveTables();
    return Object.fromEntries(this.#resolved) as Partial<Record<TableKind, string>>;
  }

  private async resolveTables(): Promise<void> {
    for (const kind of TABLE_ORDER) {
      if (this.#resolved.has(kind)) continue;
      const configured = this.environment.tables[kind];
      if (configured !== null) {
        const reader = new NotionWorkspaceReader(this.environment, this.target, this.transport, this.now);
        this.#resolved.set(kind, await reader.resolveDataSourceId(configured));
        continue;
      }
      const discovered = await this.discoverTable(kind);
      if (discovered !== null) this.#resolved.set(kind, discovered);
    }
  }

  private async discoverTable(kind: TableKind): Promise<string | null> {
    if (this.environment.bootstrapParent === null) return null;
    const parentId = normalizeNotionIdentifier(this.environment.bootstrapParent);
    const title = tableDescriptor(this.target, kind).title;
    const results = await collectNotionPages((cursor) =>
      this.transport.request({
        body: {
          filter: { property: "object", value: "database" },
          page_size: 100,
          query: title,
          ...(cursor === null ? {} : { start_cursor: cursor }),
        },
        method: "POST",
        path: "/v1/search",
      }),
    );
    const matches = results.filter((database) => database.object === "database" && richText(database.title) === title && parentIdentity(database.parent) === parentId);
    if (matches.length > 1) throw new Error(`Bootstrap parent contains multiple ${title} databases`);
    const database = matches[0];
    if (database === undefined) return null;
    const sources = database.data_sources;
    if (!Array.isArray(sources) || sources.length !== 1) throw new Error(`${title} database must contain exactly one data source`);
    return requiredString(objectValue(requiredValue(sources[0]), `${title} data source`).id, `${title} data source id`);
  }

  private async createTable(kind: TableKind): Promise<void> {
    if (this.#resolved.has(kind)) return;
    if (this.environment.bootstrapParent === null) throw new Error("Notion bootstrap requires provider.bootstrapParent");
    const descriptor = tableDescriptor(this.target, kind);
    const properties = Object.fromEntries(
      descriptor.properties.filter((property) => property.targetTable === null).map((property) => [property.physicalName, propertySchema(property, kind)]),
    );
    const response = await this.transport.request({
      body: {
        initial_data_source: { properties },
        parent: { page_id: normalizeNotionIdentifier(this.environment.bootstrapParent), type: "page_id" },
        title: richTextPayload(descriptor.title),
      },
      method: "POST",
      path: "/v1/databases",
    });
    const sources = response.data_sources;
    if (!Array.isArray(sources) || sources.length !== 1) throw new Error(`Created ${descriptor.title} database did not expose one data source`);
    this.#resolved.set(kind, requiredString(objectValue(requiredValue(sources[0]), "Created data source").id, "Created data source id"));
    if (kind === "resources") await this.ensureBootstrapRoot();
  }

  private async addProperty(step: WorkspaceMigrationStep): Promise<void> {
    const kind = tableKind(step);
    const name = requiredString(step.payload.physicalName, "Workspace property name");
    const descriptor = tableDescriptor(this.target, kind).properties.find((property) => property.physicalName === name);
    if (descriptor === undefined) throw new Error(`Unknown target property ${kind}.${name}`);
    await this.transport.request({
      body: { properties: { [name]: propertySchema(descriptor, kind, this.#resolved) } },
      method: "PATCH",
      path: `/v1/data_sources/${requiredResolved(this.#resolved, kind)}`,
    });
  }

  private async ensureBootstrapRoot(): Promise<void> {
    const resources = requiredResolved(this.#resolved, "resources");
    const pages = this.pageStore();
    const key = "system/bootstrap-root-v1";
    const body = canonicalize(toJsonValue({
      parentIdentity: this.environment.bootstrapParent,
      resourcesDataSourceId: resources,
      schema: "agent-task-manager-bootstrap-root-v1",
    }));
    await pages.createResource({ body, dependencies: [], digest: sha256(body), idempotencyKey: key, key, kind: "system/bootstrap", state: "active", version: "v1" });
  }

  private async recordSchemaState(): Promise<void> {
    const key = `system/schema/${this.target.version}`;
    const body = canonicalize(toJsonValue({ schema: "agent-task-manager-schema-state-v1", targetDigest: this.target.digest, targetVersion: this.target.version }));
    await this.pageStore().createResource({ body, dependencies: [], digest: sha256(body), idempotencyKey: key, key, kind: "system/schema", state: "active", version: "v1" });
  }

  private async readSchemaState(): Promise<JsonObject | null> {
    const key = `system/schema/${this.target.version}`;
    const located = await this.pageStore().findUniqueByTitle("resources", "Resource", key);
    if (located === null) return null;
    return objectValue(toJsonValue(JSON.parse(await this.pageStore().managedText(located.id, "Resource body"))), "Schema state");
  }

  private async readStepReceipt(stepId: string): Promise<{ readonly receipt: WriteReceipt; readonly stepDigest: string } | null> {
    if (!this.#resolved.has("resources")) return null;
    const located = await this.pageStore().findUniqueByTitle("resources", "Resource", stepReceiptKey(stepId));
    if (located === null) return null;
    const value = objectValue(toJsonValue(JSON.parse(await this.pageStore().managedText(located.id, "Resource body"))), "Workspace step receipt");
    return { receipt: parseWriteReceipt(objectValue(value.receipt, "Workspace receipt")), stepDigest: requiredString(value.stepDigest, "Workspace step digest") };
  }

  private async writeStepReceipt(step: WorkspaceMigrationStep, receipt: WriteReceipt): Promise<void> {
    const key = stepReceiptKey(step.id);
    const body = canonicalize(toJsonValue({ receipt, schema: "agent-task-manager-workspace-step-receipt-v1", stepDigest: stepDigest(step) }));
    await this.pageStore().createResource({ body, dependencies: [], digest: sha256(body), idempotencyKey: key, key, kind: "system/workspace-step", state: "active", version: "v1" });
  }

  private pageStore(): NotionPageStore {
    const fallback = "unresolved";
    return new NotionPageStore({
      errors: this.#resolved.get("errors") ?? fallback,
      resources: requiredResolved(this.#resolved, "resources"),
      subAgents: this.#resolved.get("subAgents") ?? fallback,
      tasks: this.#resolved.get("tasks") ?? fallback,
    }, this.transport, this.now);
  }

  private resolvedEnvironment(): ProviderEnvironment {
    return {
      ...this.environment,
      tables: Object.fromEntries(TABLE_KINDS.map((kind) => [kind, this.#resolved.get(kind) ?? null])) as unknown as ProviderEnvironment["tables"],
    };
  }
}

function propertySchema(property: PropertyDescriptor, table: TableKind, resolved?: ReadonlyMap<TableKind, string>): JsonObject {
  if (property.targetTable !== null) {
    if (resolved === undefined) throw new Error(`Relation ${property.physicalName} cannot be created before table resolution`);
    return { relation: { data_source_id: requiredResolved(resolved, property.targetTable), single_property: {} } };
  }
  if (property.type === "title") return { title: {} };
  if (property.type === "rich_text") return { rich_text: {} };
  if (property.type === "number") return { number: { format: "number" } };
  if (property.type === "checkbox") return { checkbox: {} };
  if (property.type === "url") return { url: {} };
  if (property.type === "last_edited_time") return { last_edited_time: {} };
  if (property.type === "select") return { select: { options: selectOptions(table, property.physicalName).map((name) => ({ name })) } };
  if (property.type === "status") return { status: { options: selectOptions(table, property.physicalName).map((name) => ({ name })) } };
  throw new Error(`Unsupported Notion property type: ${property.type}`);
}

function simulateWorkspaceStep(
  snapshot: WorkspaceSchemaSnapshot,
  step: Pick<WorkspaceMigrationStep, "kind" | "payload">,
  target: WorkspaceSchemaDescriptor,
): WorkspaceSchemaSnapshot {
  const kind = tableKind({ ...step, dependsOn: [], expectedPostSchemaDigest: "", expectedPreSchemaDigest: "", id: "simulation", reversibility: "additive" });
  let tables = [...structuredClone(snapshot.tables)];
  if (step.kind === "create_table") {
    if (!tables.some((table) => table.kind === kind)) {
      const descriptor = tableDescriptor(target, kind);
      tables.push({
        id: `planned:${kind}`,
        kind,
        managedRanges: [],
        properties: descriptor.properties.filter((property) => property.targetTable === null).map((property) => ({
          name: property.physicalName,
          providerMetadata: {},
          targetTableId: null,
          type: property.type,
          writable: property.writable,
        })),
        title: descriptor.title,
        version: "planned",
      });
    }
  } else if (step.kind === "add_property" || step.kind === "add_relation") {
    const name = requiredString(step.payload.physicalName, "Workspace property name");
    const descriptor = tableDescriptor(target, kind).properties.find((property) => property.physicalName === name);
    if (descriptor === undefined) throw new Error(`Unknown target property ${kind}.${name}`);
    const targetId = descriptor.targetTable === null ? null : tables.find((table) => table.kind === descriptor.targetTable)?.id;
    if (descriptor.targetTable !== null && targetId === undefined) throw new Error(`Unresolved relation target ${descriptor.targetTable}`);
    tables = tables.map((table) => table.kind !== kind || table.properties.some((property) => property.name === name) ? table : {
      ...table,
      properties: [...table.properties, {
        name,
        providerMetadata: {},
        targetTableId: targetId ?? null,
        type: descriptor.type,
        writable: descriptor.writable,
      }],
    });
  } else if (step.kind !== "record_schema_state") {
    throw new Error(`Unsupported simulated Notion step: ${step.kind}`);
  }
  return { ...snapshot, digest: notionSchemaDigest(tables), tables };
}

function selectOptions(table: TableKind, property: string): readonly string[] {
  if (table === "resources" && property === "State") return ["active", "draft", "retired"];
  if (table === "errors" && property === "Severity") return ["critical", "high", "medium", "low"];
  if (table === "subAgents" && property === "Status") return ["Online", "Offline"];
  if (table === "tasks" && property === "Status") return ["Todo"];
  return [];
}

function tableDescriptor(target: WorkspaceSchemaDescriptor, kind: TableKind) {
  const table = target.tables.find((candidate) => candidate.kind === kind);
  if (table === undefined) throw new Error(`Target schema omits ${kind}`);
  return table;
}

function tableKind(step: WorkspaceMigrationStep): TableKind {
  const kind = requiredString(step.payload.kind, "Workspace step table kind");
  if (!TABLE_KINDS.includes(kind as TableKind)) throw new TypeError(`Invalid workspace table kind: ${kind}`);
  return kind as TableKind;
}

function stepDigest(step: WorkspaceMigrationStep): string { return sha256(canonicalize(toJsonValue(step))); }
function stepReceiptKey(stepId: string): string { return `system/workspace-step/${sha256(stepId)}`; }

function parseWriteReceipt(value: JsonObject): WriteReceipt {
  const providerRecord = objectValue(value.providerRecord, "Provider record");
  const table = requiredString(providerRecord.table, "Provider record table");
  if (!TABLE_KINDS.includes(table as TableKind)) throw new TypeError("Provider record table is invalid");
  return {
    idempotencyKey: requiredString(value.idempotencyKey, "Receipt idempotency key"),
    observedVersion: requiredString(value.observedVersion, "Receipt observed version"),
    providerRecord: { id: requiredString(providerRecord.id, "Provider record id"), table: table as TableKind },
    writtenAt: requiredString(value.writtenAt, "Receipt written at"),
  };
}

function richTextPayload(text: string): JsonValue[] { return [{ text: { content: text }, type: "text" }]; }
function richText(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const object = objectValue(item, "Rich text item");
    return typeof object.plain_text === "string" ? object.plain_text : "";
  }).join("");
}

function parentIdentity(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  const parent = objectValue(value, "Database parent");
  const id = parent.page_id ?? parent.database_id;
  return typeof id === "string" ? normalizeNotionIdentifier(id) : null;
}

function requiredResolved(values: ReadonlyMap<TableKind, string>, kind: TableKind): string {
  const value = values.get(kind);
  if (value === undefined) throw new Error(`Notion ${kind} table is unresolved`);
  return value;
}

function requiredDraft<T>(value: T | undefined): T { if (value === undefined) throw new Error("Migration draft is missing"); return value; }
function requiredValue(value: JsonValue | undefined): JsonValue { if (value === undefined) throw new TypeError("Expected value is missing"); return value; }
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
