// Composes Notion workspace, record, page, and state services behind AgentTaskProvider.
import type {
  ActivityMutation,
  ConditionalTaskMutation,
  ErrorMutation,
  LeaseRelease,
  LeaseRenewal,
  LeaseRequest,
  LeaseResult,
  ResourceMutation,
  ResourceRecord,
  ResourceRef,
  SubAgentDefinition,
  TaskQuery,
  TaskSnapshot,
  TaskSummary,
} from "../../domain/records.js";
import type {
  ProviderCapabilities,
  ProviderEnvironment,
  ReconciliationResult,
  TableKind,
  ValidationReport,
  WriteReceipt,
} from "../../domain/provider.js";
import { TABLE_KINDS } from "../../domain/provider.js";
import { toJsonValue, type JsonObject, type JsonValue } from "../../domain/json.js";
import { digestJson } from "../../core/digest.js";
import type {
  TableValidationReport,
  WorkspaceMigrationPlan,
  WorkspaceMigrationStep,
  WorkspaceSchemaDescriptor,
  WorkspaceSchemaRequest,
  WorkspaceSchemaSnapshot,
} from "../../domain/schema.js";
import type { AgentTaskProvider } from "../agent-task-provider.js";
import { compareWorkspaceSchema } from "../../core/schema-diff.js";
import { NotionPageStore, type NotionMutableTableIds } from "./notion-page-store.js";
import { NotionRecordReader } from "./notion-record-codec.js";
import { createNotionWorkspaceSchema } from "./notion-schema.js";
import { NotionStateStore } from "./notion-state-store.js";
import type { NotionTransport } from "./notion-transport.js";
import { NotionWorkspaceManager } from "./notion-workspace-manager.js";
import { NotionWorkspaceReader } from "./notion-workspace-reader.js";
import { SingleHostMutex } from "./single-host-mutex.js";
import { parseWriteReceipt } from "../write-receipt-codec.js";

export interface NotionProviderOptions {
  readonly environment: ProviderEnvironment;
  readonly environmentId: string;
  readonly mutex?: SingleHostMutex;
  readonly now?: () => Date;
  readonly target?: WorkspaceSchemaDescriptor;
  readonly transport: NotionTransport;
}

interface RuntimeServices {
  readonly pages: NotionPageStore;
  readonly reader: NotionRecordReader;
  readonly state: NotionStateStore;
}

export class NotionProvider implements AgentTaskProvider {
  readonly #environment: ProviderEnvironment;
  readonly #manager: NotionWorkspaceManager;
  readonly #mutex: SingleHostMutex;
  readonly #now: () => Date;
  readonly #target: WorkspaceSchemaDescriptor;
  readonly #transport: NotionTransport;

