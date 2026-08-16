/** Converts live Notion data-source metadata into canonical provider schema snapshots. */
import { digestJson } from "../../core/digest.js";
import { compareWorkspaceSchema } from "../../core/schema-diff.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../domain/json.js";
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

/** Defines the module-level `READ_ONLY_TYPES` value. */
const READ_ONLY_TYPES = new Set([
  "created_by",
  "created_time",
  "formula",
  "last_edited_by",
  "last_edited_time",
  "rollup",
  "unique_id",
]);

/** Implements Notion workspace reader. */
export class NotionWorkspaceReader {
  /** Initializes Notion workspace reader. */
  public constructor(
    /** Contains environment for Notion workspace reader. */ private readonly environment: ProviderEnvironment,
    /** Contains target for Notion workspace reader. */ private readonly target: WorkspaceSchemaDescriptor,
    /** Contains transport for Notion workspace reader. */ private readonly transport: NotionTransport,
    /** Contains now for Notion workspace reader. */ private readonly now: () => Date = () =>
      new Date(),
  ) {}

  /** Returns capabilities. */
  public getCapabilities(): ProviderCapabilities {
    return {
      archive: true,
      attachments: false,
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

  /** Validates environment. */
  public validateEnvironment(): ValidationReport {
    /** Tracks the `issues` condition in `validateEnvironment`. */
    const issues: ValidationIssue[] = [];
    if (this.environment.type !== "notion") {
      issues.push(
        issue(
          "unsupported_provider_type",
          "provider.type",
          "Notion provider requires type notion",
        ),
      );
    }
    /** Holds the `authEnvironmentVariable` intermediate used by `validateEnvironment`. */
    const authEnvironmentVariable =
      this.environment.connection.authEnvironmentVariable;
    if (
      typeof authEnvironmentVariable !== "string" ||
      authEnvironmentVariable.trim() === ""
    ) {
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

  /** Inspects workspace schema without mutation. */
  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    /** Holds the `identity` intermediate used by `inspectWorkspaceSchema`. */
    const identity = await this.transport.request({
      method: "GET",
      path: "/v1/users/me",
    });
    /** Holds the `providerIdentity` intermediate used by `inspectWorkspaceSchema`. */
    const providerIdentity = identityString(identity);
    /** Indexes entries in `resolved` for `inspectWorkspaceSchema`. */
    const resolved = new Map<TableKind, string>();
    for (const kind of TABLE_KINDS) {
      /** Holds the `configured` intermediate used by `inspectWorkspaceSchema`. */
      const configured = this.environment.tables[kind];
      if (configured !== null)
        resolved.set(kind, await this.resolveDataSourceId(configured));
    }
    /** Holds the `ids` intermediate used by `inspectWorkspaceSchema`. */
    const ids = [...resolved.values()];
    if (new Set(ids).size !== ids.length) {
      /** Holds the `duplicates` intermediate used by `inspectWorkspaceSchema`. */
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      throw new Error(
        `Logical Notion tables must use distinct data sources; duplicated: ${[...new Set(duplicates)].join(", ")}`,
      );
    }

    /** Holds the `tables` intermediate used by `inspectWorkspaceSchema`. */
    const tables: ObservedTable[] = [];
    for (const kind of TABLE_KINDS) {
      /** Holds the `id` intermediate used by `inspectWorkspaceSchema`. */
      const id = resolved.get(kind);
      if (id === undefined) continue;
      /** Holds the `source` intermediate used by `inspectWorkspaceSchema`. */
      const source = await this.transport.request({
        method: "GET",
        path: `/v1/data_sources/${id}`,
      });
      tables.push(this.observedTable(kind, source));
    }
    /** Holds the `normalized` intermediate used by `inspectWorkspaceSchema`. */
    const normalized = tables
      .map((table) => ({
        ...table,
        managedRanges: [...table.managedRanges].sort(),
        properties: [...table.properties].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      }))
      .sort((left, right) => left.kind?.localeCompare(right.kind ?? "") ?? -1);
    return {
      capturedAt: this.now().toISOString(),
      digest: notionSchemaDigest(normalized),
      providerIdentity,
      tables: normalized,
    };
  }

  /** Validates tables. */
  public async validateTables(): Promise<TableValidationReport> {
    return compareWorkspaceSchema(
      await this.inspectWorkspaceSchema(),
      this.target,
    );
  }

  /** Resolves data source ID. */
  public async resolveDataSourceId(identifier: string): Promise<string> {
    /** Holds the `id` intermediate used by `resolveDataSourceId`. */
    const id = normalizeNotionIdentifier(identifier);
    try {
      /** Holds the `source` intermediate used by `resolveDataSourceId`. */
      const source = await this.transport.request({
        method: "GET",
        path: `/v1/data_sources/${id}`,
      });
      if (source.object === "data_source")
        return requiredString(source.id, "data source id");
    } catch (error) {
      if (!(error instanceof NotionApiError) || error.status !== 404)
        throw error;
    }
    /** Holds the `database` intermediate used by `resolveDataSourceId`. */
    const database = await this.transport.request({
      method: "GET",
      path: `/v1/databases/${id}`,
    });
    /** Holds the `sources` intermediate used by `resolveDataSourceId`. */
    const sources = database.data_sources;
    if (!Array.isArray(sources) || sources.length !== 1) {
      throw new Error(
        `Notion database ${id} must contain exactly one data source`,
      );
    }
    /** Holds the `source` intermediate used by `resolveDataSourceId`. */
    const source = objectAt(sources, 0, "database data source");
    return requiredString(source.id, "database data source id");
  }

  /** Projects a target table into observed workspace metadata. */
  private observedTable(kind: TableKind, source: JsonObject): ObservedTable {
    if (source.object !== "data_source")
      throw new TypeError(`Configured ${kind} table is not a data source`);
    /** Holds the `id` intermediate used by `observedTable`. */
    const id = requiredString(source.id, `${kind} data source id`);
    /** Holds the `properties` intermediate used by `observedTable`. */
    const properties = objectValue(source.properties, `${kind} properties`);
    return {
      id,
      kind,
      managedRanges: [],
      properties: Object.entries(properties).map(([name, value]) =>
        this.observedProperty(name, objectValue(value, `${kind}.${name}`)),
      ),
      title: richText(source.title),
      version:
        typeof source.last_edited_time === "string"
          ? source.last_edited_time
          : id,
    };
  }

  /** Projects a target property into observed workspace metadata. */
  private observedProperty(
    name: string,
    property: JsonObject,
  ): ObservedProperty {
    /** Holds the `type` intermediate used by `observedProperty`. */
    const type = requiredString(property.type, `property ${name} type`);
    /** Holds the `details` intermediate used by `observedProperty`. */
    const details = property[type];
    /** Holds the `relationDetails` intermediate used by `observedProperty`. */
    const relationDetails =
      type === "relation" && details !== undefined
        ? objectValue(details, `property ${name} relation`)
        : null;
    /** Holds the `target` intermediate used by `observedProperty`. */
    const target =
      relationDetails?.data_source_id ?? relationDetails?.database_id;
    return {
      name,
      providerMetadata: objectValue(toJsonValue(property), `property ${name}`),
      targetTableId: typeof target === "string" ? target : null,
      type,
      writable: !READ_ONLY_TYPES.has(type),
    };
  }
}

/** Decodes Notion schema digest from Notion workspace metadata. */
export function notionSchemaDigest(tables: readonly ObservedTable[]): string {
  /** Indexes entries in `kindsById` for `notionSchemaDigest`. */
  const kindsById = new Map(tables.map((table) => [table.id, table.kind]));
  /** Holds the `semantics` intermediate used by `notionSchemaDigest`. */
  const semantics = tables
    .map((table) => ({
      kind: table.kind,
      managedRanges: [...table.managedRanges].sort(),
      properties: table.properties
        .map((property) => ({
          name: property.name,
          target:
            property.targetTableId === null
              ? null
              : (kindsById.get(property.targetTableId) ??
                `external:${property.targetTableId}`),
          type: property.type,
          writable: property.writable,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      title: table.title,
    }))
    .sort((left, right) => (left.kind ?? "").localeCompare(right.kind ?? ""));
  return digestJson(toJsonValue(semantics));
}

/** Normalizes Notion identifier. */
export function normalizeNotionIdentifier(value: string): string {
  /** Holds the `decoded` intermediate used by `normalizeNotionIdentifier`. */
  const decoded = decodeURIComponent(value.trim());
  /** Holds the `match` intermediate used by `normalizeNotionIdentifier`. */
  const match =
    /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])/iu.exec(
      decoded,
    );
  if (match?.[1] === undefined)
    throw new TypeError(
      "Notion identifier must contain a page, database, or data-source UUID",
    );
  /** Holds the `compact` intermediate used by `normalizeNotionIdentifier`. */
  const compact = match[1].replaceAll("-", "").toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

/** Decodes identity string from Notion workspace metadata. */
function identityString(value: JsonObject): string {
  /** Holds the `id` intermediate used by `identityString`. */
  const id = requiredString(value.id, "Notion bot id");
  /** Holds the `bot` intermediate used by `identityString`. */
  const bot = value.bot;
  if (bot === null || bot === undefined) return id;
  /** Holds the `workspace` intermediate used by `identityString`. */
  const workspace = objectValue(bot, "Notion bot").workspace_name;
  return typeof workspace === "string" && workspace !== ""
    ? `${id}:${workspace}`
    : id;
}

/** Converts text. */
function richText(value: JsonValue | undefined): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      /** Holds the `object` intermediate used by `richText`. */
      const object = objectValue(item, "rich text item");
      return typeof object.plain_text === "string" ? object.plain_text : "";
    })
    .join("");
}

/** Decodes object at from Notion workspace metadata. */
function objectAt(
  value: readonly JsonValue[],
  index: number,
  label: string,
): JsonObject {
  /** Holds the `item` intermediate used by `objectAt`. */
  const item = value[index];
  if (item === undefined) throw new TypeError(`${label} is missing`);
  return objectValue(item, label);
}

/** Returns a validated JSON object. */
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

/** Returns a required non-empty string or throws. */
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Creates an error-severity validation issue. */
function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, message, path, severity: "error" };
}
