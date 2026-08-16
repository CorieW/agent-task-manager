/** Defines canonical workspace schemas, observed schema snapshots, differences, and migration plans. */
import type { JsonObject } from "./json.js";
import type { TableKind, ValidationIssue } from "./provider.js";

/** Workspace readiness states produced by schema validation. */
export const WORKSPACE_STATES = [
  "blocked_incompatible",
  "indeterminate",
  "needs_additive_migration",
  "needs_bootstrap",
  "ready",
] as const;

/** Allowed workspace state literals. */
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/** Allowed schema difference kind literals. */
export type SchemaDifferenceKind =
  | "additive"
  | "compatible_extra"
  | "destructive"
  | "incompatible"
  | "missing_table";

/** Canonical description of property. */
export interface PropertyDescriptor {
  /** Logical name for property descriptor. */
  readonly logicalName: string;
  /** Physical name for property descriptor. */
  readonly physicalName: string;
  /** Whether the property must exist in a valid table. */
  readonly required: boolean;
  /** Target table for property descriptor. */
  readonly targetTable: TableKind | null;
  /** Type for property descriptor. */
  readonly type: string;
  /** Whether the manager may update this provider property. */
  readonly writable: boolean;
}

/** Canonical description of table. */
export interface TableDescriptor {
  /** Kind for table descriptor. */
  readonly kind: TableKind;
  /** Managed ranges included in table descriptor. */
  readonly managedRanges: readonly string[];
  /** Provider-visible structured properties. */
  readonly properties: readonly PropertyDescriptor[];
  /** Title for table descriptor. */
  readonly title: string;
}

/** Canonical description of workspace schema. */
export interface WorkspaceSchemaDescriptor {
  /** SHA-256 digest of the canonical workspace schema. */
  readonly digest: string;
  /** Provider type for workspace schema descriptor. */
  readonly providerType: string;
  /** Tables included in workspace schema descriptor. */
  readonly tables: readonly TableDescriptor[];
  /** Opaque version token used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Canonical fields for observed property. */
export interface ObservedProperty {
  /** Name for observed property. */
  readonly name: string;
  /** Provider metadata for observed property. */
  readonly providerMetadata: JsonObject;
  /** Stable identifier for target table. */
  readonly targetTableId: string | null;
  /** Type for observed property. */
  readonly type: string;
  /** Whether the manager may update this provider property. */
  readonly writable: boolean;
}

/** Canonical fields for observed table. */
export interface ObservedTable {
  /** Stable identifier for observed table. */
  readonly id: string;
  /** Kind for observed table. */
  readonly kind: TableKind | null;
  /** Managed ranges included in observed table. */
  readonly managedRanges: readonly string[];
  /** Provider-visible structured properties. */
  readonly properties: readonly ObservedProperty[];
  /** Title for observed table. */
  readonly title: string;
  /** Opaque version token used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Immutable snapshot of workspace schema. */
export interface WorkspaceSchemaSnapshot {
  /** Timestamp when the workspace snapshot was captured. */
  readonly capturedAt: string;
  /** SHA-256 digest of the observed workspace snapshot. */
  readonly digest: string;
  /** Provider identity for workspace schema snapshot. */
  readonly providerIdentity: string;
  /** Tables included in workspace schema snapshot. */
  readonly tables: readonly ObservedTable[];
}

/** Canonical fields for schema difference. */
export interface SchemaDifference {
  /** Code for schema difference. */
  readonly code: string;
  /** Kind for schema difference. */
  readonly kind: SchemaDifferenceKind;
  /** Message for schema difference. */
  readonly message: string;
  /** Path for schema difference. */
  readonly path: string;
}

/** Validation report for table validation. */
export interface TableValidationReport {
  /** Differences included in table validation report. */
  readonly differences: readonly SchemaDifference[];
  /** Validation issues; empty when validation succeeds. */
  readonly issues: readonly ValidationIssue[];
  /** Observed for table validation report. */
  readonly observed: WorkspaceSchemaSnapshot;
  /** Current state of table validation report. */
  readonly state: WorkspaceState;
  /** Target for table validation report. */
  readonly target: WorkspaceSchemaDescriptor;
}

/** Inputs required to perform workspace schema. */
export interface WorkspaceSchemaRequest {
  /** Stable identifier for environment. */
  readonly environmentId: string;
  /** Mode for workspace schema request. */
  readonly mode: "bootstrap" | "migration";
  /** Observed for workspace schema request. */
  readonly observed: WorkspaceSchemaSnapshot;
  /** Target for workspace schema request. */
  readonly target: WorkspaceSchemaDescriptor;
}

/** Allowed migration step kind literals. */
export type MigrationStepKind =
  | "add_managed_range"
  | "add_option"
  | "add_property"
  | "add_relation"
  | "create_table"
  | "record_schema_state";

/** Canonical fields for workspace migration step. */
export interface WorkspaceMigrationStep {
  /** Depends on included in workspace migration step. */
  readonly dependsOn: readonly string[];
  /** SHA-256 digest of canonical expected post schema content. */
  readonly expectedPostSchemaDigest: string;
  /** SHA-256 digest of canonical expected pre schema content. */
  readonly expectedPreSchemaDigest: string;
  /** Stable identifier for workspace migration step. */
  readonly id: string;
  /** Kind for workspace migration step. */
  readonly kind: MigrationStepKind;
  /** Payload for workspace migration step. */
  readonly payload: JsonObject;
  /** Reversibility for workspace migration step. */
  readonly reversibility: "additive" | "manual";
}

/** Canonical fields for workspace migration plan core. */
export interface WorkspaceMigrationPlanCore {
  /** Stable identifier for environment. */
  readonly environmentId: string;
  /** Mode for workspace migration plan core. */
  readonly mode: "bootstrap" | "migration";
  /** SHA-256 digest of canonical observed schema content. */
  readonly observedSchemaDigest: string;
  /** Parent identity for workspace migration plan core. */
  readonly parentIdentity: string | null;
  /** Provider identity for workspace migration plan core. */
  readonly providerIdentity: string;
  /** Steps included in workspace migration plan core. */
  readonly steps: readonly WorkspaceMigrationStep[];
  /** SHA-256 digest of canonical target schema content. */
  readonly targetSchemaDigest: string;
  /** Version token expected for target schema. */
  readonly targetSchemaVersion: string;
}

/** Canonical fields for workspace migration plan. */
export interface WorkspaceMigrationPlan extends WorkspaceMigrationPlanCore {
  /** SHA-256 digest of the complete migration plan. */
  readonly digest: string;
}
