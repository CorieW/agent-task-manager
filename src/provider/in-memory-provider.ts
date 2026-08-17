/** Implements the deterministic in-memory reference provider used for conformance and orchestration tests. */
import { randomUUID } from "node:crypto";

import { digestJson } from "../core/digest.js";
import { IdempotencyLedger } from "../core/idempotency-ledger.js";
import { finalizeMigrationPlan } from "../core/migration-plan.js";
import { pageAfter } from "../core/pagination.js";
import { compareWorkspaceSchema } from "../core/schema-diff.js";
import { sameStringSet } from "../core/string-set.js";
import { taskPropertiesWithStatus } from "../core/task-properties.js";
import { taskSummaryMatchesPredicate } from "../core/task-query-contract.js";
import { toJsonValue, type JsonValue } from "../domain/json.js";
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
  AgentActivity,
  AgentDefinition,
  TaskQuery,
  TaskSnapshot,
  TaskSummary,
} from "../domain/records.js";
import { RESOURCE_KINDS } from "../domain/records.js";
import type {
  ProviderCapabilities,
  ProviderEnvironment,
  ProviderOperationIntent,
  ReconciliationResult,
  TableKind,
  ValidationIssue,
  ValidationReport,
  WriteReceipt,
} from "../domain/provider.js";
import type {
  ObservedProperty,
  ObservedTable,
  PropertyDescriptor,
  TableValidationReport,
  WorkspaceMigrationPlan,
  WorkspaceMigrationStep,
  WorkspaceSchemaDescriptor,
  WorkspaceSchemaRequest,
  WorkspaceSchemaSnapshot,
} from "../domain/schema.js";
import type { AgentTaskProvider } from "./agent-task-provider.js";

/** Provider-neutral memory lease contract. */
interface MemoryLease extends LeaseRequest {
  /** Stable identifier for memory lease. */
  readonly id: string;
}

/** Provider-neutral memory activity contract. */
interface MemoryActivity {
  /** Ordered run lease IDs for memory activity. */
  readonly runLeaseIds: readonly string[];
  /** Ordered task IDs for memory activity. */
  readonly taskIds: readonly string[];
}

/** One provider-neutral logical operation for durable-style replay. */
interface MemoryOperationIntent extends ProviderOperationIntent {
  /** Digest used to reject payload changes under one idempotency key. */
  readonly payloadDigest: string;
}

/** Returns the Task ID dependency consumed by a task-assignment lease. */
function requiredLeaseTask(lease: MemoryLease): string {
  if (lease.taskId === null)
    throw new Error("Task-assignment lease is missing its Task");
  return lease.taskId;
}

/** Reports whether two leases address the same logical slot. */
function sameLeaseSlot(left: MemoryLease, right: LeaseRequest): boolean {
  if (left.scope !== right.scope) return false;
  return left.scope === "agent_run"
    ? left.agentId === right.agentId && left.ownerId === right.ownerId
    : left.taskId === right.taskId;
}

/** Table kinds in dependency-safe bootstrap order. */
const TABLE_ORDER: readonly TableKind[] = [
  "resources",
  "errors",
  "tasks",
  "agents",
];

/** Allowlist of Task fields accepted by summary predicates. */
const TASK_SUMMARY_KEYS = new Set([
  "archived",
  "id",
  "priority",
  "status",
  "title",
  "version",
]);

