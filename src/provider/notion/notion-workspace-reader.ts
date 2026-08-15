// Converts live Notion data-source metadata into canonical provider schema snapshots.
import { digestJson } from "../../core/digest.js";
import { compareWorkspaceSchema } from "../../core/schema-diff.js";
import { toJsonValue, type JsonObject, type JsonValue } from "../../domain/json.js";
import {
  TABLE_KINDS,
  type ProviderCapabilities,
  type ProviderEnvironment,
  type TableKind,
  type ValidationIssue,
  type ValidationReport,
} from "../../domain/provider.js";
import type {
  ObservedProperty,
  ObservedTable,
  TableValidationReport,
  WorkspaceSchemaDescriptor,
  WorkspaceSchemaSnapshot,
} from "../../domain/schema.js";
import { NotionApiError, type NotionTransport } from "./notion-transport.js";

const READ_ONLY_TYPES = new Set([
  "created_by",
  "created_time",
  "formula",
  "last_edited_by",
  "last_edited_time",
  "rollup",
  "unique_id",
]);

export class NotionWorkspaceReader {
  public constructor(
    private readonly environment: ProviderEnvironment,
    private readonly target: WorkspaceSchemaDescriptor,
    private readonly transport: NotionTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public getCapabilities(): ProviderCapabilities {
    return {
      archive: true,
      attachments: true,
      conditionalWrites: "optimistic",
      deterministicPagination: true,
      idempotencyLookup: true,
      leases: "advisory",
      managedContent: true,
      relations: true,
      schemaDiscovery: true,
      schemaMutation: true,
      stableRecordIds: true,
    };
  }

  public validateEnvironment(): ValidationReport {
    const issues: ValidationIssue[] = [];
    if (this.environment.type !== "notion") {
      issues.push(issue("unsupported_provider_type", "provider.type", "Notion provider requires type notion"));
    }
    const authEnvironmentVariable = this.environment.connection.authEnvironmentVariable;
    if (typeof authEnvironmentVariable !== "string" || authEnvironmentVariable.trim() === "") {
      issues.push(
        issue(
          "missing_auth_environment_variable",
          "provider.connection.authEnvironmentVariable",
          "Notion connection must name the environment variable containing its integration token",
        ),
      );
    }
    return { issues, valid: issues.length === 0 };
  }

  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    const identity = await this.transport.request({ method: "GET", path: "/v1/users/me" });
    const providerIdentity = identityString(identity);
    const resolved = new Map<TableKind, string>();
    for (const kind of TABLE_KINDS) {
      const configured = this.environment.tables[kind];
      if (configured !== null) resolved.set(kind, await this.resolveDataSourceId(configured));
    }

    const tables: ObservedTable[] = [];
    for (const kind of TABLE_KINDS) {
      const id = resolved.get(kind);
      if (id === undefined) continue;
      const source = await this.transport.request({ method: "GET", path: `/v1/data_sources/${id}` });
      tables.push(this.observedTable(kind, source));
    }
    const normalized = tables
      .map((table) => ({
        ...table,
        managedRanges: [...table.managedRanges].sort(),
        properties: [...table.properties].sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => left.kind?.localeCompare(right.kind ?? "") ?? -1);
    return {
      capturedAt: this.now().toISOString(),
      digest: digestJson(toJsonValue(normalized)),
      providerIdentity,
      tables: normalized,
    };
  }

  public async validateTables(): Promise<TableValidationReport> {
    return compareWorkspaceSchema(await this.inspectWorkspaceSchema(), this.target);
  }

  public async resolveDataSourceId(identifier: string): Promise<string> {
    const id = normalizeNotionIdentifier(identifier);
    try {
      const source = await this.transport.request({ method: "GET", path: `/v1/data_sources/${id}` });
      if (source.object === "data_source") return requiredString(source.id, "data source id");
    } catch (error) {
      if (!(error instanceof NotionApiError) || error.status !== 404) throw error;
    }
    const database = await this.transport.request({ method: "GET", path: `/v1/databases/${id}` });
    const sources = database.data_sources;
    if (!Array.isArray(sources) || sources.length !== 1) {
      throw new Error(`Notion database ${id} must contain exactly one data source`);
    }
    const source = objectAt(sources, 0, "database data source");
    return requiredString(source.id, "database data source id");
  }

  private observedTable(kind: TableKind, source: JsonObject): ObservedTable {
    if (source.object !== "data_source") throw new TypeError(`Configured ${kind} table is not a data source`);
    const id = requiredString(source.id, `${kind} data source id`);
    const properties = objectValue(source.properties, `${kind} properties`);
    return {
      id,
      kind,
      managedRanges: [],
      properties: Object.entries(properties).map(([name, value]) =>
        this.observedProperty(name, objectValue(value, `${kind}.${name}`)),
      ),
      title: richText(source.title),
      version: typeof source.last_edited_time === "string" ? source.last_edited_time : id,
    };
  }

  private observedProperty(name: string, property: JsonObject): ObservedProperty {
    const type = requiredString(property.type, `property ${name} type`);
    const details = property[type];
    const relationDetails = type === "relation" && details !== undefined
      ? objectValue(details, `property ${name} relation`)
      : null;
    const target = relationDetails?.data_source_id ?? relationDetails?.database_id;
    return {
      name,
      providerMetadata: objectValue(toJsonValue(property), `property ${name}`),
      targetTableId: typeof target === "string" ? target : null,
      type,
      writable: !READ_ONLY_TYPES.has(type),
    };
  }
}

export function normalizeNotionIdentifier(value: string): string {
  const decoded = decodeURIComponent(value.trim());
  const match = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/iu.exec(decoded);
  if (match?.[1] === undefined) throw new TypeError("Notion identifier must contain a page, database, or data-source UUID");
  const compact = match[1].replaceAll("-", "").toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function identityString(value: JsonObject): string {
  const id = requiredString(value.id, "Notion bot id");
  const bot = value.bot;
  if (bot === null || bot === undefined) return id;
  const workspace = objectValue(bot, "Notion bot").workspace_name;
  return typeof workspace === "string" && workspace !== "" ? `${id}:${workspace}` : id;
}

function richText(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const object = objectValue(item, "rich text item");
      return typeof object.plain_text === "string" ? object.plain_text : "";
    })
    .join("");
}

function objectAt(value: readonly JsonValue[], index: number, label: string): JsonObject {
  const item = value[index];
  if (item === undefined) throw new TypeError(`${label} is missing`);
  return objectValue(item, label);
}

function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, message, path, severity: "error" };
}
