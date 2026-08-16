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
  OperationMutation,
  OperationRecord,
  ResourceRef,
  AgentDefinition,
  AgentActivity,
  TaskQuery,
  TaskSnapshot,
  TaskSummary,
} from "../../domain/records.js";
import { RESOURCE_KINDS } from "../../domain/records.js";
import type {
  ProviderCapabilities,
  ProviderEnvironment,
  ProviderOperationIntent,
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
import { digestJson, sha256 } from "../../core/digest.js";
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
import {
  canonicalResourceMarkdown,
  isMarkdownResourceKind,
} from "./notion-resource-markdown.js";

/** Inputs accepted by Notion provider. */
export interface NotionProviderOptions {
  /** Validated provider environment. */
  readonly environment: ProviderEnvironment;
  /** Environment identifier included in provider identity and mutex namespacing. */
  readonly environmentId: string;
  /** Optionally contains mutex for Notion provider options. */
  readonly mutex?: SingleHostMutex;
  /** Optionally contains now for Notion provider options. */
  readonly now?: () => Date;
  /** Optionally contains target for Notion provider options. */
  readonly target?: WorkspaceSchemaDescriptor;
  /** Notion transport used for provider requests. */
  readonly transport: NotionTransport;
}

/** Provider-neutral runtime services contract. */
interface RuntimeServices {
  /** Mutable Notion page-store boundary. */
  readonly pages: NotionPageStore;
  /** Read-only Notion schema and record boundary. */
  readonly reader: NotionRecordReader;
  /** Durable intent and lease store sharing the resolved Notion tables. */
  readonly state: NotionStateStore;
}

/** Implements Notion provider. */
export class NotionProvider implements AgentTaskProvider {
  /** Validated provider environment. */
  readonly #environment: ProviderEnvironment;
  /** Manager callback invoked by Notion provider. */
  readonly #manager: NotionWorkspaceManager;
  /** Mutex callback invoked by Notion provider. */
  readonly #mutex: SingleHostMutex;
  /** Now callback invoked by Notion provider. */
  readonly #now: () => Date;
  /** Canonical target workspace schema. */
  readonly #target: WorkspaceSchemaDescriptor;
  /** Notion transport used for provider requests. */
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

  /** Returns the immutable capability contract advertised by this adapter. */
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

  /** Returns agent definitions in deterministic order. */
  public async listAgentDefinitions(): Promise<readonly AgentDefinition[]> {
    return (await this.runtime()).reader.listAgentDefinitions();
  }

  /** Returns Agent definition. */
  public async getAgentDefinition(id: string): Promise<AgentDefinition> {
    return (await this.runtime()).reader.getAgentDefinition(id);
  }

  /** Returns Agent activity. */
  public async getAgentActivity(id: string): Promise<AgentActivity> {
    /** Initialized adapter state used for activity and lease projections. */
    const runtime = await this.runtime();
    /** Expected observed used to validate `getAgentActivity`. */
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

  /** Returns task status options in deterministic order. */
  public async listTaskStatusOptions(): Promise<readonly string[]> {
    return (await this.runtime()).reader.listTaskStatusOptions();
  }

  /** Updates Agent activity. */
  public async updateAgentActivity(
    change: ActivityMutation,
  ): Promise<WriteReceipt> {
    /** Initialized adapter state whose mutex serializes activity projection. */
    const runtime = await this.runtime();
    return runtime.state.runExclusive(async () => {
      /** Current activity state checked against the caller's expected version. */
      const prior = await runtime.state.beginIntent(
        change.idempotencyKey,
        "agent_activity",
        change,
      );
      if (prior !== undefined) return parseWriteReceipt(prior);
      /** Active lease projection that determines Status and Working On. */
      const projection = await runtime.state.activeProjection(change.agentId);
      /** Run-lease count that exclusively determines Online status. */
      const activeRuns = projection.runLeaseIds;
      /** Canonically ordered Task relations derived from assignment leases. */
      const activeTasks = projection.taskIds;
      if (
        !sameSet(activeRuns, change.nextRunLeaseIds) ||
        !sameSet(activeTasks, change.nextTaskIds)
      ) {
        throw new Error(
          "Agent activity must equal the provider's active lease projection",
        );
      }
      /** Result of `updateAgentActivity`, retained for validation and reuse. */
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

  /** Returns task summaries in deterministic order. */
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
        /** Current Task snapshot used to distinguish replay from conflict. */
        const current = await runtime.reader.getTaskSnapshot(mutation.taskId);
        if (current.version !== mutation.expectedVersion)
          throw new Error("Task version conflict");
      },
    );
  }

  /** Resolves exact active Resource references through the Notion reader. */
  public async getResources(
    refs: readonly ResourceRef[],
  ): Promise<readonly ResourceRecord[]> {
    return (await this.runtime()).reader.getResources(refs);
  }

  /** Returns an active Resource by key, or null when no such Resource exists. */
  public async getOptionalResource(
    key: string,
  ): Promise<ResourceRecord | null> {
    return (await this.runtime()).reader.getOptionalResource(key);
  }

  /** Canonicalizes and durably creates or replaces a content Resource. */
  public async putResource(record: ResourceMutation): Promise<WriteReceipt> {
    if (
      !RESOURCE_KINDS.includes(record.kind as (typeof RESOURCE_KINDS)[number])
    )
      throw new TypeError(`Resource kind is invalid: ${record.kind}`);
    return this.writeResource(record);
  }

  /** Returns manager-owned operational state by stable key. */
  public async getOptionalOperation(
    key: string,
  ): Promise<OperationRecord | null> {
    return (await this.runtime()).reader.getOptionalOperation(key);
  }

  /** Persists manager-owned operational state in the Operations table. */
  public async putOperation(record: OperationMutation): Promise<WriteReceipt> {
    const prepared = prepareNotionOperation(record);
    return this.executeRepairableReceiptIntent(
      prepared.idempotencyKey,
      "operation_record",
      prepared,
      (runtime) => runtime.pages.createOperation(prepared),
      async (runtime) => {
        const current = await runtime.reader.getOptionalOperation(prepared.key);
        if (current !== null && !sameResource(current, prepared))
          throw new IndeterminateProviderIntentError(
            `Pending Operation intent conflicts with newer state: ${prepared.key}`,
          );
        const receipt = await runtime.pages.createOperation(prepared);
        await runtime.state.completeIntent(
          prepared.idempotencyKey,
          "operation_record",
          prepared,
          receipt,
        );
        return receipt;
      },
    );
  }

  /** Canonicalizes and durably creates or replaces one accepted Resource. */
  private async writeResource(record: ResourceMutation): Promise<WriteReceipt> {
    /** Canonical mutation bound to the durable intent and physical page write. */
    const prepared = prepareNotionResource(record);
    return this.executeRepairableReceiptIntent(
      prepared.idempotencyKey,
      "resource",
      prepared,
      (runtime) => runtime.pages.createResource(prepared),
      (runtime) => this.repairPendingResourceIntent(runtime, prepared),
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

  /** Returns a durable logical-operation intent. */
  public async getOperationIntent(
    intentId: string,
  ): Promise<ProviderOperationIntent | null> {
    return (await this.runtime()).state.operationIntent(intentId);
  }

  /** Creates or validates a pending logical-operation intent. */
  public async beginOperationIntent(
    intentId: string,
    operation: string,
    payload: JsonValue,
  ): Promise<ProviderOperationIntent> {
    /** Initialized adapter state whose mutex serializes intent creation. */
    const runtime = await this.runtime();
    return runtime.state.runExclusive(async () => {
      /** Existing logical operation, if another attempt already prepared it. */
      const existing = await runtime.state.operationIntent(intentId);
      if (existing !== null) {
        assertOperationIntent(existing, operation, payload);
        return existing;
      }
      await runtime.state.beginIntent(intentId, operation, payload);
      /** Newly persisted intent read back from provider-owned state. */
      const created = await runtime.state.operationIntent(intentId);
      if (created === null)
        throw new Error(`Intent ${intentId} was not created`);
      return created;
    });
  }

  /** Completes a matching logical-operation intent. */
  public async completeOperationIntent(
    intentId: string,
    operation: string,
    payload: JsonValue,
    result: JsonValue,
  ): Promise<ProviderOperationIntent> {
    /** Initialized adapter state whose mutex serializes intent completion. */
    const runtime = await this.runtime();
    return runtime.state.runExclusive(async () => {
      /** Existing intent used to validate replay identity and completed results. */
      const existing = await runtime.state.operationIntent(intentId);
      if (existing === null) {
        await runtime.state.beginIntent(intentId, operation, payload);
      } else {
        assertOperationIntent(existing, operation, payload);
        if (existing.state === "applied") {
          if (digestJson(existing.result) !== digestJson(result)) {
            throw new Error(
              `Intent ${intentId} result changed before completion`,
            );
          }
          return existing;
        }
      }
      await runtime.state.completeIntent(intentId, operation, payload, result);
      /** Completed intent read back to return the provider's authoritative result. */
      const completed = await runtime.state.operationIntent(intentId);
      if (completed === null)
        throw new Error(`Intent ${intentId} was not completed`);
      return completed;
    });
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
    /** Initialized adapter state whose mutex serializes reconciliation. */
    const runtime = await this.runtime();
    /** Result of `reconcileAgentActivity`, retained for validation and reuse. */
    const result = await runtime.state.runExclusive(async () => {
      /** Active leases that define the expected agent projection. */
      const projection = await runtime.state.activeProjection(agentId);
      /** Canonically ordered active run-lease identifiers. */
      const activeRunLeaseIds = projection.runLeaseIds;
      /** Canonically ordered Tasks from active assignment leases. */
      const activeTaskIds = projection.taskIds;
      /** Notion page identifier for the reconciled agent row. */
      const agentPageId = await runtime.reader.getAgentPageId(agentId);
      /** Expected observed used to validate `reconcileAgentActivity`. */
      const observed = await runtime.pages.getAgentActivity(agentPageId);
      /** Expected status used to validate `reconcileAgentActivity`. */
      const expectedStatus =
        activeRunLeaseIds.length === 0 ? "Offline" : "Online";
      /** Digest-bound live activity basis used by the conditional replacement. */
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
      /** Result of `reconcileAgentActivity`, retained for validation and reuse. */
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
    /** Lazily initialized adapter components shared by subsequent calls. */
    const partial = await this.#manager.resolveTableIds();
    for (const kind of TABLE_KINDS)
      if (partial[kind] === undefined)
        throw new Error(
          `Notion runtime requires configured or discoverable ${kind} table`,
        );
    /** Resolved physical data-source identifiers for all logical tables. */
    const tables = partial as NotionMutableTableIds;
    /** Page-store adapter bound to the resolved table identities. */
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
    /** Initialized adapter state used for the write and durable repair intent. */
    const runtime = await this.runtime();
    return runtime.state.runExclusive(async () => {
      /** Existing matching intent reconciled before any new external write. */
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
      /** Result of `executeRepairableReceiptIntent`, retained for validation and reuse. */
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
    /** Reads a complete target when the normal aggregate remains decodable. */
    let current: ResourceRecord | null;
    try {
      current = await runtime.reader.getOptionalResource(record.key);
    } catch (error) {
      /** Repairs only a property-staged target whose raw metadata matches exactly. */
      if (!(await runtime.pages.resourceTargetMetadataMatches(record))) {
        throw new IndeterminateProviderIntentError(
          `Pending Resource intent cannot classify provider state: ${record.key}`,
          { cause: error },
        );
      }
      current = null;
    }
    if (current !== null && !sameResource(current, record))
      throw new IndeterminateProviderIntentError(
        `Pending Resource intent conflicts with newer state: ${record.key}`,
      );
    /** Result of `repairPendingResourceIntent`, retained for validation and reuse. */
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
    /** Current Task snapshot compared with the frozen conditional target. */
    const current = await runtime.reader.getTaskSnapshot(mutation.taskId);
    if (
      (await runtime.reader.getTaskMutationMarker(mutation.taskId)) ===
        digestJson(toJsonValue(mutation)) &&
      taskMatchesTarget(current, mutation)
    ) {
      /** Result of `repairPendingTaskIntent`, retained for validation and reuse. */
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
      /** Result of `repairPendingTaskIntent`, retained for validation and reuse. */
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
    /** Result of `repairPendingTaskIntent`, retained for validation and reuse. */
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
    /** Provider-shaped Error mutation including resolved relation identifiers. */
    const physical = await this.physicalError(runtime, error);
    /** Existing exact Error target receipt, if the interrupted write completed. */
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
    /** Result of `repairPendingErrorIntent`, retained for validation and reuse. */
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
  /** JSON-compatible non-array object accepted for provider persistence. */
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
  current: ResourceRecord | OperationRecord,
  requested: ResourceMutation | OperationMutation,
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

/** Canonicalizes and digest-binds a Notion Resource before any provider write. */
function prepareNotionResource(record: ResourceMutation): ResourceMutation {
  /** Canonical representation used by both the digest and the physical write. */
  const canonicalBody = isMarkdownResourceKind(record.kind)
    ? canonicalResourceMarkdown(record.body)
    : normalizeText(record.body);
  if (record.digest !== sha256(canonicalBody)) {
    throw new TypeError(
      `Resource ${record.key} Digest must match its canonical body`,
    );
  }
  return { ...structuredClone(record), body: canonicalBody };
}

/** Canonicalizes and digest-binds operational state before any provider write. */
function prepareNotionOperation(record: OperationMutation): OperationMutation {
  const body = normalizeText(record.body);
  if (record.digest !== sha256(body))
    throw new TypeError(
      `Operation ${record.key} Digest must match its canonical body`,
    );
  return { ...structuredClone(record), body };
}

/** Rejects logical-operation intent reuse with a different payload. */
function assertOperationIntent(
  intent: ProviderOperationIntent,
  operation: string,
  payload: JsonValue,
): void {
  if (
    intent.operation !== operation ||
    digestJson(intent.payload) !== digestJson(payload)
  ) {
    throw new Error(
      `Idempotency key ${intent.idempotencyKey} was reused with a different operation or payload`,
    );
  }
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
  /** Status expected after applying the conditional Task mutation. */
  const targetStatus = mutation.nextStatus ?? current.status;
  if (current.status !== targetStatus) return false;
  for (const [name, target] of Object.entries(
    taskPropertiesWithStatus(mutation.nextProperties, targetStatus),
  )) {
    if (name === NOTION_TASK_MUTATION_PROPERTY) continue;
    /** Expected observed used to validate `taskMatchesTarget`. */
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
