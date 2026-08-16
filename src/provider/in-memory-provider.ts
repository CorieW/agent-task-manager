/** Implements the deterministic in-memory reference provider used for conformance and orchestration tests. */
import { randomUUID } from "node:crypto";

import { digestJson } from "../core/digest.js";
import { IdempotencyLedger } from "../core/idempotency-ledger.js";
import { finalizeMigrationPlan } from "../core/migration-plan.js";
import { pageAfter } from "../core/pagination.js";
import { compareWorkspaceSchema } from "../core/schema-diff.js";
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

/** Defines memory lease. */
interface MemoryLease extends LeaseRequest {
  /** Identifies memory lease. */
  readonly id: string;
}

/** Defines memory activity. */
interface MemoryActivity {
  /** Lists run lease IDs for memory activity. */
  readonly runLeaseIds: readonly string[];
  /** Lists task IDs for memory activity. */
  readonly taskIds: readonly string[];
}

/** Stores one provider-neutral logical operation for durable-style replay. */
interface MemoryOperationIntent extends ProviderOperationIntent {
  /** Digest used to reject payload changes under one idempotency key. */
  readonly payloadDigest: string;
}

/** Returns the Task ID required by a task-assignment lease. */
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

/** Defines the module-level `TABLE_ORDER` value. */
const TABLE_ORDER: readonly TableKind[] = [
  "resources",
  "errors",
  "tasks",
  "agents",
];
/** Defines the module-level `TASK_SUMMARY_KEYS` value. */
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
  /** Holds the `normalized` intermediate used by `snapshotDigest`. */
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
  /** Holds the `targetKind` intermediate used by `observedProperty`. */
  const targetKind = property.targetTable;
  /** Holds the `targetTable` intermediate used by `observedProperty`. */
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
  /** Holds the `descriptor` intermediate used by `observedTable`. */
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
  /** Holds the `parsed` intermediate used by `nextTableVersion`. */
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
  /** Holds the `kind` intermediate used by `evolveSnapshot`. */
  const kind = step.payload.kind;
  if (typeof kind !== "string" || !TABLE_ORDER.includes(kind as TableKind)) {
    throw new Error(`Migration step ${step.id} has an invalid table kind`);
  }
  /** Holds the `tableKind` intermediate used by `evolveSnapshot`. */
  const tableKind = kind as TableKind;
  /** Holds the `tables` intermediate used by `evolveSnapshot`. */
  let tables = clone(snapshot.tables);

  if (step.kind === "create_table") {
    if (!tables.some((table) => table.kind === tableKind)) {
      tables = [...tables, observedTable(tableKind, target)];
    }
  } else if (step.kind === "add_property" || step.kind === "add_relation") {
    /** Holds the `physicalName` intermediate used by `evolveSnapshot`. */
    const physicalName = step.payload.physicalName;
    if (typeof physicalName !== "string")
      throw new Error(`Migration step ${step.id} has no property`);
    /** Holds the `descriptor` intermediate used by `evolveSnapshot`. */
    const descriptor = target.tables.find((table) => table.kind === tableKind);
    /** Holds the `property` intermediate used by `evolveSnapshot`. */
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
    /** Holds the `managedRange` intermediate used by `evolveSnapshot`. */
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
  /** Contains completed workspace steps for in-memory provider. */
  readonly #completedWorkspaceSteps = new Set<string>();
  /** Contains activities for in-memory provider. */
  readonly #activities = new Map<string, MemoryActivity>();
  /** Contains definitions for in-memory provider. */
  readonly #definitions = new Map<string, AgentDefinition>();
  /** Contains entity versions for in-memory provider. */
  readonly #entityVersions = new Map<string, number>();
  /** Contains errors for in-memory provider. */
  readonly #errors = new Map<string, Omit<ErrorMutation, "idempotencyKey">>();
  /** Contains idempotency for in-memory provider. */
  readonly #idempotency = new IdempotencyLedger();
  /** Contains intent outcomes for in-memory provider. */
  readonly #intentOutcomes = new Map<string, ReconciliationResult>();
  /** Contains prepared logical-operation intents for in-memory provider. */
  readonly #operationIntents = new Map<string, MemoryOperationIntent>();
  /** Contains leases for in-memory provider. */
  readonly #leases = new Map<string, MemoryLease>();
  /** Contains released leases for in-memory provider. */
  readonly #releasedLeases = new Map<string, MemoryLease>();
  /** Contains resources for in-memory provider. */
  readonly #resources = new Map<string, ResourceRecord>();
  /** Contains tasks for in-memory provider. */
  readonly #tasks = new Map<string, TaskSnapshot>();
  /** Contains task status options for in-memory provider. */
  readonly #taskStatusOptions = new Set<string>();
  /** Contains workspace outcomes for in-memory provider. */
  readonly #workspaceOutcomes = new Map<string, ReconciliationResult>();
  /** Contains snapshot for in-memory provider. */
  #snapshot: WorkspaceSchemaSnapshot;

  /** Initializes in-memory provider. */
  public constructor(
    /** Contains environment for in-memory provider. */ private readonly environment: ProviderEnvironment,
    /** Contains target for in-memory provider. */ private readonly target: WorkspaceSchemaDescriptor,
    snapshot?: WorkspaceSchemaSnapshot,
    /** Contains now for in-memory provider. */ private readonly now: () => Date = () =>
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
    /** Tracks the `issues` condition in `validateEnvironment`. */
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
    /** Holds the `report` intermediate used by `planWorkspaceChanges`. */
    const report = compareWorkspaceSchema(request.observed, request.target);
    if (report.state === "blocked_incompatible") {
      throw new Error(
        "Cannot plan additive changes over incompatible workspace schema",
      );
    }

    /** Holds the `drafts` intermediate used by `planWorkspaceChanges`. */
    const drafts: Array<
      Pick<WorkspaceMigrationStep, "id" | "kind" | "payload">
    > = [];
    for (const kind of TABLE_ORDER) {
      /** Defines `expected` for comparison in `planWorkspaceChanges`. */
      const expected = request.target.tables.find(
        (table) => table.kind === kind,
      );
      if (expected === undefined) continue;
      /** Defines `observed` for comparison in `planWorkspaceChanges`. */
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

    /** Holds the `simulated` intermediate used by `planWorkspaceChanges`. */
    let simulated = clone(request.observed);
    /** Holds the `steps` intermediate used by `planWorkspaceChanges`. */
    const steps: WorkspaceMigrationStep[] = [];
    for (const draft of drafts) {
      /** Holds the `previous` intermediate used by `planWorkspaceChanges`. */
      const previous = steps.at(-1);
      /** Holds the `partial` intermediate used by `planWorkspaceChanges`. */
      const partial = {
        dependsOn: previous === undefined ? [] : [previous.id],
        expectedPreSchemaDigest: simulated.digest,
        id: draft.id,
        kind: draft.kind,
        payload: draft.payload,
        reversibility: "additive" as const,
      };
      /** Holds the `next` intermediate used by `planWorkspaceChanges`. */
      const next = evolveSnapshot(
        simulated,
        partial,
        request.target,
        simulated.capturedAt,
      );
      /** Holds the `step` intermediate used by `planWorkspaceChanges`. */
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
    /** Holds the `prior` intermediate used by `applyWorkspaceStep`. */
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
    /** Holds the `next` intermediate used by `applyWorkspaceStep`. */
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
    /** Holds the `kind` intermediate used by `applyWorkspaceStep`. */
    const kind = step.payload.kind as TableKind;
    /** Holds the `table` intermediate used by `applyWorkspaceStep`. */
    const table = next.tables.find((candidate) => candidate.kind === kind);
    if (table === undefined)
      throw new Error(`Migration did not produce table: ${kind}`);
    /** Captures `receipt` returned by `applyWorkspaceStep`. */
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

  /** Lists Agent definitions. */
  public async listAgentDefinitions(): Promise<readonly AgentDefinition[]> {
    return [...this.#definitions.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((definition) => clone(definition));
  }

  /** Returns Agent definition. */
  public async getAgentDefinition(id: string): Promise<AgentDefinition> {
    /** Holds the `definition` intermediate used by `getAgentDefinition`. */
    const definition = this.#definitions.get(id);
    if (definition === undefined)
      throw new Error(`Unknown Agent definition: ${id}`);
    return clone(definition);
  }

  /** Returns Agent activity. */
  public async getAgentActivity(id: string): Promise<AgentActivity> {
    if (!this.#definitions.has(id))
      throw new Error(`Unknown Agent definition: ${id}`);
    /** Holds the `activity` intermediate used by `getAgentActivity`. */
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
    /** Holds the `leases` intermediate used by `getLeaseProjection`. */
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
    /** Holds the `active` intermediate used by `getLeaseSnapshot`. */
    const active = this.#leases.get(leaseId);
    /** Holds the `lease` intermediate used by `getLeaseSnapshot`. */
    const lease = active ?? this.#releasedLeases.get(leaseId);
    if (lease === undefined) return null;
    /** Holds the `released` intermediate used by `getLeaseSnapshot`. */
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

  /** Lists task status options. */
  public async listTaskStatusOptions(): Promise<readonly string[]> {
    return [...this.#taskStatusOptions].sort();
  }

  /** Reconciles Agent activity against provider state. */
  public async reconcileAgentActivity(
    agentId: string,
    idempotencyKey: string,
  ): Promise<ReconciliationResult> {
    /** Holds the `projection` intermediate used by `reconcileAgentActivity`. */
    const projection = await this.getLeaseProjection(agentId);
    /** Holds the `current` intermediate used by `reconcileAgentActivity`. */
    const current = this.#activities.get(agentId) ?? {
      runLeaseIds: [],
      taskIds: [],
    };
    if (
      this.sameSet(current.runLeaseIds, projection.runLeaseIds) &&
      this.sameSet(current.taskIds, projection.taskIds)
    ) {
      return {
        evidence: {
          runLeaseIds: [...projection.runLeaseIds],
          taskIds: [...projection.taskIds],
        },
        state: "not_applied",
      };
    }
    /** Captures `receipt` returned by `reconcileAgentActivity`. */
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
    /** Holds the `prior` intermediate used by `updateAgentActivity`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      change.idempotencyKey,
      "agent_activity",
      change,
    );
    if (prior !== undefined) return prior;
    if (!this.#definitions.has(change.agentId)) {
      throw new Error(`Unknown Agent definition: ${change.agentId}`);
    }
    /** Holds the `current` intermediate used by `updateAgentActivity`. */
    const current = this.#activities.get(change.agentId) ?? {
      runLeaseIds: [],
      taskIds: [],
    };
    if (
      !this.sameSet(current.runLeaseIds, change.expectedRunLeaseIds) ||
      !this.sameSet(current.taskIds, change.expectedTaskIds)
    ) {
      throw new Error("Agent activity version conflict");
    }
    /** Holds the `projection` intermediate used by `updateAgentActivity`. */
    const projection = await this.getLeaseProjection(change.agentId);
    if (
      !this.sameSet(projection.runLeaseIds, change.nextRunLeaseIds) ||
      !this.sameSet(projection.taskIds, change.nextTaskIds)
    ) {
      throw new Error(
        "Agent activity must equal the provider's active lease projection",
      );
    }
    this.#activities.set(change.agentId, {
      runLeaseIds: this.normalizedSet(change.nextRunLeaseIds),
      taskIds: this.normalizedSet(change.nextTaskIds),
    });
    /** Holds the `version` intermediate used by `updateAgentActivity`. */
    const version = this.nextEntityVersion("agents", change.agentId);
    /** Captures `receipt` returned by `updateAgentActivity`. */
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

  /** Lists task summaries. */
  public async listTaskSummaries(
    query: TaskQuery,
  ): Promise<readonly TaskSummary[]> {
    for (const key of Object.keys(query.predicate)) {
      if (!TASK_SUMMARY_KEYS.has(key))
        throw new Error(`Unsupported task predicate: ${key}`);
    }

    /** Holds the `matching` intermediate used by `listTaskSummaries`. */
    const matching = [...this.#tasks.values()]
      .map((task) => this.taskSummary(task))
      .filter((task) => taskSummaryMatchesPredicate(task, query.predicate));
    return pageAfter(matching, query, (task) => task.id).map((task) =>
      clone(task),
    );
  }

  /** Returns task snapshot. */
  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    /** Holds the `task` intermediate used by `getTaskSnapshot`. */
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new Error(`Unknown Task: ${taskId}`);
    return clone(task);
  }

  /** Applies task mutation. */
  public async applyTaskMutation(
    mutation: ConditionalTaskMutation,
  ): Promise<WriteReceipt> {
    /** Holds the `prior` intermediate used by `applyTaskMutation`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      mutation.idempotencyKey,
      "task",
      mutation,
    );
    if (prior !== undefined) return prior;
    /** Holds the `task` intermediate used by `applyTaskMutation`. */
    const task = this.#tasks.get(mutation.taskId);
    if (task === undefined) throw new Error(`Unknown Task: ${mutation.taskId}`);
    if (task.version !== mutation.expectedVersion)
      throw new Error("Task version conflict");
    if (
      mutation.nextStatus !== null &&
      !this.#taskStatusOptions.has(mutation.nextStatus)
    )
      throw new Error(`Unknown Task status: ${mutation.nextStatus}`);
    /** Holds the `status` intermediate used by `applyTaskMutation`. */
    const status = mutation.nextStatus ?? task.status;
    /** Holds the `version` intermediate used by `applyTaskMutation`. */
    const version = `memory:${task.id}:${randomUUID()}`;
    this.#tasks.set(task.id, {
      ...clone(task),
      body: mutation.nextBody ?? task.body,
      properties: taskPropertiesWithStatus(mutation.nextProperties, status),
      status,
      version,
    });
    /** Captures `receipt` returned by `applyTaskMutation`. */
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
      /** Holds the `resource` intermediate used by `getResources`. */
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
    /** Holds the `resource` intermediate used by `getOptionalResource`. */
    const resource = this.#resources.get(key);
    return resource === undefined ? null : clone(resource);
  }

  /** Persists resource. */
  public async putResource(record: ResourceMutation): Promise<WriteReceipt> {
    /** Holds the `prior` intermediate used by `putResource`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      record.idempotencyKey,
      "resource",
      record,
    );
    if (prior !== undefined) return prior;
    /** Holds the `stored` intermediate used by `putResource`. */
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
    /** Captures `receipt` returned by `putResource`. */
    const receipt = this.receipt(
      "resources",
      stored.key,
      record.idempotencyKey,
      stored.version,
    );
    this.recordIdempotent(record.idempotencyKey, "resource", record, receipt);
    return clone(receipt);
  }

  /** Acquires lease. */
  public async acquireLease(request: LeaseRequest): Promise<LeaseResult> {
    /** Holds the `prior` intermediate used by `acquireLease`. */
    const prior = this.lookupIdempotent<LeaseResult>(
      request.idempotencyKey,
      "lease_acquire",
      request,
    );
    if (prior !== undefined) return prior;
    this.validateLeaseRequest(request);
    this.pruneExpiredLeases();
    /** Holds the `conflict` intermediate used by `acquireLease`. */
    const conflict = [...this.#leases.values()].find((lease) =>
      request.scope === "task_assignment"
        ? lease.scope === request.scope && lease.taskId === request.taskId
        : lease.scope === request.scope &&
          lease.ownerId === request.ownerId &&
          lease.agentId === request.agentId,
    );
    /** Captures `result` returned by `acquireLease`. */
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
    /** Holds the `prior` intermediate used by `renewLease`. */
    const prior = this.lookupIdempotent<LeaseResult>(
      request.idempotencyKey,
      "lease_renew",
      request,
    );
    if (prior !== undefined) return prior;
    this.pruneExpiredLeases();
    /** Holds the `lease` intermediate used by `renewLease`. */
    const lease = this.#leases.get(request.leaseId);
    /** Holds the `nextExpiry` intermediate used by `renewLease`. */
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
      /** Captures `result` returned by `renewLease`. */
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
    /** Captures `result` returned by `renewLease`. */
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
    /** Holds the `key` intermediate used by `releaseLease`. */
    const key = `lease-release:${request.leaseId}:${request.ownerId}:${request.expectedVersion ?? "unversioned"}`;
    /** Holds the `prior` intermediate used by `releaseLease`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      key,
      "lease_release",
      request,
    );
    if (prior !== undefined) return prior;
    /** Holds the `lease` intermediate used by `releaseLease`. */
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
    /** Captures `receipt` returned by `releaseLease`. */
    const receipt = this.receipt("resources", lease.id, key, lease.expiresAt);
    this.recordIdempotent(key, "lease_release", request, receipt);
    return clone(receipt);
  }

  /** Creates or updates the Error identified by Error Key. */
  public async createOrUpdateError(
    error: ErrorMutation,
  ): Promise<WriteReceipt> {
    /** Holds the `prior` intermediate used by `createOrUpdateError`. */
    const prior = this.lookupIdempotent<WriteReceipt>(
      error.idempotencyKey,
      "error",
      error,
    );
    if (prior !== undefined) return prior;
    /** Groups the `_idempotencyKey` and `stored` intermediates used by `createOrUpdateError`. */
    const { idempotencyKey: _idempotencyKey, ...stored } = error;
    this.#errors.set(error.errorKey, clone(stored));
    /** Holds the `version` intermediate used by `createOrUpdateError`. */
    const version = this.nextEntityVersion("errors", error.errorKey);
    /** Captures `receipt` returned by `createOrUpdateError`. */
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
    const canonicalPayload = toJsonValue(payload);
    const payloadDigest = digestJson(canonicalPayload);
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
    /** Holds the `timestamp` intermediate used by `parseFutureTimestamp`. */
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp <= this.now().getTime()) {
      throw new Error(`${field} must be a valid future timestamp`);
    }
    return timestamp;
  }

  /** Removes expired leases from active in-memory state. */
  private pruneExpiredLeases(): void {
    /** Holds the `now` intermediate used by `pruneExpiredLeases`. */
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
    /** Holds the `key` intermediate used by `nextEntityVersion`. */
    const key = `${table}:${id}`;
    /** Holds the `version` intermediate used by `nextEntityVersion`. */
    const version = (this.#entityVersions.get(key) ?? 0) + 1;
    this.#entityVersions.set(key, version);
    return `memory:${key}:${version}`;
  }

  /** Returns unique strings in deterministic order. */
  private normalizedSet(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort();
  }

  /** Compares two string collections as normalized sets. */
  private sameSet(left: readonly string[], right: readonly string[]): boolean {
    return (
      this.normalizedSet(left).join("\0") ===
      this.normalizedSet(right).join("\0")
    );
  }

  /** Returns the payload-bound result of an earlier operation, if present. */
  private lookupIdempotent<T>(
    key: string,
    operation: string,
    payload: unknown,
  ): T | undefined {
    return this.#idempotency.read<T>(key, operation, toJsonValue(payload));
  }

  /** Records idempotent. */
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
