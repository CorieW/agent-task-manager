/** Composes Notion workspace, record, page, and state services behind AgentTaskProvider. */
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
} from "../../domain/records.js";
import type {
  ProviderCapabilities,
  ProviderEnvironment,
  ReconciliationResult,
  ValidationReport,
  WriteReceipt,
} from "../../domain/provider.js";
import { TABLE_KINDS } from "../../domain/provider.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../domain/json.js";
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
import { taskPropertiesWithStatus } from "../../core/task-properties.js";
import {
  NotionPageStore,
  type NotionMutableTableIds,
} from "./notion-page-store.js";
import { NotionRecordReader } from "./notion-record-codec.js";
import {
  createNotionWorkspaceSchema,
  NOTION_TASK_MUTATION_PROPERTY,
} from "./notion-schema.js";
import {
  IndeterminateProviderIntentError,
  NotionStateStore,
} from "./notion-state-store.js";
import type { NotionTransport } from "./notion-transport.js";
import { NotionWorkspaceManager } from "./notion-workspace-manager.js";
import { NotionWorkspaceReader } from "./notion-workspace-reader.js";
import { SingleHostMutex } from "./single-host-mutex.js";
import { parseWriteReceipt } from "../write-receipt-codec.js";

/** Defines Notion provider options. */
export interface NotionProviderOptions {
  /** Contains environment for Notion provider options. */
  readonly environment: ProviderEnvironment;
  /** Identifies environment. */
  readonly environmentId: string;
  /** Optionally contains mutex for Notion provider options. */
  readonly mutex?: SingleHostMutex;
  /** Optionally contains now for Notion provider options. */
  readonly now?: () => Date;
  /** Optionally contains target for Notion provider options. */
  readonly target?: WorkspaceSchemaDescriptor;
  /** Contains transport for Notion provider options. */
  readonly transport: NotionTransport;
}

/** Defines runtime services. */
interface RuntimeServices {
  /** Contains pages for runtime services. */
  readonly pages: NotionPageStore;
  /** Contains reader for runtime services. */
  readonly reader: NotionRecordReader;
  /** Provides the Notion intent and lease state store. */
  readonly state: NotionStateStore;
}

/** Implements Notion provider. */
export class NotionProvider implements AgentTaskProvider {
  /** Contains environment for Notion provider. */
  readonly #environment: ProviderEnvironment;
  /** Contains manager for Notion provider. */
  readonly #manager: NotionWorkspaceManager;
  /** Contains mutex for Notion provider. */
  readonly #mutex: SingleHostMutex;
  /** Contains now for Notion provider. */
  readonly #now: () => Date;
  /** Contains target for Notion provider. */
  readonly #target: WorkspaceSchemaDescriptor;
  /** Contains transport for Notion provider. */
  readonly #transport: NotionTransport;

  /** Initializes Notion provider. */
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

  /** Returns capabilities. */
  public async getCapabilities(): Promise<ProviderCapabilities> {
    return new NotionWorkspaceReader(
      this.#environment,
      this.#target,
      this.#transport,
      this.#now,
    ).getCapabilities();
  }

  /** Validates environment. */
  public async validateEnvironment(
    environment: ProviderEnvironment,
  ): Promise<ValidationReport> {
    return new NotionWorkspaceReader(
      environment,
      this.#target,
      this.#transport,
      this.#now,
    ).validateEnvironment();
  }

  /** Validates tables. */
  public async validateTables(): Promise<TableValidationReport> {
    return compareWorkspaceSchema(
      await this.#manager.inspectWorkspaceSchema(),
      this.#target,
    );
  }