  public constructor(options: NotionProviderOptions) {
    this.#environment = options.environment;
    this.#target = options.target ?? createNotionWorkspaceSchema();
    this.#transport = options.transport;
    this.#now = options.now ?? (() => new Date());
    this.#mutex = options.mutex ?? new SingleHostMutex(options.environmentId);
    this.#manager = new NotionWorkspaceManager(
      options.environmentId,
      options.environment,
      this.#target,
      options.transport,
      this.#now,
    );
  }

  public async getCapabilities(): Promise<ProviderCapabilities> {
    return new NotionWorkspaceReader(this.#environment, this.#target, this.#transport, this.#now).getCapabilities();
  }

  public async validateEnvironment(environment: ProviderEnvironment): Promise<ValidationReport> {
    return new NotionWorkspaceReader(environment, this.#target, this.#transport, this.#now).validateEnvironment();
  }

  public async validateTables(): Promise<TableValidationReport> {
    return compareWorkspaceSchema(await this.#manager.inspectWorkspaceSchema(), this.#target);
  }

  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    return this.#manager.inspectWorkspaceSchema();
  }

  public async planWorkspaceChanges(request: WorkspaceSchemaRequest): Promise<WorkspaceMigrationPlan> {
    return this.#manager.planWorkspaceChanges(request);
  }

  public async applyWorkspaceStep(step: WorkspaceMigrationStep): Promise<WriteReceipt> {
    return this.#manager.applyWorkspaceStep(step);
  }

  public async reconcileWorkspaceStep(stepId: string): Promise<ReconciliationResult> {
    return this.#manager.reconcileWorkspaceStep(stepId);
  }

  public async listSubAgentDefinitions(): Promise<readonly SubAgentDefinition[]> {
    return (await this.runtime()).reader.listSubAgentDefinitions();
  }

  public async getSubAgentDefinition(id: string): Promise<SubAgentDefinition> {
    return (await this.runtime()).reader.getSubAgentDefinition(id);
  }

  public async updateSubAgentActivity(change: ActivityMutation): Promise<WriteReceipt> {
    const runtime = await this.runtime();
    return runtime.state.runExclusive(async () => {
      const prior = await runtime.state.beginIntent(change.idempotencyKey, "agent_activity", change);
      if (prior !== undefined) return parseWriteReceipt(prior);
      const projection = await runtime.state.activeProjection(change.subAgentId);
      const activeRuns = projection.runLeaseIds;
      const activeTasks = projection.taskIds;
      if (!sameSet(activeRuns, change.nextRunLeaseIds) || !sameSet(activeTasks, change.nextTaskIds)) {
        throw new Error("Sub-agent activity must equal the provider's active lease projection");
      }
      const receipt = await runtime.pages.updateSubAgentActivity(change);
      await runtime.state.completeIntent(change.idempotencyKey, "agent_activity", change, receipt);
      return receipt;
    });
  }

  public async listTaskSummaries(query: TaskQuery): Promise<readonly TaskSummary[]> {
    return (await this.runtime()).reader.listTaskSummaries(query);
  }

  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    return (await this.runtime()).reader.getTaskSnapshot(taskId);
  }

  public async applyTaskMutation(mutation: ConditionalTaskMutation): Promise<WriteReceipt> {
    return this.executeReceiptIntent(mutation.idempotencyKey, "task", mutation, (runtime) => runtime.pages.applyTaskMutation(mutation));
  }

  public async getResources(refs: readonly ResourceRef[]): Promise<readonly ResourceRecord[]> {
    return (await this.runtime()).reader.getResources(refs);
  }

  public async putResource(record: ResourceMutation): Promise<WriteReceipt> {
    if (record.key.startsWith("system/")) throw new Error("system/ Resource keys are reserved by Agent Task Manager");
    return this.executeReceiptIntent(record.idempotencyKey, "resource", record, (runtime) => runtime.pages.createResource(record));
  }

  public async acquireLease(request: LeaseRequest): Promise<LeaseResult> {
    return (await this.runtime()).state.acquireLease(request);
  }

  public async renewLease(request: LeaseRenewal): Promise<LeaseResult> {
    return (await this.runtime()).state.renewLease(request);
  }

  public async releaseLease(request: LeaseRelease): Promise<WriteReceipt> {
    return (await this.runtime()).state.releaseLease(request);
  }

  public async createOrUpdateError(error: ErrorMutation): Promise<WriteReceipt> {
    return this.executeReceiptIntent(error.idempotencyKey, "error", error, (runtime) => runtime.pages.createOrUpdateError(error));
  }

  public async reconcileIntent(intentId: string): Promise<ReconciliationResult> {
    return (await this.runtime()).state.reconcileIntent(intentId);
  }

  public workspaceManager(): NotionWorkspaceManager {
    return this.#manager;
  }

  public async reconcileSubAgentActivity(
    subAgentId: string,
    idempotencyKey: string,
  ): Promise<ReconciliationResult> {
    const runtime = await this.runtime();
    const projection = await runtime.state.activeProjection(subAgentId);
    const activeRunLeaseIds = projection.runLeaseIds;
    const activeTaskIds = projection.taskIds;
    const observed = await runtime.pages.getSubAgentActivity(subAgentId);
    const expectedStatus = activeRunLeaseIds.length === 0 ? "Offline" : "Online";
    if (observed.status === expectedStatus && sameSet(observed.taskIds, activeTaskIds)) {
      return {
        evidence: jsonObject(toJsonValue({ activeRunLeaseIds, activeTaskIds, status: expectedStatus }), "Activity evidence"),
        state: "not_applied",
      };
    }
    const basis = { activeRunLeaseIds, activeTaskIds, expectedStatus, observed, subAgentId };
    const receipt = await runtime.state.runExclusive(() => runtime.pages.setSubAgentActivity(
      subAgentId,
      observed.status,
      observed.taskIds,
      expectedStatus,
      activeTaskIds,
      idempotencyKey,
    ));
    await this.createOrUpdateError({
      description: `Observed activity ${JSON.stringify({ status: observed.status, taskIds: observed.taskIds })}; expected ${JSON.stringify({ status: expectedStatus, taskIds: activeTaskIds })}.`,
      errorKey: `stale-sub-agent-activity:${subAgentId}`,
      idempotencyKey: `error:stale-sub-agent-activity:${digestJson(toJsonValue(basis))}`,
      relatedRunId: null,
      relatedSubAgentId: subAgentId,
      relatedTaskId: null,
      resolution: "The manager reconciled Status and Working On from active provider-backed leases. Investigate the interrupted run or partial provider write.",
      severity: "high",
      title: "Stale sub-agent activity",
    });
    return { evidence: { basis: toJsonValue(basis), receipt: toJsonValue(receipt) }, state: "applied" };
  }

  private async runtime(): Promise<RuntimeServices> {
    const partial = await this.#manager.resolveTableIds();
    for (const kind of TABLE_KINDS) if (partial[kind] === undefined) throw new Error(`Notion runtime requires configured or discoverable ${kind} table`);
    const tables = partial as NotionMutableTableIds;
    const pages = new NotionPageStore(tables, this.#transport, this.#now);
    return {
      pages,
      reader: new NotionRecordReader(tables, this.#transport),
      state: new NotionStateStore(pages, this.#mutex, this.#now),
    };
  }

  private async executeReceiptIntent(
    idempotencyKey: string,
    operation: string,
    payload: unknown,
    effect: (runtime: RuntimeServices) => Promise<WriteReceipt>,
  ): Promise<WriteReceipt> {
    const runtime = await this.runtime();
    return runtime.state.runExclusive(async () => {
      const prior = await runtime.state.beginIntent(idempotencyKey, operation, payload);
      if (prior !== undefined) return parseWriteReceipt(prior);
      const receipt = await effect(runtime);
      await runtime.state.completeIntent(idempotencyKey, operation, payload, receipt);
      return receipt;
    });
  }
}

function jsonObject(value: JsonValue | undefined, label: string): JsonObject {
  const checked = toJsonValue(value);
  if (checked === null || typeof checked !== "object" || Array.isArray(checked)) throw new TypeError(`${label} must be an object`);
  return checked;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join("\0") === [...new Set(right)].sort().join("\0");
}
