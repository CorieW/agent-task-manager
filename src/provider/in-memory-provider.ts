/** In-memory provider used by hosts and tests. */
import { randomUUID } from "node:crypto";

import { digestJson } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type {
  ActiveAgentRecord,
  AgentRecord,
  ErrorRecord,
  ReportErrorInput,
  ResourceRecord,
  TaskRecord,
} from "../domain/records.js";
import type { ValidationReport, WorkspacePlan } from "../domain/provider.js";
import type {
  ActiveAgentPatch,
  AgentTaskProvider,
  CreateActiveAgentRecord,
} from "./agent-task-provider.js";

/** Optional records used to initialize an isolated in-memory provider. */
export interface InMemorySeed {
  /** Initial Active Agent records for the in-memory provider. */
  readonly activeAgents?: readonly ActiveAgentRecord[];
  /** Initial Agent records for the in-memory provider. */
  readonly agents?: readonly AgentRecord[];
  /** Initial Error records for the in-memory provider. */
  readonly errors?: readonly ErrorRecord[];
  /** Ordered Resources supplied as immutable Agent context. */
  readonly resources?: readonly ResourceRecord[];
  /** Initial Task records for the in-memory provider. */
  readonly tasks?: readonly TaskRecord[];
}

/** In-process AgentTaskProvider implementation for hosts and tests. */
export class InMemoryProvider implements AgentTaskProvider {
  /** Active-agent records indexed by run ID. */
  readonly #activeAgents = new Map<string, ActiveAgentRecord>();
  /** Agent definitions indexed by record ID. */
  readonly #agents = new Map<string, AgentRecord>();
  /** Error records indexed by error key. */
  readonly #errors = new Map<string, ErrorRecord>();
  /** Resource records indexed by record ID. */
  readonly #resources = new Map<string, ResourceRecord>();
  /** Task records indexed by task ID. */
  readonly #tasks = new Map<string, TaskRecord>();
  /** Monotonic counter used for optimistic-concurrency versions. */
  #clock = 0;

  /** Copies the supplied seed into independent mutable maps. */
  public constructor(seed: InMemorySeed = {}) {
    for (const value of seed.tasks ?? [])
      this.#tasks.set(value.id, cloneRecord(value));
    for (const value of seed.agents ?? [])
      this.#agents.set(value.id, cloneRecord(value));
    for (const value of seed.resources ?? [])
      this.#resources.set(value.id, cloneRecord(value));
    for (const value of seed.activeAgents ?? [])
      this.#activeAgents.set(value.runId, cloneRecord(value));
    for (const value of seed.errors ?? [])
      this.#errors.set(value.errorKey, cloneRecord(value));
  }

  /** @inheritdoc */
  public async validateEnvironment(): Promise<ValidationReport> {
    return { issues: [], valid: true };
  }

  /** @inheritdoc */
  public async validateWorkspace(): Promise<ValidationReport> {
    return { issues: [], valid: true };
  }

  /** @inheritdoc */
  public async planWorkspace(environmentId: string): Promise<WorkspacePlan> {
    /** Serialized fields covered by the deterministic digest. */
    const core = {
      environmentId,
      observedSchemaDigest: "memory",
      schema: "workspace-plan-v1" as const,
      steps: [],
      target: { storage: "memory" },
      targetSchemaDigest: "memory",
    };
    return { ...core, digest: digestJson(toJsonValue(core)) };
  }

  /** @inheritdoc */
  public async applyWorkspacePlan(
    _plan: WorkspacePlan,
  ): Promise<Readonly<Record<string, string>>> {
    return {};
  }

