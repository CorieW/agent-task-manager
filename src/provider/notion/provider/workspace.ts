/** Notion workspace validation, planning, and additive schema application. */
import { digestJson } from "../../../core/digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../../domain/json.js";
import {
  TABLE_KINDS,
  type ProviderEnvironment,
  type TableKind,
  type ValidationIssue,
  type ValidationReport,
  type WorkspacePlan,
  type WorkspaceStep,
} from "../../../domain/provider.js";
import { normalizeNotionId as normalizeId } from "../notion-id.js";
import {
  NOTION_SCHEMA_DIGEST,
  NOTION_TABLES,
  notionTable,
  type NotionPropertyDescriptor,
  type NotionTableDescriptor,
} from "../notion-schema.js";
import {
  asObject,
  collectNotionPages,
  type NotionTransport,
} from "../notion-transport.js";
import {
  propertyContractMismatch,
  propertySchema,
  requireJsonObject,
  requiredString,
  richTextPayload,
  validationIssue,
} from "./values.js";
import {
  type AgentValidationGateway,
  validateAgentSemantics,
} from "./agent-validation.js";

/** Observed type mismatch for one managed Notion property. */
interface WorkspacePropertyMismatch {
  readonly actual: string;
  readonly property: NotionPropertyDescriptor;
}

/** Non-mutating comparison of one configured table with its canonical schema. */
interface WorkspaceSchemaInspection {
  readonly configured: boolean;
  readonly mismatched: readonly WorkspacePropertyMismatch[];
  readonly missing: readonly NotionPropertyDescriptor[];
  readonly observedProperties: JsonObject | null;
  readonly table: NotionTableDescriptor;
}

/** Owns Notion workspace schema discovery and mutation. */
export class NotionWorkspace {
  public constructor(
    private readonly environment: ProviderEnvironment,
    private readonly transport: NotionTransport,
    private readonly tables: Record<TableKind, string | null>,
    private readonly gateway: AgentValidationGateway,
  ) {}

  /** @inheritdoc */
  public async validateEnvironment(): Promise<ValidationReport> {
    /** Validation issues accumulated without failing the remaining checks. */
    const issues: ValidationIssue[] = [];
    if (this.environment.type !== "notion")
      issues.push(
        validationIssue(
          "provider_type",
          "provider.type",
          "Provider type must be notion",
        ),
      );
    if (this.environment.bootstrapParent === null)
      issues.push(
        validationIssue(
          "bootstrap_parent",
          "provider.bootstrapParent",
          "Bootstrap parent is required",
        ),
      );
    return { issues, valid: issues.length === 0 };
  }

  /** @inheritdoc */
  public async validateWorkspace(): Promise<ValidationReport> {
    /** Validation issues accumulated without failing the remaining checks. */
    const issues: ValidationIssue[] = [];
    for (const inspection of await this.inspectWorkspaceSchema()) {
      /** Canonical managed-table descriptor for the current operation. */
      const { table } = inspection;
      if (!inspection.configured) {
        issues.push(
          validationIssue(
            "missing_table",
            `provider.tables.${table.kind}`,
            `${table.title} is not configured`,
          ),
        );
        continue;
      }
      for (const property of inspection.missing)
        if (property.required)
          issues.push(
            validationIssue(
              "missing_property",
              `${table.title}.${property.name}`,
              "Required property is missing",
            ),
          );
      for (const { actual, property } of inspection.mismatched)
        issues.push(
          validationIssue(
            "property_type",
            `${table.title}.${property.name}`,
            `Expected ${property.type}, received ${actual}`,
          ),
        );
    }
    await validateAgentSemantics(this.gateway, this.tables, issues);
    return { issues, valid: issues.length === 0 };
  }

  /** @inheritdoc */
  public async planWorkspace(environmentId: string): Promise<WorkspacePlan> {
    await this.discoverManagedTables();
    /** Ordered workspace mutations authorized by the plan. */
    const steps: WorkspaceStep[] = [];
    /** Exact provider state from which the additive plan is derived. */
    const inspections = await this.inspectWorkspaceSchema();
    for (const inspection of inspections) {
      /** Canonical managed-table descriptor for the current operation. */
      const { table } = inspection;
      if (!inspection.configured) {
        steps.push({
          id: `create:${table.kind}`,
          kind: "create_table",
          payload: { title: table.title },
          table: table.kind,
        });
        for (const property of table.properties.filter(
          (entry) => entry.relation !== null,
        ))
          steps.push({
            id: `property:${table.kind}:${property.name}`,
            kind: "add_property",
            payload: { name: property.name },
            table: table.kind,
          });
        continue;
      }
      if (inspection.mismatched.length > 0) {
        /** First incompatible schema property that blocks planning. */
        const mismatch = inspection.mismatched[0]!;
        throw new Error(
          `Cannot plan incompatible property ${table.title}.${mismatch.property.name}: expected ${mismatch.property.type}, received ${mismatch.actual}`,
        );
      }
      for (const property of inspection.missing)
        steps.push({
          id: `property:${table.kind}:${property.name}`,
          kind: "add_property",
          payload: { name: property.name },
          table: table.kind,
        });
    }
    /** Serialized fields covered by the deterministic digest. */
    const core = {
      environmentId,
      observedSchemaDigest: this.workspaceInspectionDigest(inspections),
      schema: "workspace-plan-v1" as const,
      steps,
      target: this.workspaceTarget(),
      targetSchemaDigest: NOTION_SCHEMA_DIGEST,
    };
    return { ...core, digest: digestJson(toJsonValue(core)) };
  }

