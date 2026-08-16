/** Provides a test-only JSON round-trip wrapper that checks provider serialization without adding durability. */
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
  AgentActivity,
  AgentDefinition,
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
import { toJsonValue } from "../domain/json.js";
import type {
  TableValidationReport,
  WorkspaceMigrationPlan,
  WorkspaceMigrationStep,
  WorkspaceSchemaRequest,
  WorkspaceSchemaSnapshot,
} from "../domain/schema.js";
import type { AgentTaskProvider } from "./agent-task-provider.js";

/** Defines seedable agent task provider. */
export interface SeedableAgentTaskProvider extends AgentTaskProvider {
  /** Seeds definition. */
  seedDefinition(definition: AgentDefinition): void;
  /** Seeds task. */
  seedTask(task: TaskSnapshot): void;
  /** Seeds task status options. */
  seedTaskStatusOptions(options: readonly string[]): void;
}

/** Round-trips a value through the JSON provider boundary. */
function crossBoundary<T>(value: T): T {
  return JSON.parse(JSON.stringify(toJsonValue(value))) as T;
}

/** Implements serialized provider emulator. */
export class SerializedProviderEmulator implements SeedableAgentTaskProvider {
  /** Initializes serialized provider emulator. */
  public constructor(
    /** Contains backing for serialized provider emulator. */ private readonly backing: SeedableAgentTaskProvider,
  ) {}

  /** Seeds definition. */
  public seedDefinition(definition: AgentDefinition): void {
    this.backing.seedDefinition(crossBoundary(definition));
  }

  /** Seeds task. */
  public seedTask(task: TaskSnapshot): void {
    this.backing.seedTask(crossBoundary(task));
  }

  /** Seeds task status options. */
  public seedTaskStatusOptions(options: readonly string[]): void {
    this.backing.seedTaskStatusOptions(crossBoundary(options));
  }

  /** Returns capabilities. */
  public async getCapabilities(): Promise<ProviderCapabilities> {
    return crossBoundary(await this.backing.getCapabilities());
  }

  /** Validates environment. */
  public async validateEnvironment(
    environment: ProviderEnvironment,
  ): Promise<ValidationReport> {
    return crossBoundary(
      await this.backing.validateEnvironment(crossBoundary(environment)),
    );
  }

  /** Validates tables. */
  public async validateTables(): Promise<TableValidationReport> {
    return crossBoundary(await this.backing.validateTables());
  }