  /** @inheritdoc */
  public async listTasks(status?: string): Promise<readonly TaskRecord[]> {
    return [...this.#tasks.values()]
      .filter(
        (entry) =>
          !entry.archived && (status === undefined || entry.status === status),
      )
      .map(cloneRecord);
  }

  /** @inheritdoc */
  public async getTask(id: string): Promise<TaskRecord | null> {
    return cloneOrNull(this.#tasks.get(id));
  }

  /** @inheritdoc */
  public async setTaskStatus(
    id: string,
    expectedStatus: string,
    expectedVersion: string,
    status: string,
  ): Promise<TaskRecord> {
    /** Current provider record loaded before applying a mutation. */
    const current = requireRecord(this.#tasks.get(id), `Task not found: ${id}`);
    if (
      current.status !== expectedStatus ||
      current.version !== expectedVersion
    )
      throw new Error("Task changed before status update");
    /** Updated immutable record to persist after the mutation. */
    const next = { ...current, status, version: this.nextMemoryVersion() };
    this.#tasks.set(id, next);
    return cloneRecord(next);
  }

  /** @inheritdoc */
  public async updateTaskBody(
    id: string,
    expectedBody: string,
    body: string,
  ): Promise<TaskRecord> {
    /** Current provider record loaded before applying a mutation. */
    const current = requireRecord(this.#tasks.get(id), `Task not found: ${id}`);
    if (current.body !== expectedBody)
      throw new Error("Task description changed before update");
    /** Updated immutable record to persist after the mutation. */
    const next = { ...current, body, version: this.nextMemoryVersion() };
    this.#tasks.set(id, next);
    return cloneRecord(next);
  }

  /** @inheritdoc */
  public async listAgents(): Promise<readonly AgentRecord[]> {
    return [...this.#agents.values()]
      .filter((entry) => !entry.archived)
      .map(cloneRecord);
  }

  /** @inheritdoc */
  public async getAgent(id: string): Promise<AgentRecord | null> {
    return cloneOrNull(this.#agents.get(id));
  }

  /** @inheritdoc */
  public async getAgentByKey(key: string): Promise<AgentRecord | null> {
    return cloneOrNull(
      [...this.#agents.values()].find((entry) => entry.key === key),
    );
  }

  /** @inheritdoc */
  public async listResources(): Promise<readonly ResourceRecord[]> {
    return [...this.#resources.values()]
      .filter((entry) => !entry.archived)
      .map(cloneRecord);
  }

  /** @inheritdoc */
  public async getResourceByKey(key: string): Promise<ResourceRecord | null> {
    return cloneOrNull(
      [...this.#resources.values()].find((entry) => entry.key === key),
    );
  }

  /** @inheritdoc */
  public async listActiveAgents(): Promise<readonly ActiveAgentRecord[]> {
    return [...this.#activeAgents.values()]
      .filter((entry) => !entry.archived)
      .map(cloneRecord);
  }

  /** @inheritdoc */
  public async getActiveAgent(
    runId: string,
  ): Promise<ActiveAgentRecord | null> {
    return cloneOrNull(this.#activeAgents.get(runId));
  }

  /** @inheritdoc */
  public async createActiveAgent(
    input: CreateActiveAgentRecord,
  ): Promise<ActiveAgentRecord> {
    if (this.#activeAgents.has(input.runId))
      throw new Error(`Run ID already exists: ${input.runId}`);
    /** Strict record projected from the untyped boundary value. */
    const record: ActiveAgentRecord = {
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      archived: false,
      attempt: input.attempt,
      completionTaskStatus: "",
      failureSummary: "",
      finishedAt: null,
      harnessId: input.harnessId,
      id: randomUUID(),
      lastHeartbeat: input.startedAt,
      outcome: "",
      parentRunId: input.parentRunId,
      restartOfRunId: input.restartOfRunId,
      retryKey: input.retryKey,
      runId: input.runId,
      startedAt: input.startedAt,
      status: "running",
      taskId: input.taskId,
      version: this.nextMemoryVersion(),
      workingDirectory: input.workingDirectory,
    };
    this.#activeAgents.set(record.runId, record);
    return cloneRecord(record);
  }

  /** @inheritdoc */
  public async updateActiveAgent(
    runId: string,
    patch: ActiveAgentPatch,
  ): Promise<ActiveAgentRecord> {
    /** Current provider record loaded before applying a mutation. */
    const current = requireRecord(
      this.#activeAgents.get(runId),
      `Active Agent not found: ${runId}`,
    );
    /** Updated immutable record to persist after the mutation. */
    const next = { ...current, ...patch, version: this.nextMemoryVersion() };
    this.#activeAgents.set(runId, next);
    return cloneRecord(next);
  }

  /** @inheritdoc */
  public async archiveActiveAgent(runId: string): Promise<void> {
    /** Current provider record loaded before applying a mutation. */
    const current = requireRecord(
      this.#activeAgents.get(runId),
      `Active Agent not found: ${runId}`,
    );
    this.#activeAgents.set(runId, {
      ...current,
      archived: true,
      version: this.nextMemoryVersion(),
    });
  }

  /** @inheritdoc */
  public async listErrors(): Promise<readonly ErrorRecord[]> {
    return [...this.#errors.values()]
      .filter((entry) => !entry.archived)
      .map(cloneRecord);
  }

  /** @inheritdoc */
  public async getErrorByKey(key: string): Promise<ErrorRecord | null> {
    return cloneOrNull(this.#errors.get(key));
  }

  /** @inheritdoc */
  public async reportError(input: ReportErrorInput): Promise<ErrorRecord> {
    /** Existing record selected for an idempotent update. */
    const existing = this.#errors.get(input.errorKey);
    /** Strict record projected from the untyped boundary value. */
    const record: ErrorRecord = {
      ...input,
      archived: false,
      id: existing?.id ?? randomUUID(),
      status: "open",
      version: this.nextMemoryVersion(),
    };
    this.#errors.set(record.errorKey, record);
    return cloneRecord(record);
  }

  /** @inheritdoc */
  public async resolveError(
    key: string,
    resolution: string,
  ): Promise<ErrorRecord> {
    /** Current provider record loaded before applying a mutation. */
    const current = requireRecord(
      this.#errors.get(key),
      `Error not found: ${key}`,
    );
    /** Updated immutable record to persist after the mutation. */
    const next = {
      ...current,
      resolution,
      status: "resolved" as const,
      version: this.nextMemoryVersion(),
    };
    this.#errors.set(key, next);
    return cloneRecord(next);
  }

  /** Derives a stable optimistic-concurrency version. */
  private nextMemoryVersion(): string {
    this.#clock += 1;
    return `memory-${this.#clock}`;
  }
}

/** Deep-clones a stored record before it crosses the provider boundary. */
function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

/** Copies a value or preserves null without sharing mutable state. */
function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : cloneRecord(value);
}

/** Returns a stored record or throws the supplied not-found error. */
function requireRecord<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