/** Returns a detached structured clone of the supplied value. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Digests a canonical workspace-table snapshot. */
function snapshotDigest(tables: readonly ObservedTable[]): string {
  /** Derived normalized value for `snapshotDigest`. */
  const normalized = [...tables]
    .map((table) => ({
      ...table,
      managedRanges: [...table.managedRanges].sort(),
      properties: [...table.properties].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return digestJson(toJsonValue(normalized));
}

/** Projects a target property into observed workspace metadata. */
function observedProperty(
  property: PropertyDescriptor,
  target: WorkspaceSchemaDescriptor,
): ObservedProperty {
  /** Related table kind declared by the target property. */
  const targetKind = property.targetTable;
  /** Target table descriptor used to synthesize the relation identifier. */
  const targetTable =
    targetKind === null
      ? null
      : target.tables.find((table) => table.kind === targetKind);
  return {
    name: property.physicalName,
    providerMetadata: {},
    targetTableId: targetTable == null ? null : `memory:${targetTable.kind}`,
    type: property.type,
    writable: property.writable,
  };
}

/** Projects a target table into observed workspace metadata. */
function observedTable(
  kind: TableKind,
  target: WorkspaceSchemaDescriptor,
): ObservedTable {
  /** Result of `target.tables.find`, retained for `observedTable`. */
  const descriptor = target.tables.find((table) => table.kind === kind);
  if (descriptor === undefined) throw new Error(`Unknown table kind: ${kind}`);
  return {
    id: `memory:${descriptor.kind}`,
    kind: descriptor.kind,
    managedRanges: [...descriptor.managedRanges],
    properties: descriptor.properties.map((property) =>
      observedProperty(property, target),
    ),
    title: descriptor.title,
    version: "1",
  };
}

/** Generates the next table version after a migration. */
function nextTableVersion(version: string): string {
  /** Result of `Number.parseInt`, retained for `nextTableVersion`. */
  const parsed = Number.parseInt(version, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? String(parsed + 1)
    : randomUUID();
}

/** Applies one migration step to an in-memory workspace snapshot. */
function evolveSnapshot(
  snapshot: WorkspaceSchemaSnapshot,
  step: Omit<WorkspaceMigrationStep, "expectedPostSchemaDigest">,
  target: WorkspaceSchemaDescriptor,
  capturedAt: string,
): WorkspaceSchemaSnapshot {
  /** Kind snapshot used consistently during `evolveSnapshot`. */
  const kind = step.payload.kind;
  if (typeof kind !== "string" || !TABLE_ORDER.includes(kind as TableKind)) {
    throw new Error(`Migration step ${step.id} has an invalid table kind`);
  }
  /** Result of `clone`, retained for `evolveSnapshot`. */
  const tableKind = kind as TableKind;
  /** Result of `clone`, retained for `evolveSnapshot`. */
  let tables = clone(snapshot.tables);

  if (step.kind === "create_table") {
    if (!tables.some((table) => table.kind === tableKind)) {
      tables = [...tables, observedTable(tableKind, target)];
    }
  } else if (step.kind === "add_property" || step.kind === "add_relation") {
    /** Result of `target.tables.find`, retained for `evolveSnapshot`. */
    const physicalName = step.payload.physicalName;
    if (typeof physicalName !== "string")
      throw new Error(`Migration step ${step.id} has no property`);
    /** Result of `target.tables.find`, retained for `evolveSnapshot`. */
    const descriptor = target.tables.find((table) => table.kind === tableKind);
    /** Result of `tables.map`, retained for `evolveSnapshot`. */
    const property = descriptor?.properties.find(
      (candidate) => candidate.physicalName === physicalName,
    );
    if (property === undefined)
      throw new Error(`Unknown target property: ${tableKind}.${physicalName}`);
    tables = tables.map((table) =>
      table.kind !== tableKind ||
      table.properties.some((candidate) => candidate.name === physicalName)
        ? table
        : {
            ...table,
            properties: [
              ...table.properties,
              observedProperty(property, target),
            ],
            version: nextTableVersion(table.version),
          },
    );
  } else if (step.kind === "add_managed_range") {
    /** Result of `tables.map`, retained for `evolveSnapshot`. */
    const managedRange = step.payload.managedRange;
    if (typeof managedRange !== "string") {
      throw new Error(`Migration step ${step.id} has no managed range`);
    }
    tables = tables.map((table) =>
      table.kind !== tableKind || table.managedRanges.includes(managedRange)
        ? table
        : {
            ...table,
            managedRanges: [...table.managedRanges, managedRange],
            version: nextTableVersion(table.version),
          },
    );
  } else {
    throw new Error(`Unsupported in-memory migration step: ${step.kind}`);
  }

  return {
    capturedAt,
    digest: snapshotDigest(tables),
    providerIdentity: snapshot.providerIdentity,
    tables,
  };
}

/** Implements the deterministic in-memory provider used by conformance tests. */
export class InMemoryProvider implements AgentTaskProvider {
  /** Completedworkspacesteps dependency consumed by in-memory provider. */
  readonly #completedWorkspaceSteps = new Set<string>();
  /** Activities dependency consumed by in-memory provider. */
  readonly #activities = new Map<string, MemoryActivity>();
  /** Definitions dependency consumed by in-memory provider. */
  readonly #definitions = new Map<string, AgentDefinition>();
  /** Entityversions dependency consumed by in-memory provider. */
  readonly #entityVersions = new Map<string, number>();
  /** Errors table data-source identifier. */
  readonly #errors = new Map<string, Omit<ErrorMutation, "idempotencyKey">>();
  /** Idempotency dependency consumed by in-memory provider. */
  readonly #idempotency = new IdempotencyLedger();
  /** Intentoutcomes dependency consumed by in-memory provider. */
  readonly #intentOutcomes = new Map<string, ReconciliationResult>();
  /** Preparedlogical operationintents dependency consumed by in-memory provider. */
  readonly #operationIntents = new Map<string, MemoryOperationIntent>();
  /** Leases dependency consumed by in-memory provider. */
  readonly #leases = new Map<string, MemoryLease>();
  /** Releasedleases dependency consumed by in-memory provider. */
  readonly #releasedLeases = new Map<string, MemoryLease>();
  /** Resources table data-source identifier. */
  readonly #resources = new Map<string, ResourceRecord>();
  /** Manager-owned operational records keyed by stable identity. */
  readonly #operations = new Map<string, OperationRecord>();
  /** Tasks table data-source identifier. */
  readonly #tasks = new Map<string, TaskSnapshot>();
  /** Taskstatusoptions dependency consumed by in-memory provider. */
  readonly #taskStatusOptions = new Set<string>();
  /** Workspaceoutcomes dependency consumed by in-memory provider. */
  readonly #workspaceOutcomes = new Map<string, ReconciliationResult>();
  /** Validated provider environment. */
  #snapshot: WorkspaceSchemaSnapshot;

  /** Initializes in-memory provider. */
  public constructor(
    /** Environment callback invoked by in-memory provider. */ private readonly environment: ProviderEnvironment,
    /** Target callback invoked by in-memory provider. */ private readonly target: WorkspaceSchemaDescriptor,
    snapshot?: WorkspaceSchemaSnapshot,
    /** Now callback invoked by in-memory provider. */ private readonly now: () => Date = () =>
      new Date(),
  ) {
    this.#snapshot = clone(
      snapshot ?? {
        capturedAt: new Date(0).toISOString(),
        digest: digestJson([]),
        providerIdentity: "memory",
        tables: [],
      },
    );
  }

  /** Seeds definition. */
  public seedDefinition(definition: AgentDefinition): void {
    this.#definitions.set(definition.id, clone(definition));
    if (!this.#activities.has(definition.id)) {
      this.#activities.set(definition.id, { runLeaseIds: [], taskIds: [] });
    }
  }

  /** Seeds task. */
  public seedTask(task: TaskSnapshot): void {
    this.#tasks.set(task.id, clone(task));
    this.#taskStatusOptions.add(task.status);
  }

  /** Seeds task status options. */
  public seedTaskStatusOptions(options: readonly string[]): void {
    for (const option of options) {
      if (option === "")
        throw new TypeError("Task status options must be non-empty");
      this.#taskStatusOptions.add(option);
    }
  }

  /** Returns capabilities. */
  public async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      archive: true,
      attachments: true,
      conditionalWrites: "atomic",
      deterministicPagination: true,
      idempotencyLookup: true,
      leases: "atomic",
      managedContent: true,
      relations: true,
      schemaDiscovery: true,
      schemaMutation: true,
      stableRecordIds: true,
    };
  }

  /** Validates environment. */
  public async validateEnvironment(
    environment: ProviderEnvironment,
  ): Promise<ValidationReport> {
    /** Mutable state shared across `validateEnvironment`. */
    const issues: ValidationIssue[] = [];
    if (environment.type !== "memory") {
      issues.push({
        code: "unsupported_provider_type",
        message: `In-memory provider cannot use provider type ${environment.type}`,
        path: "provider.type",
        severity: "error",
      });
    }
    return { issues, valid: issues.length === 0 };
  }

  /** Inspects workspace schema without mutation. */
  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    return clone(this.#snapshot);
  }

  /** Validates tables. */
  public async validateTables(): Promise<TableValidationReport> {
    return compareWorkspaceSchema(clone(this.#snapshot), this.target);
  }

  /** Plans ordered additive workspace changes without applying them. */
  public async planWorkspaceChanges(
    request: WorkspaceSchemaRequest,
  ): Promise<WorkspaceMigrationPlan> {
    /** Result of `compareWorkspaceSchema`, retained for `planWorkspaceChanges`. */
    const report = compareWorkspaceSchema(request.observed, request.target);
    if (report.state === "blocked_incompatible") {
      throw new Error(
        "Cannot plan additive changes over incompatible workspace schema",
      );
    }

    /** Result of `request.target.tables.find`, retained for `planWorkspaceChanges`. */
    const drafts: Array<
      Pick<WorkspaceMigrationStep, "id" | "kind" | "payload">
    > = [];
    for (const kind of TABLE_ORDER) {
      /** Target table descriptor used to derive missing migration steps. */
      const expected = request.target.tables.find(
        (table) => table.kind === kind,
      );
      if (expected === undefined) continue;
      /** Expected observed used to validate `planWorkspaceChanges`. */
      const observed = request.observed.tables.find(
        (table) => table.kind === kind,
      );
      if (observed === undefined) {
        drafts.push({
          id: `create:${kind}`,
          kind: "create_table",
          payload: { kind },
        });
        continue;
      }
      for (const property of expected.properties) {
        if (
          !observed.properties.some(
            (candidate) => candidate.name === property.physicalName,
          )
        ) {
          drafts.push({
            id: `property:${kind}:${property.physicalName}`,
            kind:
              property.targetTable === null ? "add_property" : "add_relation",
            payload: { kind, physicalName: property.physicalName },
          });
        }
      }
      for (const managedRange of expected.managedRanges) {
        if (!observed.managedRanges.includes(managedRange)) {
          drafts.push({
            id: `range:${kind}:${managedRange}`,
            kind: "add_managed_range",
            payload: { kind, managedRange },
          });
        }
      }
    }

    /** Result of `clone`, retained for `planWorkspaceChanges`. */
    let simulated = clone(request.observed);
    /** Result of `steps.at`, retained for `planWorkspaceChanges`. */
    const steps: WorkspaceMigrationStep[] = [];
    for (const draft of drafts) {
      /** Result of `steps.at`, retained for `planWorkspaceChanges`. */
      const previous = steps.at(-1);
      /** Partial snapshot used consistently during `planWorkspaceChanges`. */
      const partial = {
        dependsOn: previous === undefined ? [] : [previous.id],
        expectedPreSchemaDigest: simulated.digest,
        id: draft.id,
        kind: draft.kind,
        payload: draft.payload,
        reversibility: "additive" as const,
      };
      /** Result of `evolveSnapshot`, retained for `planWorkspaceChanges`. */
      const next = evolveSnapshot(
        simulated,
        partial,
        request.target,
        simulated.capturedAt,
      );
      /** Step snapshot used consistently during `planWorkspaceChanges`. */
      const step: WorkspaceMigrationStep = {
        ...partial,
        expectedPostSchemaDigest: next.digest,
      };
      steps.push(step);
      simulated = next;
    }

    return finalizeMigrationPlan({
      environmentId: request.environmentId,
      mode: request.mode,
      observedSchemaDigest: request.observed.digest,
      parentIdentity: this.environment.bootstrapParent,
      providerIdentity: request.observed.providerIdentity,
      steps,
      targetSchemaDigest: request.target.digest,
      targetSchemaVersion: request.target.version,
    });
  }

  /** Applies workspace step. */
  public async applyWorkspaceStep(
    step: WorkspaceMigrationStep,
  ): Promise<WriteReceipt> {
    /** Result of `this.lookupIdempotent`, retained for `applyWorkspaceStep`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      step.id,
      "workspace_step",
      step,
    );
    if (prior !== undefined) return prior;
    if (
      step.dependsOn.some(
        (dependency) => !this.#completedWorkspaceSteps.has(dependency),
      )
    ) {
      throw new Error(`Migration step dependencies are incomplete: ${step.id}`);
    }
    if (this.#snapshot.digest !== step.expectedPreSchemaDigest) {
      throw new Error(`Migration precondition changed: ${step.id}`);
    }
    /** Result of `evolveSnapshot`, retained for `applyWorkspaceStep`. */
    const next = evolveSnapshot(
      this.#snapshot,
      step,
      this.target,
      this.now().toISOString(),
    );
    if (next.digest !== step.expectedPostSchemaDigest) {
      throw new Error(
        `Migration postcondition does not match plan: ${step.id}`,
      );
    }
    this.#snapshot = next;
    this.#completedWorkspaceSteps.add(step.id);
    /** Result of `next.tables.find`, retained for `applyWorkspaceStep`. */
    const kind = step.payload.kind as TableKind;
    /** Result of `next.tables.find`, retained for `applyWorkspaceStep`. */
    const table = next.tables.find((candidate) => candidate.kind === kind);
    if (table === undefined)
      throw new Error(`Migration did not produce table: ${kind}`);
    /** Durable receipt for the completed workspace migration step. */
    const receipt = this.receipt(kind, table.id, step.id, table.version);
    this.recordIdempotent(
      step.id,
      "workspace_step",
      step,
      receipt,
      this.#workspaceOutcomes,
    );
    return clone(receipt);
  }

  /** Reconciles workspace step against provider state. */
  public async reconcileWorkspaceStep(
    stepId: string,
  ): Promise<ReconciliationResult> {
    return clone(
      this.#workspaceOutcomes.get(stepId) ?? {
        evidence: {},
        state: "not_applied",
      },
    );
  }

  /** Returns Agent definitions ordered by stable identifier. */
  public async listAgentDefinitions(): Promise<readonly AgentDefinition[]> {
    return [...this.#definitions.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((definition) => clone(definition));
  }

  /** Returns Agent definition. */
  public async getAgentDefinition(id: string): Promise<AgentDefinition> {
    /** Requested definition, if its identifier is registered. */
    const definition = this.#definitions.get(id);
    if (definition === undefined)
      throw new Error(`Unknown Agent definition: ${id}`);
    return clone(definition);
  }

  /** Returns Agent activity. */
  public async getAgentActivity(id: string): Promise<AgentActivity> {
    if (!this.#definitions.has(id))
      throw new Error(`Unknown Agent definition: ${id}`);
    /** Stored activity, defaulting to an empty offline projection. */
    const activity = this.#activities.get(id) ?? {
      runLeaseIds: [],
      taskIds: [],
    };
    return {
      status: activity.runLeaseIds.length === 0 ? "Offline" : "Online",
      taskIds: clone(activity.taskIds),
      version: String(this.#entityVersions.get(`agents:${id}`) ?? 0),
    };
  }

  /** Returns lease projection. */
  public async getLeaseProjection(id: string): Promise<LeaseProjection> {
    this.pruneExpiredLeases();
    /** Active leases owned by the requested Agent. */
    const leases = [...this.#leases.values()].filter(
      (lease) => lease.agentId === id,
    );
    return {
      runLeaseIds: leases
        .filter((lease) => lease.scope === "agent_run")
        .map((lease) => lease.id)
        .sort(),
      taskIds: [
        ...new Set(
          leases
            .filter((lease) => lease.scope === "task_assignment")
            .map((lease) => requiredLeaseTask(lease)),
        ),
      ].sort(),
      taskLeaseIds: leases
        .filter((lease) => lease.scope === "task_assignment")
        .map((lease) => lease.id)
        .sort(),
    };
  }

  /** Returns lease snapshot. */
  public async getLeaseSnapshot(
    leaseId: string,
  ): Promise<LeaseSnapshot | null> {
    /** Active lease with the requested identifier, if present. */
    const active = this.#leases.get(leaseId);
    /** Active or released lease selected for the snapshot. */
    const lease = active ?? this.#releasedLeases.get(leaseId);
    if (lease === undefined) return null;
    /** Whether the selected lease has left the active set. */
    const released = active === undefined;
    return {
      expiresAt: lease.expiresAt,
      leaseId: lease.id,
      ownerId: lease.ownerId,
      released,
      scope: lease.scope,
      agentId: lease.agentId,
      taskId: lease.taskId,
      version: digestJson(toJsonValue({ ...lease, released })),
    };
  }

  /** Returns configured Task status options in deterministic order. */
  public async listTaskStatusOptions(): Promise<readonly string[]> {
    return [...this.#taskStatusOptions].sort();
  }

  /** Returns Task properties derived from authoritative provider state elsewhere. */
  public async listDerivedTaskPropertyNames(): Promise<readonly string[]> {
    return [];
  }

  /** Reconciles Agent activity against provider state. */
  public async reconcileAgentActivity(
    agentId: string,
    idempotencyKey: string,
  ): Promise<ReconciliationResult> {
    /** Lease-derived activity that the stored record must match. */
    const projection = await this.getLeaseProjection(agentId);
    /** Stored activity, defaulting to an empty offline projection. */
    const current = this.#activities.get(agentId) ?? {
      runLeaseIds: [],
      taskIds: [],
    };
    if (
      sameStringSet(current.runLeaseIds, projection.runLeaseIds) &&
      sameStringSet(current.taskIds, projection.taskIds)
    ) {
      return {
        evidence: {
          runLeaseIds: [...projection.runLeaseIds],
          taskIds: [...projection.taskIds],
        },
        state: "not_applied",
      };
    }
    /** Receipt proving the reconciled activity write. */
    const receipt = await this.updateAgentActivity({
      expectedRunLeaseIds: current.runLeaseIds,
      expectedTaskIds: current.taskIds,
      idempotencyKey,
      nextRunLeaseIds: projection.runLeaseIds,
      nextTaskIds: projection.taskIds,
      agentId,
    });
    return {
      evidence: {
        receipt: toJsonValue(receipt),
        runLeaseIds: [...projection.runLeaseIds],
        taskIds: [...projection.taskIds],
      },
      state: "applied",
    };
  }

  /** Updates Agent activity. */
  public async updateAgentActivity(
    change: ActivityMutation,
  ): Promise<WriteReceipt> {
    /** Result of `this.lookupIdempotent`, retained for `updateAgentActivity`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      change.idempotencyKey,
      "agent_activity",
      change,
    );
    if (prior !== undefined) return prior;
    if (!this.#definitions.has(change.agentId)) {
      throw new Error(`Unknown Agent definition: ${change.agentId}`);
    }
    /** Current snapshot used consistently during `updateAgentActivity`. */
    const current = this.#activities.get(change.agentId) ?? {
      runLeaseIds: [],
      taskIds: [],
    };
    if (
      !sameStringSet(current.runLeaseIds, change.expectedRunLeaseIds) ||
      !sameStringSet(current.taskIds, change.expectedTaskIds)
    ) {
      throw new Error("Agent activity version conflict");
    }
    /** Result of `this.getLeaseProjection`, retained for `updateAgentActivity`. */
    const projection = await this.getLeaseProjection(change.agentId);
    if (
      !sameStringSet(projection.runLeaseIds, change.nextRunLeaseIds) ||
      !sameStringSet(projection.taskIds, change.nextTaskIds)
    ) {
      throw new Error(
        "Agent activity must equal the provider's active lease projection",
      );
    }
    this.#activities.set(change.agentId, {
      runLeaseIds: this.normalizedSet(change.nextRunLeaseIds),
      taskIds: this.normalizedSet(change.nextTaskIds),
    });
    /** Result of `this.nextEntityVersion`, retained for `updateAgentActivity`. */
    const version = this.nextEntityVersion("agents", change.agentId);
    /** Receipt proving the activity update. */
    const receipt = this.receipt(
      "agents",
      change.agentId,
      change.idempotencyKey,
      version,
    );
    this.recordIdempotent(
      change.idempotencyKey,
      "agent_activity",
      change,
      receipt,
    );
    return clone(receipt);
  }

  /** Returns the requested page of filtered Task summaries. */
  public async listTaskSummaries(
    query: TaskQuery,
  ): Promise<readonly TaskSummary[]> {
    for (const key of Object.keys(query.predicate)) {
      if (!TASK_SUMMARY_KEYS.has(key))
        throw new Error(`Unsupported task predicate: ${key}`);
    }

    /** Task snapshots satisfying the predicate and dependency policy. */
    const matching = [...this.#tasks.values()]
      .filter((task) =>
        taskSummaryMatchesPredicate(this.taskSummary(task), query.predicate),
      )
      .filter((task) =>
        task.dependencies.every((dependencyId) => {
          /** Current dependency state used to determine candidate eligibility. */
          const dependency = this.#tasks.get(dependencyId);
          return (
            dependency !== undefined &&
            !dependency.archived &&
            query.dependencySatisfiedStatuses.includes(dependency.status)
          );
        }),
      )
      .map((task) => this.taskSummary(task));
    return pageAfter(matching, query, (task) => task.id).map((task) =>
      clone(task),
    );
  }

  /** Returns task snapshot. */
  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    /** Task snapshot used consistently during `getTaskSnapshot`. */
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new Error(`Unknown Task: ${taskId}`);
    return clone(task);
  }

  /** Applies task mutation. */
  public async applyTaskMutation(
    mutation: ConditionalTaskMutation,
  ): Promise<WriteReceipt> {
    /** Result of `this.lookupIdempotent`, retained for `applyTaskMutation`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      mutation.idempotencyKey,
      "task",
      mutation,
    );
    if (prior !== undefined) return prior;
    /** Task snapshot used consistently during `applyTaskMutation`. */
    const task = this.#tasks.get(mutation.taskId);
    if (task === undefined) throw new Error(`Unknown Task: ${mutation.taskId}`);
    if (task.version !== mutation.expectedVersion)
      throw new Error("Task version conflict");
    if (
      mutation.nextStatus !== null &&
      !this.#taskStatusOptions.has(mutation.nextStatus)
    )
      throw new Error(`Unknown Task status: ${mutation.nextStatus}`);
    /** Status snapshot used consistently during `applyTaskMutation`. */
    const status = mutation.nextStatus ?? task.status;
    /** Version snapshot used consistently during `applyTaskMutation`. */
    const version = `memory:${task.id}:${randomUUID()}`;
    this.#tasks.set(task.id, {
      ...clone(task),
      body: mutation.nextBody ?? task.body,
      properties: taskPropertiesWithStatus(mutation.nextProperties, status),
      status,
      version,
    });
    /** Receipt proving the conditional Task mutation. */
    const receipt = this.receipt(
      "tasks",
      task.id,
      mutation.idempotencyKey,
      version,
    );
    this.recordIdempotent(mutation.idempotencyKey, "task", mutation, receipt);
    return clone(receipt);
  }

  /** Returns resources. */
  public async getResources(
    refs: readonly ResourceRef[],
  ): Promise<readonly ResourceRecord[]> {
    return refs.map((ref) => {
      /** Resource snapshot used consistently during `getResources`. */
      const resource = this.#resources.get(ref.key);
      if (resource === undefined)
        throw new Error(`Unknown Resource: ${ref.key}`);
      if (ref.version !== null && ref.version !== resource.version) {
        throw new Error(`Resource version mismatch: ${ref.key}`);
      }
      if (ref.digest !== null && ref.digest !== resource.digest) {
        throw new Error(`Resource digest mismatch: ${ref.key}`);
      }
      return clone(resource);
    });
  }

  /** Returns optional resource. */
  public async getOptionalResource(
    key: string,
  ): Promise<ResourceRecord | null> {
    /** Resource snapshot used consistently during `getOptionalResource`. */
    const resource = this.#resources.get(key);
    return resource === undefined ? null : clone(resource);
  }

  /** Persists resource. */
  public async putResource(record: ResourceMutation): Promise<WriteReceipt> {
    if (
      !RESOURCE_KINDS.includes(record.kind as (typeof RESOURCE_KINDS)[number])
    )
      throw new TypeError(`Resource kind is invalid: ${record.kind}`);
    /** Result of `this.lookupIdempotent`, retained for `putResource`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      record.idempotencyKey,
      "resource",
      record,
    );
    if (prior !== undefined) return prior;
    /** Stored snapshot used consistently during `putResource`. */
    const stored: ResourceRecord = {
      body: record.body,
      dependencies: clone(record.dependencies),
      digest: record.digest,
      key: record.key,
      kind: record.kind,
      state: record.state,
      version: record.version,
    };
    this.#resources.set(stored.key, stored);
    /** Receipt proving the Resource write. */
    const receipt = this.receipt(
      "resources",
      stored.key,
      record.idempotencyKey,
      stored.version,
    );
    this.recordIdempotent(record.idempotencyKey, "resource", record, receipt);
    return clone(receipt);
  }

  /** Returns manager-owned operational state by stable key. */
  public async getOptionalOperation(
    key: string,
  ): Promise<OperationRecord | null> {
    const operation = this.#operations.get(key);
    return operation === undefined ? null : clone(operation);
  }

  /** Persists manager-owned operational state. */
  public async putOperation(record: OperationMutation): Promise<WriteReceipt> {
    const prior = this.lookupIdempotent<WriteReceipt>(
      record.idempotencyKey,
      "operation_record",
      record,
    );
    if (prior !== undefined) return prior;
    const stored: OperationRecord = {
      body: record.body,
      dependencies: clone(record.dependencies),
      digest: record.digest,
      key: record.key,
      kind: record.kind,
      state: record.state,
      version: record.version,
    };
    this.#operations.set(stored.key, stored);
    const receipt = this.receipt(
      "operations",
      stored.key,
      record.idempotencyKey,
      stored.version,
    );
    this.recordIdempotent(
      record.idempotencyKey,
      "operation_record",
      record,
      receipt,
    );
    return clone(receipt);
  }

  /** Acquires lease. */
  public async acquireLease(request: LeaseRequest): Promise<LeaseResult> {
    /** Result of `this.lookupIdempotent`, retained for `acquireLease`. */
    const prior = this.lookupIdempotent<LeaseResult>(
      request.idempotencyKey,
      "lease_acquire",
      request,
    );
    if (prior !== undefined) return prior;
    this.validateLeaseRequest(request);
    this.pruneExpiredLeases();
    /** Active lease occupying the requested exclusivity slot, if any. */
    const conflict = [...this.#leases.values()].find((lease) =>
      request.scope === "task_assignment"
        ? lease.scope === request.scope && lease.taskId === request.taskId
        : lease.scope === request.scope &&
          lease.ownerId === request.ownerId &&
          lease.agentId === request.agentId,
    );
    /** Lease acquisition decision, including any conflicting lease. */
    const result: LeaseResult =
      conflict === undefined
        ? { acquired: true, conflictingLeaseId: null, leaseId: randomUUID() }
        : { acquired: false, conflictingLeaseId: conflict.id, leaseId: null };
    if (result.leaseId !== null) {
      for (const [leaseId, released] of this.#releasedLeases)
        if (sameLeaseSlot(released, request))
          this.#releasedLeases.delete(leaseId);
      this.#leases.set(result.leaseId, {
        ...clone(request),
        id: result.leaseId,
      });
    }
    this.recordIdempotent(
      request.idempotencyKey,
      "lease_acquire",
      request,
      result,
      this.#intentOutcomes,
      result.acquired ? "applied" : "not_applied",
    );
    return clone(result);
  }

  /** Renews lease. */
  public async renewLease(request: LeaseRenewal): Promise<LeaseResult> {
    /** Result of `this.lookupIdempotent`, retained for `renewLease`. */
    const prior = this.lookupIdempotent<LeaseResult>(
      request.idempotencyKey,
      "lease_renew",
      request,
    );
    if (prior !== undefined) return prior;
    this.pruneExpiredLeases();
    /** Result of `this.parseFutureTimestamp`, retained for `renewLease`. */
    const lease = this.#leases.get(request.leaseId);
    /** Result of `this.parseFutureTimestamp`, retained for `renewLease`. */
    const nextExpiry = this.parseFutureTimestamp(
      request.nextExpiresAt,
      "nextExpiresAt",
    );
    if (
      lease === undefined ||
      lease.ownerId !== request.ownerId ||
      lease.expiresAt !== request.expectedExpiresAt ||
      nextExpiry <= Date.parse(lease.expiresAt)
    ) {
      /** Failed renewal decision returned for a stale or invalid lease. */
      const result = {
        acquired: false,
        conflictingLeaseId: request.leaseId,
        leaseId: null,
      };
      this.recordIdempotent(
        request.idempotencyKey,
        "lease_renew",
        request,
        result,
        this.#intentOutcomes,
        "not_applied",
      );
      return result;
    }
    this.#leases.set(lease.id, { ...lease, expiresAt: request.nextExpiresAt });
    /** Successful renewal decision preserving the lease identifier. */
    const result = {
      acquired: true,
      conflictingLeaseId: null,
      leaseId: lease.id,
    };
    this.recordIdempotent(
      request.idempotencyKey,
      "lease_renew",
      request,
      result,
    );
    return clone(result);
  }

  /** Releases lease. */
  public async releaseLease(request: LeaseRelease): Promise<WriteReceipt> {
    /** Result of `this.lookupIdempotent`, retained for `releaseLease`. */
    const key = `lease-release:${request.leaseId}:${request.ownerId}:${request.expectedVersion ?? "unversioned"}`;
    /** Result of `this.lookupIdempotent`, retained for `releaseLease`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      key,
      "lease_release",
      request,
    );
    if (prior !== undefined) return prior;
    /** Lease snapshot used consistently during `releaseLease`. */
    const lease = this.#leases.get(request.leaseId);
    if (
      lease === undefined ||
      lease.ownerId !== request.ownerId ||
      (request.expectedVersion !== null &&
        request.expectedVersion !==
          digestJson(toJsonValue({ ...lease, released: false })))
    ) {
      throw new Error("Lease release conflict");
    }
    this.#leases.delete(request.leaseId);
    this.#releasedLeases.set(request.leaseId, lease);
    /** Receipt proving the lease release. */
    const receipt = this.receipt("resources", lease.id, key, lease.expiresAt);
    this.recordIdempotent(key, "lease_release", request, receipt);
    return clone(receipt);
  }

  /** Creates or updates the Error identified by Error Key. */
  public async createOrUpdateError(
    error: ErrorMutation,
  ): Promise<WriteReceipt> {
    /** Result of `this.lookupIdempotent`, retained for `createOrUpdateError`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      error.idempotencyKey,
      "error",
      error,
    );
    if (prior !== undefined) return prior;
    /** Provider-owned Error content without the mutation-only idempotency key. */
    const { idempotencyKey: _idempotencyKey, ...stored } = error;
    this.#errors.set(error.errorKey, clone(stored));
    /** Result of `this.nextEntityVersion`, retained for `createOrUpdateError`. */
    const version = this.nextEntityVersion("errors", error.errorKey);
    /** Receipt proving the Error upsert. */
    const receipt = this.receipt(
      "errors",
      error.errorKey,
      error.idempotencyKey,
      version,
    );
    this.recordIdempotent(error.idempotencyKey, "error", error, receipt);
    return clone(receipt);
  }

  /** Reconciles intent against provider state. */
  public async reconcileIntent(
    intentId: string,
  ): Promise<ReconciliationResult> {
    return clone(
      this.#intentOutcomes.get(intentId) ?? {
        evidence: {},
        state: "not_applied",
      },
    );
  }

  /** Returns a prepared logical-operation intent. */
  public async getOperationIntent(
    intentId: string,
  ): Promise<ProviderOperationIntent | null> {
    return clone(this.#operationIntents.get(intentId) ?? null);
  }

  /** Creates or validates a pending logical-operation intent. */
  public async beginOperationIntent(
    intentId: string,
    operation: string,
    payload: JsonValue,
  ): Promise<ProviderOperationIntent> {
    /** Canonical payload stored for exact replay comparison. */
    const canonicalPayload = toJsonValue(payload);
    /** Digest binding the idempotency key to the canonical payload. */
    const payloadDigest = digestJson(canonicalPayload);
    /** Existing intent for this idempotency key, if already prepared. */
    const existing = this.#operationIntents.get(intentId);
    if (existing !== undefined) {
      if (
        existing.operation !== operation ||
        existing.payloadDigest !== payloadDigest
      ) {
        throw new Error(
          `Idempotency key ${intentId} was reused with a different operation or payload`,
        );
      }
      return clone(existing);
    }
    /** New pending intent persisted before the logical operation begins. */
    const intent: MemoryOperationIntent = {
      idempotencyKey: intentId,
      operation,
      payload: canonicalPayload,
      payloadDigest,
      result: null,
      state: "pending",
    };
    this.#operationIntents.set(intentId, intent);
    return clone(intent);
  }

  /** Completes a matching logical-operation intent. */
  public async completeOperationIntent(
    intentId: string,
    operation: string,
    payload: JsonValue,
    result: JsonValue,
  ): Promise<ProviderOperationIntent> {
    /** Existing or newly prepared intent whose result will be finalized. */
    const existing = await this.beginOperationIntent(
      intentId,
      operation,
      payload,
    );
    if (existing.state === "applied") {
      if (digestJson(existing.result) !== digestJson(result)) {
        throw new Error(`Intent ${intentId} result changed before completion`);
      }
      return existing;
    }
    /** Applied intent containing the immutable canonical result. */
    const completed: MemoryOperationIntent = {
      ...existing,
      payloadDigest: digestJson(existing.payload),
      result: toJsonValue(result),
      state: "applied",
    };
    this.#operationIntents.set(intentId, completed);
    this.#intentOutcomes.set(intentId, {
      evidence: {
        operation,
        payloadDigest: completed.payloadDigest,
        result: completed.result,
      },
      state: "applied",
    });
    return clone(completed);
  }

  /** Projects a Task snapshot into its bounded summary. */
  private taskSummary(task: TaskSnapshot): TaskSummary {
    return {
      archived: task.archived,
      id: task.id,
      priority: task.priority,
      status: task.status,
      title: task.title,
      version: task.version,
    };
  }

  /** Validates lease request. */
  private validateLeaseRequest(request: LeaseRequest): void {
    if (
      (request.scope === "task_assignment" && request.taskId === null) ||
      (request.scope === "agent_run" && request.taskId !== null)
    ) {
      throw new Error(
        `Lease scope ${request.scope} has an invalid task identity`,
      );
    }
    this.parseFutureTimestamp(request.expiresAt, "expiresAt");
  }

  /** Parses and validates future timestamp. */
  private parseFutureTimestamp(value: string, field: string): number {
    /** Result of `Date.parse`, retained for `parseFutureTimestamp`. */
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp <= this.now().getTime()) {
      throw new Error(`${field} must be a valid future timestamp`);
    }
    return timestamp;
  }

  /** Removes expired leases from active in-memory state. */
  private pruneExpiredLeases(): void {
    /** Result of `this.now`, retained for `pruneExpiredLeases`. */
    const now = this.now().getTime();
    for (const [id, lease] of this.#leases) {
      if (
        !Number.isFinite(Date.parse(lease.expiresAt)) ||
        Date.parse(lease.expiresAt) <= now
      ) {
        this.#leases.delete(id);
      }
    }
  }

  /** Generates the next opaque in-memory entity version. */
  private nextEntityVersion(table: TableKind, id: string): string {
    /** Key snapshot used consistently during `nextEntityVersion`. */
    const key = `${table}:${id}`;
    /** Version snapshot used consistently during `nextEntityVersion`. */
    const version = (this.#entityVersions.get(key) ?? 0) + 1;
    this.#entityVersions.set(key, version);
    return `memory:${key}:${version}`;
  }

  /** Returns unique strings in deterministic order. */
  private normalizedSet(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort();
  }

  /** Returns the payload-bound result of an earlier operation, if present. */
  private lookupIdempotent<T>(
    key: string,
    operation: string,
    payload: unknown,
  ): T | undefined {
    return this.#idempotency.read<T>(key, operation, toJsonValue(payload));
  }

  /** Persists one payload-bound replay result and its reconciliation outcome. */
  private recordIdempotent<T>(
    key: string,
    operation: string,
    payload: unknown,
    result: T,
    outcomes: Map<string, ReconciliationResult> = this.#intentOutcomes,
    state: ReconciliationResult["state"] = "applied",
  ): void {
    this.#idempotency.write(key, operation, toJsonValue(payload), result);
    outcomes.set(key, {
      evidence: { operation, result: toJsonValue(result) },
      state,
    });
  }

  /** Creates a provider write receipt from verified record state. */
  private receipt(
    table: TableKind,
    recordId: string,
    idempotencyKey: string,
    observedVersion: string,
  ): WriteReceipt {
    return {
      idempotencyKey,
      observedVersion,
      providerRecord: { id: recordId, table },
      writtenAt: this.now().toISOString(),
    };
  }
}
