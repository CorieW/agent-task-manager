/** Provider environment and workspace contracts. */
import type { JsonObject } from "./json.js";

export const TABLE_KINDS = [
  "tasks",
  "agents",
  "activeAgents",
  "errors",
  "resources",
] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

export interface ProviderEnvironment {
  readonly bootstrapParent: string | null;
  readonly connection: JsonObject;
  readonly tables: Readonly<Record<TableKind, string | null>>;
  readonly type: string;
}

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}
export interface ValidationReport {
  readonly issues: readonly ValidationIssue[];
  readonly valid: boolean;
}

export interface WorkspaceStep {
  readonly id: string;
  readonly kind: "create_table" | "add_property";
  readonly payload: JsonObject;
  readonly table: TableKind;
}
export interface WorkspacePlan {
  readonly digest: string;
  readonly environmentId: string;
  readonly schema: "workspace-plan-v2";
  readonly steps: readonly WorkspaceStep[];
  readonly targetSchemaDigest: string;
}
