import { randomUUID } from "node:crypto";

import { digestJson } from "../core/digest.js";
import { finalizeMigrationPlan } from "../core/migration-plan.js";
import { compareWorkspaceSchema } from "../core/schema-diff.js";
import type { JsonValue } from "../domain/json.js";
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
  WorkspaceSchemaDescriptor,
  WorkspaceSchemaRequest,
  WorkspaceSchemaSnapshot,
} from "../domain/schema.js";
import type { AgentTaskProvider } from "./agent-task-provider.js";

interface MemoryLease extends LeaseRequest {
  readonly id: string;
}

export class InMemoryProvider implements AgentTaskProvider {
  readonly #definitions = new Map<string, SubAgentDefinition>();
  readonly #leases = new Map<string, MemoryLease>();
  readonly #resources = new Map<string, ResourceRecord>();
  readonly #tasks = new Map<string, TaskSnapshot>();
  #snapshot: WorkspaceSchemaSnapshot;

  public constructor(
    private readonly environment: ProviderEnvironment,
    private readonly target: WorkspaceSchemaDescriptor,
    snapshot?: WorkspaceSchemaSnapshot,
  ) {
    this.#snapshot =
      snapshot ??
      ({
        capturedAt: new Date(0).toISOString(),
        digest: digestJson([]),
        providerIdentity: "memory",
        tables: [],
      } satisfies WorkspaceSchemaSnapshot);
  }

  public seedDefinition(definition: SubAgentDefinition): void {
    this.#definitions.set(definition.id, definition);
  }

