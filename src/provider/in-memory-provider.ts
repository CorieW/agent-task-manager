/** Implements the deterministic in-memory reference provider used for conformance and orchestration tests. */
import { randomUUID } from "node:crypto";

import { digestJson } from "../core/digest.js";
import { IdempotencyLedger } from "../core/idempotency-ledger.js";
import { finalizeMigrationPlan } from "../core/migration-plan.js";
import { pageAfter } from "../core/pagination.js";
import { compareWorkspaceSchema } from "../core/schema-diff.js";
import { taskPropertiesWithStatus } from "../core/task-properties.js";
import { toJsonValue } from "../domain/json.js";
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

interface MemoryLease extends LeaseRequest {
  readonly id: string;
}

interface MemoryActivity {
  readonly runLeaseIds: readonly string[];
  readonly taskIds: readonly string[];
}

function requiredLeaseTask(lease: MemoryLease): string {
  if (lease.taskId === null) throw new Error("Task-assignment lease is missing its Task");
  return lease.taskId;
}

function sameLeaseSlot(left: MemoryLease, right: LeaseRequest): boolean {
  if (left.scope !== right.scope) return false;
  return left.scope === "agent_run"
    ? left.subAgentId === right.subAgentId && left.ownerId === right.ownerId
    : left.taskId === right.taskId;
}

