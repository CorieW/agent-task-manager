// Emulates a remote provider boundary by serializing every request and response.
import type {
  ActivityMutation,
  ConditionalTaskMutation,
  ErrorMutation,
  LeaseProjection,
  LeaseRelease,
  LeaseRenewal,
  LeaseRequest,
  LeaseResult,
  LeaseSnapshot,
  ResourceMutation,
  ResourceRecord,
  ResourceRef,
  SubAgentActivity,
  SubAgentDefinition,
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
import type { AgentTaskProvider } from "./agent-task-provider.js";

export interface SeedableAgentTaskProvider extends AgentTaskProvider {
  seedDefinition(definition: SubAgentDefinition): void;
  seedTask(task: TaskSnapshot): void;
  seedTaskStatusOptions(options: readonly string[]): void;
}

function crossBoundary<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SerializedProviderEmulator implements SeedableAgentTaskProvider {
  public constructor(private readonly backing: SeedableAgentTaskProvider) {}

  public seedDefinition(definition: SubAgentDefinition): void {
    this.backing.seedDefinition(crossBoundary(definition));
  }

  public seedTask(task: TaskSnapshot): void {
    this.backing.seedTask(crossBoundary(task));
  }

  public seedTaskStatusOptions(options: readonly string[]): void {
    this.backing.seedTaskStatusOptions(crossBoundary(options));
  }

  public async getCapabilities(): Promise<ProviderCapabilities> {
    return crossBoundary(await this.backing.getCapabilities());
  }

  public async validateEnvironment(environment: ProviderEnvironment): Promise<ValidationReport> {
    return crossBoundary(await this.backing.validateEnvironment(crossBoundary(environment)));
  }

  public async validateTables(): Promise<TableValidationReport> {
    return crossBoundary(await this.backing.validateTables());
  }

  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    return crossBoundary(await this.backing.inspectWorkspaceSchema());
  }

  public async planWorkspaceChanges(request: WorkspaceSchemaRequest): Promise<WorkspaceMigrationPlan> {
    return crossBoundary(await this.backing.planWorkspaceChanges(crossBoundary(request)));
  }

  public async applyWorkspaceStep(step: WorkspaceMigrationStep): Promise<WriteReceipt> {
    return crossBoundary(await this.backing.applyWorkspaceStep(crossBoundary(step)));
  }

  public async reconcileWorkspaceStep(stepId: string): Promise<ReconciliationResult> {
    return crossBoundary(await this.backing.reconcileWorkspaceStep(crossBoundary(stepId)));
  }

  public async listSubAgentDefinitions(): Promise<readonly SubAgentDefinition[]> {
    return crossBoundary(await this.backing.listSubAgentDefinitions());
  }

  public async getSubAgentDefinition(id: string): Promise<SubAgentDefinition> {
    return crossBoundary(await this.backing.getSubAgentDefinition(crossBoundary(id)));
  }

  public async getSubAgentActivity(id: string): Promise<SubAgentActivity> {
    return crossBoundary(await this.backing.getSubAgentActivity(crossBoundary(id)));
  }

  public async getLeaseProjection(id: string): Promise<LeaseProjection> {
    return crossBoundary(await this.backing.getLeaseProjection(crossBoundary(id)));
  }

  public async getLeaseSnapshot(leaseId: string): Promise<LeaseSnapshot | null> {
    return crossBoundary(await this.backing.getLeaseSnapshot(crossBoundary(leaseId)));
  }

  public async reconcileSubAgentActivity(subAgentId: string, idempotencyKey: string): Promise<ReconciliationResult> {
    return crossBoundary(await this.backing.reconcileSubAgentActivity(crossBoundary(subAgentId), crossBoundary(idempotencyKey)));
  }

  public async listTaskStatusOptions(): Promise<readonly string[]> {
    return crossBoundary(await this.backing.listTaskStatusOptions());
  }

  public async updateSubAgentActivity(change: ActivityMutation): Promise<WriteReceipt> {
    return crossBoundary(await this.backing.updateSubAgentActivity(crossBoundary(change)));
  }

  public async listTaskSummaries(query: TaskQuery): Promise<readonly TaskSummary[]> {
    return crossBoundary(await this.backing.listTaskSummaries(crossBoundary(query)));
  }

  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    return crossBoundary(await this.backing.getTaskSnapshot(crossBoundary(taskId)));
  }

  public async applyTaskMutation(mutation: ConditionalTaskMutation): Promise<WriteReceipt> {
    return crossBoundary(await this.backing.applyTaskMutation(crossBoundary(mutation)));
  }

  public async getResources(refs: readonly ResourceRef[]): Promise<readonly ResourceRecord[]> {
    return crossBoundary(await this.backing.getResources(crossBoundary(refs)));
  }

  public async getOptionalResource(key: string): Promise<ResourceRecord | null> {
    return crossBoundary(await this.backing.getOptionalResource(crossBoundary(key)));
  }

  public async putResource(record: ResourceMutation): Promise<WriteReceipt> {
    return crossBoundary(await this.backing.putResource(crossBoundary(record)));
  }

  public async acquireLease(request: LeaseRequest): Promise<LeaseResult> {
    return crossBoundary(await this.backing.acquireLease(crossBoundary(request)));
  }

  public async renewLease(request: LeaseRenewal): Promise<LeaseResult> {
    return crossBoundary(await this.backing.renewLease(crossBoundary(request)));
  }

  public async releaseLease(request: LeaseRelease): Promise<WriteReceipt> {
    return crossBoundary(await this.backing.releaseLease(crossBoundary(request)));
  }

  public async createOrUpdateError(error: ErrorMutation): Promise<WriteReceipt> {
    return crossBoundary(await this.backing.createOrUpdateError(crossBoundary(error)));
  }

  public async reconcileIntent(intentId: string): Promise<ReconciliationResult> {
    return crossBoundary(await this.backing.reconcileIntent(crossBoundary(intentId)));
  }
}
