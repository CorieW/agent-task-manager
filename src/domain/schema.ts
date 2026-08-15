import type { JsonObject } from "./json.js";
import type { TableKind, ValidationIssue } from "./provider.js";

export const WORKSPACE_STATES = [
  "blocked_incompatible",
  "indeterminate",
  "needs_additive_migration",
  "needs_bootstrap",
  "ready",
] as const;

export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export type SchemaDifferenceKind =
  | "additive"
  | "compatible_extra"
  | "destructive"
  | "incompatible"
  | "missing_table";

export interface PropertyDescriptor {
  readonly logicalName: string;
  readonly physicalName: string;
  readonly required: boolean;
  readonly targetTable: TableKind | null;
  readonly type: string;
  readonly writable: boolean;
}

export interface TableDescriptor {
  readonly kind: TableKind;
  readonly managedRanges: readonly string[];
  readonly properties: readonly PropertyDescriptor[];
  readonly title: string;
}

export interface WorkspaceSchemaDescriptor {
  readonly digest: string;
  readonly providerType: string;
  readonly tables: readonly TableDescriptor[];
  readonly version: string;
}

export interface ObservedProperty {
  readonly name: string;
  readonly providerMetadata: JsonObject;
  readonly targetTableId: string | null;
  readonly type: string;
  readonly writable: boolean;
}

export interface ObservedTable {
  readonly id: string;
  readonly kind: TableKind | null;
  readonly managedRanges: readonly string[];
  readonly properties: readonly ObservedProperty[];
  readonly title: string;
  readonly version: string;
}

export interface WorkspaceSchemaSnapshot {
  readonly capturedAt: string;
  readonly digest: string;
  readonly providerIdentity: string;
  readonly tables: readonly ObservedTable[];
}

export interface SchemaDifference {
  readonly code: string;
  readonly kind: SchemaDifferenceKind;
  readonly message: string;
  readonly path: string;
}

export interface TableValidationReport {
  readonly differences: readonly SchemaDifference[];
  readonly issues: readonly ValidationIssue[];
  readonly observed: WorkspaceSchemaSnapshot;
  readonly state: WorkspaceState;
  readonly target: WorkspaceSchemaDescriptor;
}

export interface WorkspaceSchemaRequest {
  readonly environmentId: string;
  readonly mode: "bootstrap" | "migration";
  readonly observed: WorkspaceSchemaSnapshot;
  readonly target: WorkspaceSchemaDescriptor;
}

export type MigrationStepKind =
  | "add_managed_range"
  | "add_option"
  | "add_property"
  | "add_relation"
  | "create_table"
  | "record_schema_state";

export interface WorkspaceMigrationStep {
  readonly dependsOn: readonly string[];
  readonly expectedPostSchemaDigest: string | null;
  readonly expectedPreSchemaDigest: string | null;
  readonly id: string;
  readonly kind: MigrationStepKind;
  readonly payload: JsonObject;
  readonly reversibility: "additive" | "manual";
}

export interface WorkspaceMigrationPlanCore {
  readonly environmentId: string;
  readonly mode: "bootstrap" | "migration";
  readonly observedSchemaDigest: string;
  readonly parentIdentity: string | null;
  readonly providerIdentity: string;
  readonly steps: readonly WorkspaceMigrationStep[];
  readonly targetSchemaDigest: string;
  readonly targetSchemaVersion: string;
}

export interface WorkspaceMigrationPlan extends WorkspaceMigrationPlanCore {
  readonly digest: string;
}