const TABLE_ORDER: readonly TableKind[] = ["resources", "errors", "tasks", "subAgents"];
const TASK_SUMMARY_KEYS = new Set(["archived", "id", "priority", "status", "title", "version"]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function snapshotDigest(tables: readonly ObservedTable[]): string {
  const normalized = [...tables]
    .map((table) => ({
      ...table,
      managedRanges: [...table.managedRanges].sort(),
      properties: [...table.properties].sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return digestJson(toJsonValue(normalized));
}

function observedProperty(
  property: PropertyDescriptor,
  target: WorkspaceSchemaDescriptor,
): ObservedProperty {
  const targetKind = property.targetTable;
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

function observedTable(
  kind: TableKind,
  target: WorkspaceSchemaDescriptor,
): ObservedTable {
  const descriptor = target.tables.find((table) => table.kind === kind);
  if (descriptor === undefined) throw new Error(`Unknown table kind: ${kind}`);
  return {
    id: `memory:${descriptor.kind}`,
    kind: descriptor.kind,
    managedRanges: [...descriptor.managedRanges],
    properties: descriptor.properties.map((property) => observedProperty(property, target)),
    title: descriptor.title,
    version: "1",
  };
}

function nextTableVersion(version: string): string {
  const parsed = Number.parseInt(version, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? String(parsed + 1) : randomUUID();
}

function evolveSnapshot(
  snapshot: WorkspaceSchemaSnapshot,
  step: Omit<WorkspaceMigrationStep, "expectedPostSchemaDigest">,
  target: WorkspaceSchemaDescriptor,
  capturedAt: string,
): WorkspaceSchemaSnapshot {
  const kind = step.payload.kind;
  if (typeof kind !== "string" || !TABLE_ORDER.includes(kind as TableKind)) {
    throw new Error(`Migration step ${step.id} has an invalid table kind`);
  }
  const tableKind = kind as TableKind;
  let tables = clone(snapshot.tables);

  if (step.kind === "create_table") {
    if (!tables.some((table) => table.kind === tableKind)) {
      tables = [...tables, observedTable(tableKind, target)];
    }
  } else if (step.kind === "add_property" || step.kind === "add_relation") {
    const physicalName = step.payload.physicalName;
    if (typeof physicalName !== "string") throw new Error(`Migration step ${step.id} has no property`);
    const descriptor = target.tables.find((table) => table.kind === tableKind);
    const property = descriptor?.properties.find((candidate) => candidate.physicalName === physicalName);
    if (property === undefined) throw new Error(`Unknown target property: ${tableKind}.${physicalName}`);
    tables = tables.map((table) =>
      table.kind !== tableKind || table.properties.some((candidate) => candidate.name === physicalName)
        ? table
        : {
            ...table,
            properties: [...table.properties, observedProperty(property, target)],
            version: nextTableVersion(table.version),
          },
    );
  } else if (step.kind === "add_managed_range") {
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

export class InMemoryProvider implements AgentTaskProvider {
  readonly #completedWorkspaceSteps = new Set<string>();
  readonly #activities = new Map<string, MemoryActivity>();
  readonly #definitions = new Map<string, SubAgentDefinition>();
  readonly #entityVersions = new Map<string, number>();
  readonly #errors = new Map<string, Omit<ErrorMutation, "idempotencyKey">>();
  readonly #idempotency = new IdempotencyLedger();
  readonly #intentOutcomes = new Map<string, ReconciliationResult>();
  readonly #leases = new Map<string, MemoryLease>();
  readonly #releasedLeases = new Map<string, MemoryLease>();
  readonly #resources = new Map<string, ResourceRecord>();
  readonly #tasks = new Map<string, TaskSnapshot>();
  readonly #taskStatusOptions = new Set<string>();
  readonly #workspaceOutcomes = new Map<string, ReconciliationResult>();
  #snapshot: WorkspaceSchemaSnapshot;

  public constructor(
    private readonly environment: ProviderEnvironment,
    private readonly target: WorkspaceSchemaDescriptor,
    snapshot?: WorkspaceSchemaSnapshot,
    private readonly now: () => Date = () => new Date(),
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

  public seedDefinition(definition: SubAgentDefinition): void {
    this.#definitions.set(definition.id, clone(definition));
    if (!this.#activities.has(definition.id)) {
      this.#activities.set(definition.id, { runLeaseIds: [], taskIds: [] });
    }
  }

  public seedTask(task: TaskSnapshot): void {
    this.#tasks.set(task.id, clone(task));
    this.#taskStatusOptions.add(task.status);
  }

  public seedTaskStatusOptions(options: readonly string[]): void {
    for (const option of options) {
      if (option === "") throw new TypeError("Task status options must be non-empty");
      this.#taskStatusOptions.add(option);
    }
  }

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

  public async validateEnvironment(environment: ProviderEnvironment): Promise<ValidationReport> {
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

  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    return clone(this.#snapshot);
  }

  public async validateTables(): Promise<TableValidationReport> {
    return compareWorkspaceSchema(clone(this.#snapshot), this.target);
  }

  public async planWorkspaceChanges(
    request: WorkspaceSchemaRequest,
  ): Promise<WorkspaceMigrationPlan> {
    const report = compareWorkspaceSchema(request.observed, request.target);
    if (report.state === "blocked_incompatible") {
      throw new Error("Cannot plan additive changes over incompatible workspace schema");
    }

    const drafts: Array<Pick<WorkspaceMigrationStep, "id" | "kind" | "payload">> = [];
    for (const kind of TABLE_ORDER) {
      const expected = request.target.tables.find((table) => table.kind === kind);
      if (expected === undefined) continue;
      const observed = request.observed.tables.find((table) => table.kind === kind);
      if (observed === undefined) {
        drafts.push({ id: `create:${kind}`, kind: "create_table", payload: { kind } });
        continue;
      }
      for (const property of expected.properties) {
        if (!observed.properties.some((candidate) => candidate.name === property.physicalName)) {
          drafts.push({
            id: `property:${kind}:${property.physicalName}`,
            kind: property.targetTable === null ? "add_property" : "add_relation",
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

    let simulated = clone(request.observed);
    const steps: WorkspaceMigrationStep[] = [];
    for (const draft of drafts) {
      const previous = steps.at(-1);
      const partial = {
        dependsOn: previous === undefined ? [] : [previous.id],
        expectedPreSchemaDigest: simulated.digest,
        id: draft.id,
        kind: draft.kind,
        payload: draft.payload,
        reversibility: "additive" as const,
      };
      const next = evolveSnapshot(simulated, partial, request.target, simulated.capturedAt);
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

  public async applyWorkspaceStep(step: WorkspaceMigrationStep): Promise<WriteReceipt> {
    const prior = this.lookupIdempotent<WriteReceipt>(step.id, "workspace_step", step);
    if (prior !== undefined) return prior;
    if (step.dependsOn.some((dependency) => !this.#completedWorkspaceSteps.has(dependency))) {
      throw new Error(`Migration step dependencies are incomplete: ${step.id}`);
    }
    if (this.#snapshot.digest !== step.expectedPreSchemaDigest) {
      throw new Error(`Migration precondition changed: ${step.id}`);
    }
    const next = evolveSnapshot(this.#snapshot, step, this.target, this.now().toISOString());
    if (next.digest !== step.expectedPostSchemaDigest) {
      throw new Error(`Migration postcondition does not match plan: ${step.id}`);
    }
    this.#snapshot = next;
    this.#completedWorkspaceSteps.add(step.id);
    const kind = step.payload.kind as TableKind;
    const table = next.tables.find((candidate) => candidate.kind === kind);
    if (table === undefined) throw new Error(`Migration did not produce table: ${kind}`);
    const receipt = this.receipt(kind, table.id, step.id, table.version);
    this.recordIdempotent(step.id, "workspace_step", step, receipt, this.#workspaceOutcomes);
    return clone(receipt);
  }

  public async reconcileWorkspaceStep(stepId: string): Promise<ReconciliationResult> {
    return clone(this.#workspaceOutcomes.get(stepId) ?? { evidence: {}, state: "not_applied" });
  }

  public async listSubAgentDefinitions(): Promise<readonly SubAgentDefinition[]> {
    return [...this.#definitions.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((definition) => clone(definition));
  }

  public async getSubAgentDefinition(id: string): Promise<SubAgentDefinition> {
    const definition = this.#definitions.get(id);
    if (definition === undefined) throw new Error(`Unknown Sub-agent definition: ${id}`);
    return clone(definition);
  }

  public async getSubAgentActivity(id: string): Promise<SubAgentActivity> {
    if (!this.#definitions.has(id)) throw new Error(`Unknown Sub-agent definition: ${id}`);
    const activity = this.#activities.get(id) ?? { runLeaseIds: [], taskIds: [] };
    return {
      status: activity.runLeaseIds.length === 0 ? "Offline" : "Online",
      taskIds: clone(activity.taskIds),
      version: String(this.#entityVersions.get(`subAgents:${id}`) ?? 0),
    };
  }

  public async getLeaseProjection(id: string): Promise<LeaseProjection> {
    this.pruneExpiredLeases();
    const leases = [...this.#leases.values()].filter((lease) => lease.subAgentId === id);
    return {
      runLeaseIds: leases.filter((lease) => lease.scope === "agent_run").map((lease) => lease.id).sort(),
      taskIds: [...new Set(leases.filter((lease) => lease.scope === "task_assignment").map((lease) => requiredLeaseTask(lease)))].sort(),
      taskLeaseIds: leases.filter((lease) => lease.scope === "task_assignment").map((lease) => lease.id).sort(),
    };
  }

  public async getLeaseSnapshot(leaseId: string): Promise<LeaseSnapshot | null> {
    const active = this.#leases.get(leaseId);
    const lease = active ?? this.#releasedLeases.get(leaseId);
    if (lease === undefined) return null;
    const released = active === undefined;
    return {
      expiresAt: lease.expiresAt,
      leaseId: lease.id,
      ownerId: lease.ownerId,
      released,
      scope: lease.scope,
      subAgentId: lease.subAgentId,
      taskId: lease.taskId,
      version: digestJson(toJsonValue({ ...lease, released })),
    };
  }

  public async listTaskStatusOptions(): Promise<readonly string[]> {
    return [...this.#taskStatusOptions].sort();
  }

  public async reconcileSubAgentActivity(subAgentId: string, idempotencyKey: string): Promise<ReconciliationResult> {
    const projection = await this.getLeaseProjection(subAgentId);
    const current = this.#activities.get(subAgentId) ?? { runLeaseIds: [], taskIds: [] };
    if (this.sameSet(current.runLeaseIds, projection.runLeaseIds) && this.sameSet(current.taskIds, projection.taskIds)) {
      return { evidence: { runLeaseIds: [...projection.runLeaseIds], taskIds: [...projection.taskIds] }, state: "not_applied" };
    }
    const receipt = await this.updateSubAgentActivity({ expectedRunLeaseIds: current.runLeaseIds, expectedTaskIds: current.taskIds, idempotencyKey, nextRunLeaseIds: projection.runLeaseIds, nextTaskIds: projection.taskIds, subAgentId });
    return { evidence: { receipt: toJsonValue(receipt), runLeaseIds: [...projection.runLeaseIds], taskIds: [...projection.taskIds] }, state: "applied" };
  }

  public async updateSubAgentActivity(change: ActivityMutation): Promise<WriteReceipt> {
    const prior = this.lookupIdempotent<WriteReceipt>(change.idempotencyKey, "agent_activity", change);
    if (prior !== undefined) return prior;
    if (!this.#definitions.has(change.subAgentId)) {
      throw new Error(`Unknown Sub-agent definition: ${change.subAgentId}`);
    }
    const current = this.#activities.get(change.subAgentId) ?? { runLeaseIds: [], taskIds: [] };
    if (
      !this.sameSet(current.runLeaseIds, change.expectedRunLeaseIds) ||
      !this.sameSet(current.taskIds, change.expectedTaskIds)
    ) {
      throw new Error("Sub-agent activity version conflict");
    }
    const projection = await this.getLeaseProjection(change.subAgentId);
    if (!this.sameSet(projection.runLeaseIds, change.nextRunLeaseIds) || !this.sameSet(projection.taskIds, change.nextTaskIds)) {
      throw new Error("Sub-agent activity must equal the provider's active lease projection");
    }
    this.#activities.set(change.subAgentId, {
      runLeaseIds: this.normalizedSet(change.nextRunLeaseIds),
      taskIds: this.normalizedSet(change.nextTaskIds),
    });
    const version = this.nextEntityVersion("subAgents", change.subAgentId);
    const receipt = this.receipt(
      "subAgents",
      change.subAgentId,
      change.idempotencyKey,
      version,
    );
    this.recordIdempotent(change.idempotencyKey, "agent_activity", change, receipt);
    return clone(receipt);
  }

  public async listTaskSummaries(query: TaskQuery): Promise<readonly TaskSummary[]> {
    for (const key of Object.keys(query.predicate)) {
      if (!TASK_SUMMARY_KEYS.has(key)) throw new Error(`Unsupported task predicate: ${key}`);
    }

    const matching = [...this.#tasks.values()]
      .map((task) => this.taskSummary(task))
      .filter((task) =>
        Object.entries(query.predicate).every(([key, expected]) =>
          Object.is(task[key as keyof TaskSummary], expected),
        ),
      );
    return pageAfter(matching, query, (task) => task.id).map((task) => clone(task));
  }

  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new Error(`Unknown Task: ${taskId}`);
    return clone(task);
  }

  public async applyTaskMutation(mutation: ConditionalTaskMutation): Promise<WriteReceipt> {
    const prior = this.lookupIdempotent<WriteReceipt>(mutation.idempotencyKey, "task", mutation);
    if (prior !== undefined) return prior;
    const task = this.#tasks.get(mutation.taskId);
    if (task === undefined) throw new Error(`Unknown Task: ${mutation.taskId}`);
    if (task.version !== mutation.expectedVersion) throw new Error("Task version conflict");
    if (mutation.nextStatus !== null && !this.#taskStatusOptions.has(mutation.nextStatus)) throw new Error(`Unknown Task status: ${mutation.nextStatus}`);
    const status = mutation.nextStatus ?? task.status;
    const version = `memory:${task.id}:${randomUUID()}`;
    this.#tasks.set(task.id, {
      ...clone(task),
      body: mutation.nextBody ?? task.body,
      properties: taskPropertiesWithStatus(mutation.nextProperties, status),
      status,
      version,
    });
    const receipt = this.receipt("tasks", task.id, mutation.idempotencyKey, version);
    this.recordIdempotent(mutation.idempotencyKey, "task", mutation, receipt);
    return clone(receipt);
  }

  public async getResources(refs: readonly ResourceRef[]): Promise<readonly ResourceRecord[]> {
    return refs.map((ref) => {
      const resource = this.#resources.get(ref.key);
      if (resource === undefined) throw new Error(`Unknown Resource: ${ref.key}`);
      if (ref.version !== null && ref.version !== resource.version) {
        throw new Error(`Resource version mismatch: ${ref.key}`);
      }
      if (ref.digest !== null && ref.digest !== resource.digest) {
        throw new Error(`Resource digest mismatch: ${ref.key}`);
      }
      return clone(resource);
    });
  }

  public async getOptionalResource(key: string): Promise<ResourceRecord | null> {
    const resource = this.#resources.get(key);
    return resource === undefined ? null : clone(resource);
  }

  public async putResource(record: ResourceMutation): Promise<WriteReceipt> {
    const prior = this.lookupIdempotent<WriteReceipt>(record.idempotencyKey, "resource", record);
    if (prior !== undefined) return prior;
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
    const receipt = this.receipt("resources", stored.key, record.idempotencyKey, stored.version);
    this.recordIdempotent(record.idempotencyKey, "resource", record, receipt);
    return clone(receipt);
  }

  public async acquireLease(request: LeaseRequest): Promise<LeaseResult> {
    const prior = this.lookupIdempotent<LeaseResult>(request.idempotencyKey, "lease_acquire", request);
    if (prior !== undefined) return prior;
    this.validateLeaseRequest(request);
    this.pruneExpiredLeases();
    const conflict = [...this.#leases.values()].find((lease) =>
      request.scope === "task_assignment"
        ? lease.scope === request.scope && lease.taskId === request.taskId
        : lease.scope === request.scope && lease.ownerId === request.ownerId && lease.subAgentId === request.subAgentId,
    );
    const result: LeaseResult =
      conflict === undefined
        ? { acquired: true, conflictingLeaseId: null, leaseId: randomUUID() }
        : { acquired: false, conflictingLeaseId: conflict.id, leaseId: null };
    if (result.leaseId !== null) {
      for (const [leaseId, released] of this.#releasedLeases) if (sameLeaseSlot(released, request)) this.#releasedLeases.delete(leaseId);
      this.#leases.set(result.leaseId, { ...clone(request), id: result.leaseId });
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

  public async renewLease(request: LeaseRenewal): Promise<LeaseResult> {
    const prior = this.lookupIdempotent<LeaseResult>(request.idempotencyKey, "lease_renew", request);
    if (prior !== undefined) return prior;
    this.pruneExpiredLeases();
    const lease = this.#leases.get(request.leaseId);
    const nextExpiry = this.parseFutureTimestamp(request.nextExpiresAt, "nextExpiresAt");
    if (
      lease === undefined ||
      lease.ownerId !== request.ownerId ||
      lease.expiresAt !== request.expectedExpiresAt ||
      nextExpiry <= Date.parse(lease.expiresAt)
    ) {
      const result = { acquired: false, conflictingLeaseId: request.leaseId, leaseId: null };
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
    const result = { acquired: true, conflictingLeaseId: null, leaseId: lease.id };
    this.recordIdempotent(request.idempotencyKey, "lease_renew", request, result);
    return clone(result);
  }

  public async releaseLease(request: LeaseRelease): Promise<WriteReceipt> {
    const key = `lease-release:${request.leaseId}:${request.ownerId}:${request.expectedVersion ?? "unversioned"}`;
    const prior = this.lookupIdempotent<WriteReceipt>(key, "lease_release", request);
    if (prior !== undefined) return prior;
    const lease = this.#leases.get(request.leaseId);
    if (lease === undefined || lease.ownerId !== request.ownerId || (request.expectedVersion !== null && request.expectedVersion !== digestJson(toJsonValue({ ...lease, released: false })))) {
      throw new Error("Lease release conflict");
    }
    this.#leases.delete(request.leaseId);
    this.#releasedLeases.set(request.leaseId, lease);
    const receipt = this.receipt("resources", lease.id, key, lease.expiresAt);
    this.recordIdempotent(key, "lease_release", request, receipt);
    return clone(receipt);
  }

  public async createOrUpdateError(error: ErrorMutation): Promise<WriteReceipt> {
    const prior = this.lookupIdempotent<WriteReceipt>(error.idempotencyKey, "error", error);
    if (prior !== undefined) return prior;
    const { idempotencyKey: _idempotencyKey, ...stored } = error;
    this.#errors.set(error.errorKey, clone(stored));
    const version = this.nextEntityVersion("errors", error.errorKey);
    const receipt = this.receipt("errors", error.errorKey, error.idempotencyKey, version);
    this.recordIdempotent(error.idempotencyKey, "error", error, receipt);
    return clone(receipt);
  }

  public async reconcileIntent(intentId: string): Promise<ReconciliationResult> {
    return clone(this.#intentOutcomes.get(intentId) ?? { evidence: {}, state: "not_applied" });
  }

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

  private validateLeaseRequest(request: LeaseRequest): void {
    if (
      (request.scope === "task_assignment" && request.taskId === null) ||
      (request.scope === "agent_run" && request.taskId !== null)
    ) {
      throw new Error(`Lease scope ${request.scope} has an invalid task identity`);
    }
    this.parseFutureTimestamp(request.expiresAt, "expiresAt");
  }

  private parseFutureTimestamp(value: string, field: string): number {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp <= this.now().getTime()) {
      throw new Error(`${field} must be a valid future timestamp`);
    }
    return timestamp;
  }

  private pruneExpiredLeases(): void {
    const now = this.now().getTime();
    for (const [id, lease] of this.#leases) {
      if (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= now) {
        this.#leases.delete(id);
      }
    }
  }

  private nextEntityVersion(table: TableKind, id: string): string {
    const key = `${table}:${id}`;
    const version = (this.#entityVersions.get(key) ?? 0) + 1;
    this.#entityVersions.set(key, version);
    return `memory:${key}:${version}`;
  }

  private normalizedSet(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort();
  }

  private sameSet(left: readonly string[], right: readonly string[]): boolean {
    return this.normalizedSet(left).join("\0") === this.normalizedSet(right).join("\0");
  }

  private lookupIdempotent<T>(key: string, operation: string, payload: unknown): T | undefined {
    return this.#idempotency.read<T>(key, operation, toJsonValue(payload));
  }

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
