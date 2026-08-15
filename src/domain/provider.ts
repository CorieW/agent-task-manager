/** Defines provider capabilities, environments, validation, write receipts, and reconciliation results. */
import type { JsonObject, JsonValue } from "./json.js";

export const TABLE_KINDS = ["tasks", "subAgents", "errors", "resources"] as const;

export type TableKind = (typeof TABLE_KINDS)[number];

export type ConditionalWriteStrength =
  | "advisory"
  | "atomic"
  | "optimistic"
  | "unavailable";

export interface ProviderCapabilities {
  readonly archive: boolean;
  readonly attachments: boolean;
  readonly conditionalWrites: ConditionalWriteStrength;
  readonly deterministicPagination: boolean;
  readonly idempotencyLookup: boolean;
  readonly leases: "advisory" | "atomic" | "unavailable";
  readonly managedContent: boolean;
  readonly relations: boolean;
  readonly schemaDiscovery: boolean;
  readonly schemaMutation: boolean;
  readonly stableRecordIds: boolean;
}

export interface ProviderEnvironment {
  readonly bootstrapParent: string | null;
  readonly connection: JsonObject;
  readonly tables: Readonly<Record<TableKind, string | null>>;
  readonly type: string;
}

export interface ProviderRecordRef {
  readonly id: string;
  readonly table: TableKind;
}

export interface WriteReceipt {
  readonly idempotencyKey: string;
  readonly observedVersion: string;
  readonly providerRecord: ProviderRecordRef;
  readonly writtenAt: string;
}

export type ReconciliationState =
  | "applied"
  | "failed"
  | "indeterminate"
  | "not_applied";

export interface ReconciliationResult {
  readonly evidence: JsonObject;
  readonly state: ReconciliationState;
}

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly severity: "error" | "warning";
}

export interface ValidationReport {
  readonly issues: readonly ValidationIssue[];
  readonly valid: boolean;
}

export interface PageContent {
  readonly body: string;
  readonly digest: string;
}

export interface GenericProviderRecord {
  readonly content: PageContent | null;
  readonly id: string;
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly version: string;
}