  /** Reuses uniquely named managed databases already created under the bootstrap page. */
  private async discoverManagedTables(): Promise<void> {
    if (
      this.environment.bootstrapParent === null ||
      TABLE_KINDS.every((kind) => this.tables[kind] !== null)
    )
      return;
    /** Non-trashed child databases beneath the configured bootstrap page. */
    const children = await collectNotionPages((cursor) =>
      this.transport.request({
        method: "GET",
        path: `/v1/blocks/${normalizeId(this.environment.bootstrapParent!)}/children?page_size=100${
          cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`
        }`,
      }),
    );
    for (const table of NOTION_TABLES) {
      if (this.tables[table.kind] !== null) continue;
      /** Existing databases with the exact canonical managed title. */
      const matches = children.filter((child) => {
        if (child.type !== "child_database" || child.in_trash === true)
          return false;
        return (
          requiredString(
            requireJsonObject(child.child_database, "Child database").title,
            "Child database title",
          ) === table.title
        );
      });
      if (matches.length > 1)
        throw new Error(
          `Multiple ${table.title} databases exist under the bootstrap page`,
        );
      /** Unique child database matching the canonical managed title. */
      const match = matches[0];
      if (match === undefined) continue;
      /** Database metadata used to resolve its unique data source. */
      const database = await this.transport.request({
        method: "GET",
        path: `/v1/databases/${normalizeId(requiredString(match.id, "Child database id"))}`,
      });
      if (
        !Array.isArray(database.data_sources) ||
        database.data_sources.length !== 1
      )
        throw new Error(
          `${table.title} database must contain exactly one data source`,
        );
      this.tables[table.kind] = requiredString(
        requireJsonObject(database.data_sources[0], "Managed data source").id,
        "Managed data source id",
      );
    }
  }

  /** Compares configured Notion data sources with the canonical schema. */
  private async inspectWorkspaceSchema(): Promise<
    readonly WorkspaceSchemaInspection[]
  > {
    /** Schema inspection results accumulated in canonical table order. */
    const inspections: WorkspaceSchemaInspection[] = [];
    for (const table of NOTION_TABLES) {
      /** Provider-owned record identifier. */
      const id = this.tables[table.kind];
      if (id === null) {
        inspections.push({
          configured: false,
          mismatched: [],
          missing: table.properties,
          observedProperties: null,
          table,
        });
        continue;
      }
      /** Current data-source schema returned by Notion. */
      const source = await this.transport.request({
        method: "GET",
        path: `/v1/data_sources/${normalizeId(id)}`,
      });
      /** Provider properties encoded or decoded for the current record. */
      const properties = requireJsonObject(
        source.properties,
        `${table.title} properties`,
      );
      /** Canonical properties absent from the observed schema. */
      const missing: NotionPropertyDescriptor[] = [];
      /** Configured properties whose Notion types differ from the canonical schema. */
      const mismatched: WorkspacePropertyMismatch[] = [];
      for (const property of table.properties) {
        /** Observed provider value compared with the canonical expectation. */
        const observed = properties[property.name];
        if (observed === undefined) {
          missing.push(property);
          continue;
        }
        /** Complete observed property contract compared with the canonical schema. */
        const actual = propertyContractMismatch(
          property,
          requireJsonObject(observed, property.name),
          this.tables,
        );
        if (actual !== null) mismatched.push({ actual, property });
      }
      inspections.push({
        configured: true,
        mismatched,
        missing,
        observedProperties: properties,
        table,
      });
    }
    return inspections;
  }

  /** @inheritdoc */
  public async applyWorkspacePlan(
    plan: WorkspacePlan,
  ): Promise<Readonly<Record<string, string>>> {
    /** Serialized fields covered by the deterministic digest. */
    const core = {
      environmentId: plan.environmentId,
      observedSchemaDigest: plan.observedSchemaDigest,
      schema: plan.schema,
      steps: plan.steps,
      target: plan.target,
      targetSchemaDigest: plan.targetSchemaDigest,
    };
    if (plan.digest !== digestJson(toJsonValue(core)))
      throw new Error("Workspace plan digest is invalid");
    if (
      digestJson(toJsonValue(plan.target)) !==
      digestJson(toJsonValue(this.workspaceTarget()))
    )
      throw new Error("Workspace plan target does not match the provider");
    if (
      plan.observedSchemaDigest !==
      this.workspaceInspectionDigest(await this.inspectWorkspaceSchema())
    )
      throw new Error("Workspace schema changed after the plan was created");
    for (const step of plan.steps.filter(
      (entry) => entry.kind === "create_table",
    ))
      await this.createTable(step.table);
    for (const step of plan.steps.filter(
      (entry) => entry.kind === "add_property",
    )) {
      /** Human-readable display name. */
      const name = requiredString(step.payload.name, "Workspace property name");
      /** Canonical schema descriptor for the requested property. */
      const descriptor = notionTable(step.table).properties.find(
        (entry) => entry.name === name,
      );
      if (descriptor === undefined)
        throw new Error(`Unknown property ${step.table}.${name}`);
      await this.addProperty(step.table, descriptor);
    }
    return Object.fromEntries(
      Object.entries(this.tables).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    );
  }

  /** Returns the normalized provider target covered by workspace authorization. */
  private workspaceTarget(): WorkspacePlan["target"] {
    return {
      bootstrapParent:
        this.environment.bootstrapParent === null
          ? null
          : normalizeId(this.environment.bootstrapParent),
      tables: Object.fromEntries(
        TABLE_KINDS.map((kind) => [
          kind,
          this.tables[kind] === null ? null : normalizeId(this.tables[kind]),
        ]),
      ) as Record<TableKind, string | null>,
    };
  }

  /** Digests the exact configured IDs and observed property schemas. */
  private workspaceInspectionDigest(
    inspections: readonly WorkspaceSchemaInspection[],
  ): string {
    return digestJson(
      toJsonValue(
        inspections.map((inspection) => ({
          configured: inspection.configured,
          properties: inspection.observedProperties,
          table: inspection.table.kind,
          tableId: this.tables[inspection.table.kind],
        })),
      ),
    );
  }

  /** Returns the normalized configured data-source ID for a managed table. */
  private table(kind: TableKind): string {
    const value = this.tables[kind];
    if (value === null)
      throw new Error(`Notion table is not configured: ${kind}`);
    return normalizeId(value);
  }

  /** Creates an absent managed table under the configured bootstrap page. */
  private async createTable(kind: TableKind): Promise<void> {
    if (this.tables[kind] !== null) return;
    if (this.environment.bootstrapParent === null)
      throw new Error("Notion bootstrap parent is required");
    /** Canonical managed-table descriptor for this operation. */
    const table = notionTable(kind);
    /** Provider properties encoded or decoded for the current record. */
    const properties = Object.fromEntries(
      table.properties
        .filter((entry) => entry.relation === null)
        .map((entry) => [entry.name, propertySchema(entry, this.tables)]),
    );
    /** Notion response whose identifiers complete the operation. */
    const response = await this.transport.request({
      body: {
        initial_data_source: { properties },
        parent: {
          page_id: normalizeId(this.environment.bootstrapParent),
          type: "page_id",
        },
        title: richTextPayload(table.title),
      },
      method: "POST",
      path: "/v1/databases",
    });
    if (
      !Array.isArray(response.data_sources) ||
      response.data_sources.length !== 1
    )
      throw new Error(`Created ${table.title} did not return one data source`);
    this.tables[kind] = requiredString(
      asObject(response.data_sources[0] as JsonValue, "Created data source").id,
      "Created data source id",
    );
  }

  /** Adds one canonical property to a configured Notion data source. */
  private async addProperty(
    kind: TableKind,
    descriptor: NotionPropertyDescriptor,
  ): Promise<void> {
    /** Current data-source schema returned by Notion. */
    const source = await this.transport.request({
      method: "GET",
      path: `/v1/data_sources/${this.table(kind)}`,
    });
    if (
      requireJsonObject(source.properties, "Data source properties")[
        descriptor.name
      ] !== undefined
    )
      return;
    await this.transport.request({
      body: {
        properties: {
          [descriptor.name]: propertySchema(descriptor, this.tables),
        },
      },
      method: "PATCH",
      path: `/v1/data_sources/${this.table(kind)}`,
    });
  }
}