  public seedTask(task: TaskSnapshot): void {
    this.#tasks.set(task.id, task);
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

  public async validateEnvironment(): Promise<ValidationReport> {
    return { issues: [], valid: this.environment.type === "memory" };
  }

  public async inspectWorkspaceSchema(): Promise<WorkspaceSchemaSnapshot> {
    return this.#snapshot;
  }

  public async validateTables(): Promise<TableValidationReport> {
    return compareWorkspaceSchema(this.#snapshot, this.target);
  }

  public async planWorkspaceChanges(
    request: WorkspaceSchemaRequest,
  ): Promise<WorkspaceMigrationPlan> {
    const missing = request.target.tables.filter(
      (expected) => !request.observed.tables.some((table) => table.kind === expected.kind),
    );
    const steps: WorkspaceMigrationStep[] = missing.map((table, index) => ({
      dependsOn: index === 0 ? [] : [missing[index - 1]?.kind ?? ""],
      expectedPostSchemaDigest: `pending:${table.kind}`,
      expectedPreSchemaDigest: request.observed.digest,
      id: table.kind,
      kind: "create_table",
      payload: { kind: table.kind, title: table.title },
      reversibility: "additive",
    }));
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
    const kind = step.payload.kind;
    if (step.kind !== "create_table" || typeof kind !== "string") {
      throw new Error(`Unsupported in-memory migration step: ${step.kind}`);
    }
    const descriptor = this.target.tables.find((table) => table.kind === kind);
    if (descriptor === undefined) throw new Error(`Unknown table kind: ${kind}`);
    if (!this.#snapshot.tables.some((table) => table.kind === descriptor.kind)) {
      this.#snapshot = {
        ...this.#snapshot,
        capturedAt: new Date().toISOString(),
        tables: [
          ...this.#snapshot.tables,
          {
            id: `memory:${descriptor.kind}`,
            kind: descriptor.kind,
            properties: [],
            title: descriptor.title,
            version: "1",
          },
        ],
      };
      this.#snapshot = {
        ...this.#snapshot,
        digest: digestJson(JSON.parse(JSON.stringify(this.#snapshot.tables)) as JsonValue),
      };
    }
    return this.receipt("resources", step.id);
  }

  public async reconcileWorkspaceStep(): Promise<ReconciliationResult> {
    return { evidence: {}, state: "applied" };
  }

  public async listSubAgentDefinitions(): Promise<readonly SubAgentDefinition[]> {
    return [...this.#definitions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  public async getSubAgentDefinition(id: string): Promise<SubAgentDefinition> {
    const definition = this.#definitions.get(id);
    if (definition === undefined) throw new Error(`Unknown Sub-agent definition: ${id}`);
    return definition;
  }

  public async updateSubAgentActivity(change: ActivityMutation): Promise<WriteReceipt> {
    return this.receipt("subAgents", change.idempotencyKey);
  }

  public async listTaskSummaries(query: TaskQuery): Promise<readonly TaskSummary[]> {
    return [...this.#tasks.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, query.limit);
  }

  public async getTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new Error(`Unknown Task: ${taskId}`);
    return task;
  }

  public async applyTaskMutation(mutation: ConditionalTaskMutation): Promise<WriteReceipt> {
    const task = await this.getTaskSnapshot(mutation.taskId);
    if (task.version !== mutation.expectedVersion) throw new Error("Task version conflict");
    this.#tasks.set(task.id, {
      ...task,
      body: mutation.nextBody ?? task.body,
      properties: mutation.nextProperties,
      version: String(Number(task.version) + 1),
    });
    return this.receipt("tasks", mutation.idempotencyKey);
  }

  public async getResources(refs: readonly ResourceRef[]): Promise<readonly ResourceRecord[]> {
    return refs.map((ref) => {
      const resource = this.#resources.get(ref.key);
      if (resource === undefined) throw new Error(`Unknown Resource: ${ref.key}`);
      if (ref.digest !== null && ref.digest !== resource.digest) {
        throw new Error(`Resource digest mismatch: ${ref.key}`);
      }
      return resource;
    });
  }

  public async putResource(record: ResourceMutation): Promise<WriteReceipt> {
    this.#resources.set(record.key, record);
    return this.receipt("resources", record.idempotencyKey);
  }

  public async acquireLease(request: LeaseRequest): Promise<LeaseResult> {
    const conflict = [...this.#leases.values()].find(
      (lease) =>
        lease.scope === request.scope &&
        lease.subAgentId === request.subAgentId &&
        lease.taskId === request.taskId,
    );
    if (conflict !== undefined) {
      return { acquired: false, conflictingLeaseId: conflict.id, leaseId: null };
    }
    const id = randomUUID();
    this.#leases.set(id, { ...request, id });
    return { acquired: true, conflictingLeaseId: null, leaseId: id };
  }

  public async renewLease(request: LeaseRenewal): Promise<LeaseResult> {
    const lease = this.#leases.get(request.leaseId);
    if (
      lease === undefined ||
      lease.ownerId !== request.ownerId ||
      lease.expiresAt !== request.expectedExpiresAt
    ) {
      return { acquired: false, conflictingLeaseId: request.leaseId, leaseId: null };
    }
    this.#leases.set(lease.id, { ...lease, expiresAt: request.nextExpiresAt });
    return { acquired: true, conflictingLeaseId: null, leaseId: lease.id };
  }

  public async releaseLease(request: LeaseRelease): Promise<WriteReceipt> {
    const lease = this.#leases.get(request.leaseId);
    if (lease === undefined || lease.ownerId !== request.ownerId) {
      throw new Error("Lease release conflict");
    }
    this.#leases.delete(request.leaseId);
    return this.receipt("resources", request.leaseId);
  }

  public async createOrUpdateError(error: ErrorMutation): Promise<WriteReceipt> {
    return this.receipt("errors", error.errorKey);
  }

  public async reconcileIntent(): Promise<ReconciliationResult> {
    return { evidence: {}, state: "not_applied" };
  }

  private receipt(table: "errors" | "resources" | "subAgents" | "tasks", key: string): WriteReceipt {
    return {
      idempotencyKey: key,
      observedVersion: "1",
      providerRecord: { id: key, table },
      writtenAt: new Date().toISOString(),
    };
  }
}