  /** Inspects workspace schema without mutation. */
  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    return crossBoundary(await this.backing.inspectWorkspaceSchema());
  }

  /** Plans ordered additive workspace changes without applying them. */
  public async planWorkspaceChanges(
    request: WorkspaceSchemaRequest,
  ): Promise<WorkspaceMigrationPlan> {
    return crossBoundary(
      await this.backing.planWorkspaceChanges(crossBoundary(request)),
    );
  }

  /** Applies workspace step. */
  public async applyWorkspaceStep(
    step: WorkspaceMigrationStep,
  ): Promise<WriteReceipt> {
    return crossBoundary(
      await this.backing.applyWorkspaceStep(crossBoundary(step)),
    );
  }

  /** Reconciles workspace step against provider state. */
  public async reconcileWorkspaceStep(
    stepId: string,
  ): Promise<ReconciliationResult> {
    return crossBoundary(
      await this.backing.reconcileWorkspaceStep(crossBoundary(stepId)),
    );
  }

  /** Lists Agent definitions. */
  public async listAgentDefinitions(): Promise<readonly AgentDefinition[]> {
    return crossBoundary(await this.backing.listAgentDefinitions());
  }

  /** Returns Agent definition. */
  public async getAgentDefinition(id: string): Promise<AgentDefinition> {
    return crossBoundary(
      await this.backing.getAgentDefinition(crossBoundary(id)),
    );
  }

  /** Returns Agent activity. */
  public async getAgentActivity(id: string): Promise<AgentActivity> {
    return crossBoundary(
      await this.backing.getAgentActivity(crossBoundary(id)),
    );
  }

  /** Returns lease projection. */
  public async getLeaseProjection(id: string): Promise<LeaseProjection> {
    return crossBoundary(
      await this.backing.getLeaseProjection(crossBoundary(id)),
    );
  }

  /** Returns lease snapshot. */
  public async getLeaseSnapshot(
    leaseId: string,
  ): Promise<LeaseSnapshot | null> {
    return crossBoundary(
      await this.backing.getLeaseSnapshot(crossBoundary(leaseId)),
    );
  }

  /** Reconciles Agent activity against provider state. */
  public async reconcileAgentActivity(
    agentId: string,
    idempotencyKey: string,
  ): Promise<ReconciliationResult> {
    return crossBoundary(
      await this.backing.reconcileAgentActivity(
        crossBoundary(agentId),
        crossBoundary(idempotencyKey),
      ),
    );
  }

  /** Lists task status options. */
  public async listTaskStatusOptions(): Promise<readonly string[]> {
    return crossBoundary(await this.backing.listTaskStatusOptions());
  }

  /** Updates Agent activity. */
  public async updateAgentActivity(
    change: ActivityMutation,
  ): Promise<WriteReceipt> {
    return crossBoundary(
      await this.backing.updateAgentActivity(crossBoundary(change)),
    );
  }

  /** Lists task summaries. */
  public async listTaskSummaries(
    query: TaskQuery,
  ): Promise<readonly TaskSummary[]> {
    return crossBoundary(
      await this.backing.listTaskSummaries(crossBoundary(query)),
    );
  }

  /** Returns task snapshot. */
  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    return crossBoundary(
      await this.backing.getTaskSnapshot(crossBoundary(taskId)),
    );
  }

  /** Applies task mutation. */
  public async applyTaskMutation(
    mutation: ConditionalTaskMutation,
  ): Promise<WriteReceipt> {
    return crossBoundary(
      await this.backing.applyTaskMutation(crossBoundary(mutation)),
    );
  }

  /** Returns resources. */
  public async getResources(
    refs: readonly ResourceRef[],
  ): Promise<readonly ResourceRecord[]> {
    return crossBoundary(await this.backing.getResources(crossBoundary(refs)));
  }

  /** Returns optional resource. */
  public async getOptionalResource(
    key: string,
  ): Promise<ResourceRecord | null> {
    return crossBoundary(
      await this.backing.getOptionalResource(crossBoundary(key)),
    );
  }

  /** Persists resource. */
  public async putResource(record: ResourceMutation): Promise<WriteReceipt> {
    return crossBoundary(await this.backing.putResource(crossBoundary(record)));
  }

  /** Acquires lease. */
  public async acquireLease(request: LeaseRequest): Promise<LeaseResult> {
    return crossBoundary(
      await this.backing.acquireLease(crossBoundary(request)),
    );
  }

  /** Renews lease. */
  public async renewLease(request: LeaseRenewal): Promise<LeaseResult> {
    return crossBoundary(await this.backing.renewLease(crossBoundary(request)));
  }

  /** Releases lease. */
  public async releaseLease(request: LeaseRelease): Promise<WriteReceipt> {
    return crossBoundary(
      await this.backing.releaseLease(crossBoundary(request)),
    );
  }

  /** Creates or updates the Error identified by Error Key. */
  public async createOrUpdateError(
    error: ErrorMutation,
  ): Promise<WriteReceipt> {
    return crossBoundary(
      await this.backing.createOrUpdateError(crossBoundary(error)),
    );
  }

  /** Reconciles intent against provider state. */
  public async reconcileIntent(
    intentId: string,
  ): Promise<ReconciliationResult> {
    return crossBoundary(
      await this.backing.reconcileIntent(crossBoundary(intentId)),
    );
  }
}
