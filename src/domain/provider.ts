/** Provider environment and workspace contracts. */
import type { JsonObject } from "./json.js";

/** Provider table kinds in deterministic schema and planning order. */
export const TABLE_KINDS = [
  "tasks",
  "agents",
  "activeAgents",
  "errors",
  "resources",
] as const;
/** Name of one provider-managed record table. */
export type TableKind = (typeof TABLE_KINDS)[number];

/** Provider connection metadata, bootstrap parent, and configured table IDs. */
export interface ProviderEnvironment {
  /** Notion page under which missing managed databases are created. */
  readonly bootstrapParent: string | null;
  /** Provider-specific connection settings such as the token variable name. */
  readonly connection: JsonObject;
  /** Configured Notion data-source IDs keyed by managed table. */
  readonly tables: Readonly<Record<TableKind, string | null>>;
  /** Provider implementation discriminator. */
  readonly type: string;
}

/** One path-addressed environment or workspace validation failure. */
export interface ValidationIssue {
  /** Machine-readable validation or provider error code. */
  readonly code: string;
  /** Human-readable validation issue description. */
  readonly message: string;
  /** Configuration, validation, filesystem, or provider path for this value. */
  readonly path: string;
}

/** Aggregate result of a non-mutating validation pass. */
export interface ValidationReport {
  /** Validation issues discovered for the environment or workspace. */
  readonly issues: readonly ValidationIssue[];
  /** Whether validation completed without issues. */
  readonly valid: boolean;
}

/** One deterministic additive table or property operation. */
export interface WorkspaceStep {
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Domain or protocol classification of the record. */
  readonly kind: "create_table" | "add_property";
  /** JSON payload carried by the workspace step. */
  readonly payload: JsonObject;
  /** Managed table affected by the operation. */
  readonly table: TableKind;
}

/** Digest-bound additive workspace plan for one environment and target schema. */
export interface WorkspacePlan {
  /** Digest of the complete plan used for apply-time drift checking. */
  readonly digest: string;
  /** Stable identity used to isolate one managed environment. */
  readonly environmentId: string;
  /** Digest of the exact observed workspace schema used to derive the steps. */
  readonly observedSchemaDigest: string;
  /** Versioned schema identifier for the serialized object. */
  readonly schema: "workspace-plan-v1";
  /** Ordered workspace mutations authorized by the plan. */
  readonly steps: readonly WorkspaceStep[];
  /** Digest of the canonical schema the plan converges on. */
  readonly targetSchemaDigest: string;
  /** Exact provider target whose current state the plan authorizes mutating. */
  readonly target: {
    /** Normalized parent used to create missing tables. */
    readonly bootstrapParent: string | null;
    /** Normalized configured data-source IDs in canonical table order. */
    readonly tables: Readonly<Record<TableKind, string | null>>;
  };
}
