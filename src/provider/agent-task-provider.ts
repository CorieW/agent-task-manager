import type {
  ActivityMutation,
  ConditionalTaskMutation,
  ErrorMutation,
  LeaseRelease,
  LeaseRenewal,
  LeaseRequest,
  LeaseResult,
  LeaseProjection,
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

export interface AgentTaskProvider {
  getCapabilities(): Promise<ProviderCapabilities>;
  validateEnvironment(environment: ProviderEnvironment): Promise<ValidationReport>;
  validateTables(): Promise<TableValidationReport>;
  inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot>;
  planWorkspaceChanges(request: WorkspaceSchemaRequest): Promise<WorkspaceMigrationPlan>;
  applyWorkspaceStep(step: WorkspaceMigrationStep): Promise<WriteReceipt>;
  reconcileWorkspaceStep(stepId: string): Promise<ReconciliationResult>;

  listSubAgentDefinitions(): Promise<readonly SubAgentDefinition[]>;
  getSubAgentDefinition(id: string): Promise<SubAgentDefinition>;
  getSubAgentActivity(id: string): Promise<SubAgentActivity>;
  getLeaseProjection(id: string): Promise<LeaseProjection>;
  updateSubAgentActivity(change: ActivityMutation): Promise<WriteReceipt>;

  listTaskSummaries(query: TaskQuery): Promise<readonly TaskSummary[]>;
  getTaskSnapshot(taskId: string): Promise<TaskSnapshot>;
  applyTaskMutation(mutation: ConditionalTaskMutation): Promise<WriteReceipt>;

  getResources(refs: readonly ResourceRef[]): Promise<readonly ResourceRecord[]>;
  putResource(record: ResourceMutation): Promise<WriteReceipt>;

  acquireLease(request: LeaseRequest): Promise<LeaseResult>;
  renewLease(request: LeaseRenewal): Promise<LeaseResult>;
  releaseLease(request: LeaseRelease): Promise<WriteReceipt>;

  createOrUpdateError(error: ErrorMutation): Promise<WriteReceipt>;
  reconcileIntent(intentId: string): Promise<ReconciliationResult>;
}
