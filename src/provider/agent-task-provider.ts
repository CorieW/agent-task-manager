/** Provider-neutral contract for schema management, workflow records, leases, Resources, and recovery. */
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
  AgentDefinition,
  AgentActivity,
  TaskQuery,
  TaskSnapshot,
  TaskSummary,
} from "../domain/records.js";
import type { JsonValue } from "../domain/json.js";
import type {
  ProviderCapabilities,
  ProviderEnvironment,
  ProviderOperationIntent,
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

  /** Returns agent definitions in deterministic order. */
  listAgentDefinitions(): Promise<readonly AgentDefinition[]>;
  /** Returns Agent definition. */
  getAgentDefinition(id: string): Promise<AgentDefinition>;
  /** Returns Agent activity. */
  getAgentActivity(id: string): Promise<AgentActivity>;
  /** Returns lease projection. */
  getLeaseProjection(id: string): Promise<LeaseProjection>;
  /** Returns lease snapshot. */
  getLeaseSnapshot(leaseId: string): Promise<LeaseSnapshot | null>;
  /** Reconciles Agent activity against provider state. */
  reconcileAgentActivity(
    agentId: string,
    idempotencyKey: string,
  ): Promise<ReconciliationResult>;
  /** Returns task status options in deterministic order. */
  listTaskStatusOptions(): Promise<readonly string[]>;
  /** Updates Agent activity. */
  updateAgentActivity(change: ActivityMutation): Promise<WriteReceipt>;

  /** Returns task summaries in deterministic order. */
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
  /** Persists a manager-owned Resource whose key is reserved from callers. */
  putSystemResource(record: ResourceMutation): Promise<WriteReceipt>;

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
  /** Returns a durable logical-operation intent, if one exists. */
  getOperationIntent(intentId: string): Promise<ProviderOperationIntent | null>;
  /** Creates or validates a pending logical-operation intent. */
  beginOperationIntent(
    intentId: string,
    operation: string,
    payload: JsonValue,
  ): Promise<ProviderOperationIntent>;
  /** Completes a matching logical-operation intent. */
  completeOperationIntent(
    intentId: string,
    operation: string,
    payload: JsonValue,
    result: JsonValue,
  ): Promise<ProviderOperationIntent>;
}
