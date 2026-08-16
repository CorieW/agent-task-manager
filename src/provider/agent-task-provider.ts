/** Defines the complete provider contract for schema management, workflow records, leases, Resources, and recovery. */
import type {
  ActivityMutation,
  ConditionalTaskMutation,
  ErrorMutation,
  LeaseRelease,
  LeaseRenewal,
  LeaseRequest,
  LeaseResult,
  LeaseProjection,
  LeaseSnapshot,
  ResourceMutation,
  ResourceRecord,
  ResourceRef,
  SubAgentDefinition,
  SubAgentActivity,
  TaskQuery,
  TaskSnapshot,
  TaskSummary,
} from "../domain/records.js";
import type {
  ProviderCapabilities,
  ProviderEnvironment,
  ReconciliationResult,
  ValidationReport,
  WriteReceipt,
} from "../domain/provider.js";
import type {
  TableValidationReport,
  WorkspaceMigrationPlan,
  WorkspaceMigrationStep,
  WorkspaceSchemaRequest,
  WorkspaceSchemaSnapshot,
} from "../domain/schema.js";

/**
 * Defines the provider serialization boundary for workflow state.
 *
 * Implementations provide detached JSON-compatible reads, opaque conditional
 * versions, payload-bound idempotency, deterministic pagination, and
 * evidence-based reconciliation. Production adapters persist authoritative
 * state, and every implementation must satisfy the shared conformance matrix.
 */
export interface AgentTaskProvider {
  /** Returns capabilities. */
  getCapabilities(): Promise<ProviderCapabilities>;
  /** Validates environment. */
  validateEnvironment(
    environment: ProviderEnvironment,
  ): Promise<ValidationReport>;
  /** Validates tables. */
  validateTables(): Promise<TableValidationReport>;
  /** Inspects workspace schema without mutation. */
  inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot>;
  /** Plans ordered additive workspace changes without applying them. */
  planWorkspaceChanges(
    request: WorkspaceSchemaRequest,
  ): Promise<WorkspaceMigrationPlan>;
  /** Applies workspace step. */
  applyWorkspaceStep(step: WorkspaceMigrationStep): Promise<WriteReceipt>;
  /** Reconciles workspace step against provider state. */
  reconcileWorkspaceStep(stepId: string): Promise<ReconciliationResult>;

  /** Lists Sub agent definitions. */
  listSubAgentDefinitions(): Promise<readonly SubAgentDefinition[]>;
  /** Returns Sub agent definition. */
  getSubAgentDefinition(id: string): Promise<SubAgentDefinition>;
  /** Returns Sub agent activity. */
  getSubAgentActivity(id: string): Promise<SubAgentActivity>;
  /** Returns lease projection. */
  getLeaseProjection(id: string): Promise<LeaseProjection>;
  /** Returns lease snapshot. */
  getLeaseSnapshot(leaseId: string): Promise<LeaseSnapshot | null>;
  /** Reconciles Sub agent activity against provider state. */
  reconcileSubAgentActivity(
    subAgentId: string,
    idempotencyKey: string,
  ): Promise<ReconciliationResult>;
  /** Lists task status options. */
  listTaskStatusOptions(): Promise<readonly string[]>;
  /** Updates Sub agent activity. */
  updateSubAgentActivity(change: ActivityMutation): Promise<WriteReceipt>;

  /** Lists task summaries. */
  listTaskSummaries(query: TaskQuery): Promise<readonly TaskSummary[]>;
  /** Returns task snapshot. */
  getTaskSnapshot(taskId: string): Promise<TaskSnapshot>;
  /** Applies task mutation. */
  applyTaskMutation(mutation: ConditionalTaskMutation): Promise<WriteReceipt>;

  /** Returns resources. */
  getResources(
    refs: readonly ResourceRef[],
  ): Promise<readonly ResourceRecord[]>;
  /** Returns optional resource. */
  getOptionalResource(key: string): Promise<ResourceRecord | null>;
  /** Persists resource. */
  putResource(record: ResourceMutation): Promise<WriteReceipt>;

  /** Acquires lease. */
  acquireLease(request: LeaseRequest): Promise<LeaseResult>;
  /** Renews lease. */
  renewLease(request: LeaseRenewal): Promise<LeaseResult>;
  /** Releases lease. */
  releaseLease(request: LeaseRelease): Promise<WriteReceipt>;

  /** Creates or updates the Error identified by Error Key. */
  createOrUpdateError(error: ErrorMutation): Promise<WriteReceipt>;
  /** Reconciles intent against provider state. */
  reconcileIntent(intentId: string): Promise<ReconciliationResult>;
}
