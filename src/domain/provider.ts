/** Provider-neutral provider capabilities, environments, validation, write receipts, and reconciliation results contract. */
import type { JsonObject, JsonValue } from "./json.js";

/** Provider table kinds managed by the application. */
export const TABLE_KINDS = ["tasks", "agents", "errors", "resources"] as const;

/** Allowed table kind literals. */
export type TableKind = (typeof TABLE_KINDS)[number];

/** Allowed conditional write strength literals. */
export type ConditionalWriteStrength =
  "advisory" | "atomic" | "optimistic" | "unavailable";

/** Canonical fields for provider capabilities. */
export interface ProviderCapabilities {
  /** Whether the provider supports record archival. */
  readonly archive: boolean;
  /** Whether the provider supports attachments. */
  readonly attachments: boolean;
  /** Strength of the provider's conditional-write guarantee. */
  readonly conditionalWrites: ConditionalWriteStrength;
  /** Whether repeated pagination uses a stable ordering. */
  readonly deterministicPagination: boolean;
  /** Whether the provider can look up prior idempotent writes. */
  readonly idempotencyLookup: boolean;
  /** Leases for provider capabilities. */
  readonly leases: "advisory" | "atomic" | "unavailable";
  /** Whether the provider supports manager-owned page content. */
  readonly managedContent: boolean;
  /** Whether the provider supports relations between table records. */
  readonly relations: boolean;
  /** Whether the provider can inspect table schemas. */
  readonly schemaDiscovery: boolean;
  /** Whether the provider can create or extend table schemas. */
  readonly schemaMutation: boolean;
  /** Whether provider record IDs remain stable across reads. */
  readonly stableRecordIds: boolean;
}

/** Canonical fields for provider environment. */
export interface ProviderEnvironment {
  /** Provider location under which missing tables may be created. */
  readonly bootstrapParent: string | null;
  /** Provider-specific connection settings. */
  readonly connection: JsonObject;
  /** Tables for provider environment. */
  readonly tables: Readonly<Record<TableKind, string | null>>;
  /** Type for provider environment. */
  readonly type: string;
}

/** Stable reference to provider record. */
export interface ProviderRecordRef {
  /** Stable identifier for provider record ref. */
  readonly id: string;
  /** Table for provider record ref. */
  readonly table: TableKind;
}

/** Canonical fields for write receipt. */
export interface WriteReceipt {
  /** Key that identifies retries of the same logical operation. */
  readonly idempotencyKey: string;
  /** Provider version observed after the write. */
  readonly observedVersion: string;
  /** Provider record for write receipt. */
  readonly providerRecord: ProviderRecordRef;
  /** Timestamp when the provider acknowledged the write. */
  readonly writtenAt: string;
}

/** Allowed reconciliation state literals. */
export type ReconciliationState =
  "applied" | "failed" | "indeterminate" | "not_applied";

/** Result of reconciliation. */
export interface ReconciliationResult {
  /** Evidence for reconciliation result. */
  readonly evidence: JsonObject;
  /** Current state of reconciliation result. */
  readonly state: ReconciliationState;
}

/** Durable provider intent used to prepare and replay a logical operation. */
export interface ProviderOperationIntent {
  /** Key that identifies retries of the same logical operation. */
  readonly idempotencyKey: string;
  /** Stable operation name bound to the idempotency key. */
  readonly operation: string;
  /** Canonical operation payload retained for restart-safe replay. */
  readonly payload: JsonValue;
  /** Canonical result after completion, or null while pending. */
  readonly result: JsonValue;
  /** Current durable intent state. */
  readonly state: "applied" | "pending";
}

/** Structured issue discovered during provider validation. */
export interface ValidationIssue {
  /** Code for validation issue. */
  readonly code: string;
  /** Message for validation issue. */
  readonly message: string;
  /** Path for validation issue. */
  readonly path: string;
  /** Severity for validation issue. */
  readonly severity: "error" | "warning";
}

/** Validation report for validation. */
export interface ValidationReport {
  /** Validation issues; empty when validation succeeds. */
  readonly issues: readonly ValidationIssue[];
  /** Whether validation completed without errors. */
  readonly valid: boolean;
}

/** Canonical fields for page content. */
export interface PageContent {
  /** Provider-managed page body. */
  readonly body: string;
  /** SHA-256 digest of the page body. */
  readonly digest: string;
}

/** Persisted representation of generic provider. */
export interface GenericProviderRecord {
  /** Content for generic provider record. */
  readonly content: PageContent | null;
  /** Stable identifier for generic provider record. */
  readonly id: string;
  /** Provider-visible structured properties. */
  readonly properties: Readonly<Record<string, JsonValue>>;
  /** Opaque version token used for compatibility or concurrency checks. */
  readonly version: string;
}