  /** Inspects workspace schema without mutation. */
  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    return this.#manager.inspectWorkspaceSchema();
  }

  /** Plans ordered additive workspace changes without applying them. */
  public async planWorkspaceChanges(
    request: WorkspaceSchemaRequest,
  ): Promise<WorkspaceMigrationPlan> {
    return this.#manager.planWorkspaceChanges(request);
  }

  /** Applies workspace step. */
  public async applyWorkspaceStep(
    step: WorkspaceMigrationStep,
  ): Promise<WriteReceipt> {
    return this.#manager.applyWorkspaceStep(step);
  }

  /** Reconciles workspace step against provider state. */
  public async reconcileWorkspaceStep(
    stepId: string,
  ): Promise<ReconciliationResult> {
    return this.#manager.reconcileWorkspaceStep(stepId);
  }

  /** Lists Agent definitions. */
  public async listAgentDefinitions(): Promise<readonly AgentDefinition[]> {
    return (await this.runtime()).reader.listAgentDefinitions();
  }

  /** Returns Agent definition. */
  public async getAgentDefinition(id: string): Promise<AgentDefinition> {
    return (await this.runtime()).reader.getAgentDefinition(id);
  }

  /** Returns Agent activity. */
  public async getAgentActivity(id: string): Promise<AgentActivity> {
    /** Holds the `runtime` intermediate used by `getAgentActivity`. */
    const runtime = await this.runtime();
    /** Defines `observed` for comparison in `getAgentActivity`. */
    const observed = await runtime.pages.getAgentActivity(
      await runtime.reader.getAgentPageId(id),
    );
    if (observed.status !== "Online" && observed.status !== "Offline")
      throw new Error(`Agent activity Status is invalid: ${observed.status}`);
    return {
      status: observed.status,
      taskIds: observed.taskIds,
      version: observed.version,
    };
  }

  /** Returns lease projection. */
  public async getLeaseProjection(id: string): Promise<LeaseProjection> {
    return (await this.runtime()).state.activeProjection(id);
  }

  /** Returns lease snapshot. */
  public async getLeaseSnapshot(
    leaseId: string,
  ): Promise<LeaseSnapshot | null> {
    return (await this.runtime()).state.leaseSnapshot(leaseId);
  }

  /** Lists task status options. */
  public async listTaskStatusOptions(): Promise<readonly string[]> {
    return (await this.runtime()).reader.listTaskStatusOptions();
  }

  /** Updates Agent activity. */
  public async updateAgentActivity(
    change: ActivityMutation,
  ): Promise<WriteReceipt> {
    /** Holds the `runtime` intermediate used by `updateAgentActivity`. */
    const runtime = await this.runtime();
    return runtime.state.runExclusive(async () => {
      /** Holds the `prior` intermediate used by `updateAgentActivity`. */
      const prior = await runtime.state.beginIntent(
        change.idempotencyKey,
        "agent_activity",
        change,
      );
      if (prior !== undefined) return parseWriteReceipt(prior);
      /** Holds the `projection` intermediate used by `updateAgentActivity`. */
      const projection = await runtime.state.activeProjection(change.agentId);
      /** Holds the `activeRuns` intermediate used by `updateAgentActivity`. */
      const activeRuns = projection.runLeaseIds;
      /** Holds the `activeTasks` intermediate used by `updateAgentActivity`. */
      const activeTasks = projection.taskIds;
      if (
        !sameSet(activeRuns, change.nextRunLeaseIds) ||
        !sameSet(activeTasks, change.nextTaskIds)
      ) {
        throw new Error(
          "Agent activity must equal the provider's active lease projection",
        );
      }
      /** Captures `receipt` returned by `updateAgentActivity`. */
      const receipt = await runtime.pages.updateAgentActivity({
        ...change,
        agentId: await runtime.reader.getAgentPageId(change.agentId),
      });
      await runtime.state.completeIntent(
        change.idempotencyKey,
        "agent_activity",
        change,
        receipt,
      );
      return receipt;
    });
  }

  /** Lists task summaries. */
  public async listTaskSummaries(
    query: TaskQuery,
  ): Promise<readonly TaskSummary[]> {
    return (await this.runtime()).reader.listTaskSummaries(query);
  }

  /** Returns task snapshot. */
  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    return (await this.runtime()).reader.getTaskSnapshot(taskId);
  }

  /** Applies task mutation. */
  public async applyTaskMutation(
    mutation: ConditionalTaskMutation,
  ): Promise<WriteReceipt> {
    return this.executeRepairableReceiptIntent(
      mutation.idempotencyKey,
      "task",
      mutation,
      (runtime) => runtime.pages.applyTaskMutation(mutation),
      (runtime) => this.repairPendingTaskIntent(runtime, mutation),
      async (runtime) => {
        /** Holds the `current` intermediate used by `applyTaskMutation`. */
        const current = await runtime.reader.getTaskSnapshot(mutation.taskId);
        if (current.version !== mutation.expectedVersion)
          throw new Error("Task version conflict");
      },
    );
  }

  /** Returns resources. */
  public async getResources(
    refs: readonly ResourceRef[],
  ): Promise<readonly ResourceRecord[]> {
    return (await this.runtime()).reader.getResources(refs);
  }

  /** Returns optional resource. */
  public async getOptionalResource(
    key: string,
  ): Promise<ResourceRecord | null> {
    return (await this.runtime()).reader.getOptionalResource(key);
  }

  /** Persists resource. */
  public async putResource(record: ResourceMutation): Promise<WriteReceipt> {
    if (record.key.startsWith("system/"))
      throw new Error(
        "system/ Resource keys are reserved by Agent Task Manager",
      );
    return this.executeRepairableReceiptIntent(
      record.idempotencyKey,
      "resource",
      record,
      (runtime) => runtime.pages.createResource(record),
      (runtime) => this.repairPendingResourceIntent(runtime, record),
    );
  }

  /** Acquires lease. */
  public async acquireLease(request: LeaseRequest): Promise<LeaseResult> {
    return (await this.runtime()).state.acquireLease(request);
  }

  /** Renews lease. */
  public async renewLease(request: LeaseRenewal): Promise<LeaseResult> {
    return (await this.runtime()).state.renewLease(request);
  }

  /** Releases lease. */
  public async releaseLease(request: LeaseRelease): Promise<WriteReceipt> {
    return (await this.runtime()).state.releaseLease(request);
  }

  /** Creates or updates the Error identified by Error Key. */
  public async createOrUpdateError(
    error: ErrorMutation,
  ): Promise<WriteReceipt> {
    return this.executeRepairableReceiptIntent(
      error.idempotencyKey,
      "error",
      error,
      async (runtime) =>
        runtime.pages.createOrUpdateError(
          await this.physicalError(runtime, error),
        ),
      (runtime) => this.repairPendingErrorIntent(runtime, error),
    );
  }

  /** Reconciles intent against provider state. */
  public async reconcileIntent(
    intentId: string,
  ): Promise<ReconciliationResult> {
    return (await this.runtime()).state.reconcileIntent(intentId);
  }

  /** Returns the Notion workspace bootstrap manager. */
  public workspaceManager(): NotionWorkspaceManager {
    return this.#manager;
  }

  /** Reconciles Agent activity against provider state. */
  public async reconcileAgentActivity(
    agentId: string,
    idempotencyKey: string,
  ): Promise<ReconciliationResult> {
    /** Holds the `runtime` intermediate used by `reconcileAgentActivity`. */
    const runtime = await this.runtime();
    /** Captures `result` returned by `reconcileAgentActivity`. */
    const result = await runtime.state.runExclusive(async () => {
      /** Holds the `projection` intermediate used by `reconcileAgentActivity`. */
      const projection = await runtime.state.activeProjection(agentId);
      /** Holds the `activeRunLeaseIds` intermediate used by `reconcileAgentActivity`. */
      const activeRunLeaseIds = projection.runLeaseIds;
      /** Holds the `activeTaskIds` intermediate used by `reconcileAgentActivity`. */
      const activeTaskIds = projection.taskIds;
      /** Holds the `agentPageId` intermediate used by `reconcileAgentActivity`. */
      const agentPageId = await runtime.reader.getAgentPageId(agentId);
      /** Defines `observed` for comparison in `reconcileAgentActivity`. */
      const observed = await runtime.pages.getAgentActivity(agentPageId);
      /** Defines `expectedStatus` for comparison in `reconcileAgentActivity`. */
      const expectedStatus =
        activeRunLeaseIds.length === 0 ? "Offline" : "Online";
      /** Holds the `basis` intermediate used by `reconcileAgentActivity`. */
      const basis = {
        activeRunLeaseIds,
        activeTaskIds,
        expectedStatus,
        observed,
        agentId,
      };
      if (
        observed.status === expectedStatus &&
        sameSet(observed.taskIds, activeTaskIds)
      )
        return { basis, receipt: null };
      /** Captures `receipt` returned by `reconcileAgentActivity`. */
      const receipt = await runtime.pages.setAgentActivity(
        agentPageId,
        observed.status,
        observed.taskIds,
        expectedStatus,
        activeTaskIds,
        idempotencyKey,
      );
      return { basis, receipt };
    });
    if (result.receipt === null) {
      return {
        evidence: jsonObject(toJsonValue(result.basis), "Activity evidence"),
        state: "not_applied",
      };
    }
    await this.createOrUpdateError({
      description: `Observed activity ${JSON.stringify({ status: result.basis.observed.status, taskIds: result.basis.observed.taskIds })}; expected ${JSON.stringify({ status: result.basis.expectedStatus, taskIds: result.basis.activeTaskIds })}.`,
      errorKey: `stale-agent-activity:${agentId}`,
      idempotencyKey: `error:stale-agent-activity:${digestJson(toJsonValue(result.basis))}`,
      relatedRunId: null,
      relatedAgentId: agentId,
      relatedTaskId: null,
      resolution:
        "The manager reconciled Status and Working On from active provider-backed leases. Investigate the interrupted run or partial provider write.",
      severity: "high",
      status: "Not Fixed",
      title: "Stale agent activity",
    });
    return {
      evidence: {
        basis: toJsonValue(result.basis),
        receipt: toJsonValue(result.receipt),
      },
      state: "applied",
    };
  }

  /** Creates fresh Notion page, record, and state services. */
  private async runtime(): Promise<RuntimeServices> {
    /** Holds the `partial` intermediate used by `runtime`. */
    const partial = await this.#manager.resolveTableIds();
    for (const kind of TABLE_KINDS)
      if (partial[kind] === undefined)
        throw new Error(
          `Notion runtime requires configured or discoverable ${kind} table`,
        );
    /** Holds the `tables` intermediate used by `runtime`. */
    const tables = partial as NotionMutableTableIds;
    /** Holds the `pages` intermediate used by `runtime`. */
    const pages = new NotionPageStore(tables, this.#transport, this.#now);
    return {
      pages,
      reader: new NotionRecordReader(tables, this.#transport),
      state: new NotionStateStore(pages, this.#mutex, this.#now),
    };
  }

  /** Executes repairable receipt intent. */
  private async executeRepairableReceiptIntent(
    idempotencyKey: string,
    operation: string,
    payload: unknown,
    effect: (runtime: RuntimeServices) => Promise<WriteReceipt>,
    repair: (runtime: RuntimeServices) => Promise<WriteReceipt>,
    beforeIntent?: (runtime: RuntimeServices) => Promise<void>,
  ): Promise<WriteReceipt> {
    /** Holds the `runtime` intermediate used by `executeRepairableReceiptIntent`. */
    const runtime = await this.runtime();
    return runtime.state.runExclusive(async () => {
      /** Holds the `prior` intermediate used by `executeRepairableReceiptIntent`. */
      let prior: JsonValue | undefined;
      try {
        prior = await runtime.state.beginIntent(
          idempotencyKey,
          operation,
          payload,
          beforeIntent === undefined ? undefined : () => beforeIntent(runtime),
        );
      } catch (failure) {
        if (!(failure instanceof IndeterminateProviderIntentError))
          throw failure;
        return repair(runtime);
      }
      if (prior !== undefined) return parseWriteReceipt(prior);
      /** Captures `receipt` returned by `executeRepairableReceiptIntent`. */
      const receipt = await effect(runtime);
      await runtime.state.completeIntent(
        idempotencyKey,
        operation,
        payload,
        receipt,
      );
      return receipt;
    });
  }

  /** Repairs pending resource intent after an interrupted provider intent. */
  private async repairPendingResourceIntent(
    runtime: RuntimeServices,
    record: ResourceMutation,
  ): Promise<WriteReceipt> {
    /** Holds the `current` intermediate used by `repairPendingResourceIntent`. */
    const current = await runtime.reader.getOptionalResource(record.key);
    if (current !== null && !sameResource(current, record))
      throw new IndeterminateProviderIntentError(
        `Pending Resource intent conflicts with newer state: ${record.key}`,
      );
    /** Captures `receipt` returned by `repairPendingResourceIntent`. */
    const receipt = await runtime.pages.createResource(record);
    await runtime.state.completeIntent(
      record.idempotencyKey,
      "resource",
      record,
      receipt,
    );
    return receipt;
  }

  /** Repairs pending task intent after an interrupted provider intent. */
  private async repairPendingTaskIntent(
    runtime: RuntimeServices,
    mutation: ConditionalTaskMutation,
  ): Promise<WriteReceipt> {
    /** Holds the `current` intermediate used by `repairPendingTaskIntent`. */
    const current = await runtime.reader.getTaskSnapshot(mutation.taskId);
    if (
      (await runtime.reader.getTaskMutationMarker(mutation.taskId)) ===
        digestJson(toJsonValue(mutation)) &&
      taskMatchesTarget(current, mutation)
    ) {
      /** Captures `receipt` returned by `repairPendingTaskIntent`. */
      const receipt = await runtime.pages.taskReceipt(
        mutation.taskId,
        mutation.idempotencyKey,
      );
      await runtime.state.completeIntent(
        mutation.idempotencyKey,
        "task",
        mutation,
        receipt,
      );
      return receipt;
    }
    if (
      mutation.nextBody !== null &&
      (await runtime.reader.getTaskBodyMutationMarker(mutation.taskId)) ===
        digestJson(toJsonValue(mutation)) &&
      normalizeText(current.body) === normalizeText(mutation.nextBody)
    ) {
      /** Captures `receipt` returned by `repairPendingTaskIntent`. */
      const receipt =
        await runtime.pages.completeMarkedTaskProperties(mutation);
      await runtime.state.completeIntent(
        mutation.idempotencyKey,
        "task",
        mutation,
        receipt,
      );
      return receipt;
    }
    if (current.version !== mutation.expectedVersion) {
      throw new IndeterminateProviderIntentError(
        `Pending Task intent conflicts with newer state: ${mutation.taskId}`,
      );
    }
    /** Captures `receipt` returned by `repairPendingTaskIntent`. */
    const receipt = await runtime.pages.applyTaskMutation(mutation);
    await runtime.state.completeIntent(
      mutation.idempotencyKey,
      "task",
      mutation,
      receipt,
    );
    return receipt;
  }

  /** Repairs pending error intent after an interrupted provider intent. */
  private async repairPendingErrorIntent(
    runtime: RuntimeServices,
    error: ErrorMutation,
  ): Promise<WriteReceipt> {
    /** Holds the `physical` intermediate used by `repairPendingErrorIntent`. */
    const physical = await this.physicalError(runtime, error);
    /** Holds the `exact` intermediate used by `repairPendingErrorIntent`. */
    let exact: WriteReceipt | null;
    try {
      exact = await runtime.pages.errorTargetReceipt(physical);
    } catch (failure) {
      throw new IndeterminateProviderIntentError(
        failure instanceof Error
          ? failure.message
          : "Pending Error intent conflicts with newer state",
      );
    }
    /** Captures `receipt` returned by `repairPendingErrorIntent`. */
    const receipt =
      exact ?? (await runtime.pages.createOrUpdateError(physical));
    await runtime.state.completeIntent(
      error.idempotencyKey,
      "error",
      error,
      receipt,
    );
    return receipt;
  }

  /** Replaces logical Error relations with physical Notion page IDs. */
  private async physicalError(
    runtime: RuntimeServices,
    error: ErrorMutation,
  ): Promise<ErrorMutation> {
    return {
      ...error,
      relatedAgentId:
        error.relatedAgentId === null
          ? null
          : await runtime.reader.getAgentPageId(error.relatedAgentId),
    };
  }
}

/** Requires a JSON object and returns its validated representation. */
function jsonObject(value: JsonValue | undefined, label: string): JsonObject {
  /** Holds the `checked` intermediate used by `jsonObject`. */
  const checked = toJsonValue(value);
  if (checked === null || typeof checked !== "object" || Array.isArray(checked))
    throw new TypeError(`${label} must be an object`);
  return checked;
}

/** Compares two string collections as normalized sets. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    [...new Set(left)].sort().join("\0") ===
    [...new Set(right)].sort().join("\0")
  );
}

/** Reports whether a Resource record exactly matches a mutation target. */
function sameResource(
  current: ResourceRecord,
  requested: ResourceMutation,
): boolean {
  return (
    current.body === requested.body &&
    current.digest === requested.digest &&
    current.key === requested.key &&
    current.kind === requested.kind &&
    current.state === requested.state &&
    current.version === requested.version &&
    digestJson(toJsonValue(current.dependencies)) ===
      digestJson(toJsonValue(requested.dependencies))
  );
}

/** Reports whether a Task snapshot matches a conditional mutation target. */
function taskMatchesTarget(
  current: TaskSnapshot,
  mutation: ConditionalTaskMutation,
): boolean {
  if (
    mutation.nextBody !== null &&
    normalizeText(current.body) !== normalizeText(mutation.nextBody)
  )
    return false;
  /** Holds the `targetStatus` intermediate used by `taskMatchesTarget`. */
  const targetStatus = mutation.nextStatus ?? current.status;
  if (current.status !== targetStatus) return false;
  for (const [name, target] of Object.entries(
    taskPropertiesWithStatus(mutation.nextProperties, targetStatus),
  )) {
    if (name === NOTION_TASK_MUTATION_PROPERTY) continue;
    /** Defines `observed` for comparison in `taskMatchesTarget`. */
    const observed = current.properties[name];
    if (observed === undefined || digestJson(observed) !== digestJson(target))
      return false;
  }
  return true;
}

/** Normalizes text. */
function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}
