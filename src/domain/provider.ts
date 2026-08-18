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
  readonly bootstrapParent: string | null;
  readonly connection: JsonObject;
  readonly tables: Readonly<Record<TableKind, string | null>>;
  readonly type: string;
}

/** One path-addressed environment or workspace validation failure. */
export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}
/** Aggregate result of a non-mutating validation pass. */
export interface ValidationReport {
  readonly issues: readonly ValidationIssue[];
  readonly valid: boolean;
}

/** One deterministic additive table or property operation. */
export interface WorkspaceStep {
  readonly id: string;
  readonly kind: "create_table" | "add_property";
  readonly payload: JsonObject;
  readonly table: TableKind;
}
/** Digest-bound additive workspace plan for one environment and target schema. */
export interface WorkspacePlan {
  /** Digest of the complete plan used for apply-time drift checking. */
  readonly digest: string;
  readonly environmentId: string;
  readonly schema: "workspace-plan-v2";
  readonly steps: readonly WorkspaceStep[];
  /** Digest of the canonical schema the plan converges on. */
  readonly targetSchemaDigest: string;
}
