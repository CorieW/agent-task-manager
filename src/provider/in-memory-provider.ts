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
  readonly activeAgents?: readonly ActiveAgentRecord[];
  readonly agents?: readonly AgentRecord[];
  readonly errors?: readonly ErrorRecord[];
  readonly resources?: readonly ResourceRecord[];
  readonly tasks?: readonly TaskRecord[];
}

/** In-process AgentTaskProvider implementation for hosts and tests. */
export class InMemoryProvider implements AgentTaskProvider {
  readonly #activeAgents = new Map<string, ActiveAgentRecord>();
  readonly #agents = new Map<string, AgentRecord>();
  readonly #errors = new Map<string, ErrorRecord>();
  readonly #resources = new Map<string, ResourceRecord>();
  readonly #tasks = new Map<string, TaskRecord>();
  #clock = 0;

  /** Copies the supplied seed into independent mutable maps. */
  public constructor(seed: InMemorySeed = {}) {
    for (const value of seed.tasks ?? [])
      this.#tasks.set(value.id, clone(value));
    for (const value of seed.agents ?? [])
      this.#agents.set(value.id, clone(value));
    for (const value of seed.resources ?? [])
      this.#resources.set(value.id, clone(value));
    for (const value of seed.activeAgents ?? [])
      this.#activeAgents.set(value.runId, clone(value));
    for (const value of seed.errors ?? [])
      this.#errors.set(value.errorKey, clone(value));
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
    const core = {
      environmentId,
      schema: "workspace-plan-v2" as const,
      steps: [],
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
      .map(clone);
  }
  /** @inheritdoc */
  public async getTask(id: string): Promise<TaskRecord | null> {
    return nullable(this.#tasks.get(id));
  }
  /** @inheritdoc */
  public async setTaskStatus(id: string, status: string): Promise<TaskRecord> {
    const current = required(this.#tasks.get(id), `Task not found: ${id}`);
    const next = { ...current, status, version: this.version() };
    this.#tasks.set(id, next);
    return clone(next);
  }
  /** @inheritdoc */
  public async listAgents(): Promise<readonly AgentRecord[]> {
    return [...this.#agents.values()]
      .filter((entry) => !entry.archived)
      .map(clone);
  }
  /** @inheritdoc */
  public async getAgent(id: string): Promise<AgentRecord | null> {
    return nullable(this.#agents.get(id));
  }
  /** @inheritdoc */
  public async getAgentByKey(key: string): Promise<AgentRecord | null> {
    return nullable(
      [...this.#agents.values()].find((entry) => entry.key === key),
    );
  }
  /** @inheritdoc */
  public async listResources(): Promise<readonly ResourceRecord[]> {
    return [...this.#resources.values()]
      .filter((entry) => !entry.archived)
      .map(clone);
  }
  /** @inheritdoc */
  public async getResourceByKey(key: string): Promise<ResourceRecord | null> {
    return nullable(
      [...this.#resources.values()].find((entry) => entry.key === key),
    );
  }
  /** @inheritdoc */
  public async listActiveAgents(): Promise<readonly ActiveAgentRecord[]> {
    return [...this.#activeAgents.values()]
      .filter((entry) => !entry.archived)
      .map(clone);
  }
  /** @inheritdoc */
  public async getActiveAgent(
    runId: string,
  ): Promise<ActiveAgentRecord | null> {
    return nullable(this.#activeAgents.get(runId));
  }
  /** @inheritdoc */
  public async createActiveAgent(
    input: CreateActiveAgentRecord,
  ): Promise<ActiveAgentRecord> {
    if (this.#activeAgents.has(input.runId))
      throw new Error(`Run ID already exists: ${input.runId}`);
    const record: ActiveAgentRecord = {
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      archived: false,
      attempt: input.attempt,
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
      version: this.version(),
    };
    this.#activeAgents.set(record.runId, record);
    return clone(record);
  }
  /** @inheritdoc */
  public async updateActiveAgent(
    runId: string,
    patch: ActiveAgentPatch,
  ): Promise<ActiveAgentRecord> {
    const current = required(
      this.#activeAgents.get(runId),
      `Active Agent not found: ${runId}`,
    );
    const next = { ...current, ...patch, version: this.version() };
    this.#activeAgents.set(runId, next);
    return clone(next);
  }
  /** @inheritdoc */
  public async archiveActiveAgent(runId: string): Promise<void> {
    const current = required(
      this.#activeAgents.get(runId),
      `Active Agent not found: ${runId}`,
    );
    this.#activeAgents.set(runId, {
      ...current,
      archived: true,
      version: this.version(),
    });
  }
  /** @inheritdoc */
  public async listErrors(): Promise<readonly ErrorRecord[]> {
    return [...this.#errors.values()]
      .filter((entry) => !entry.archived)
      .map(clone);
  }
  /** @inheritdoc */
  public async getErrorByKey(key: string): Promise<ErrorRecord | null> {
    return nullable(this.#errors.get(key));
  }
  /** @inheritdoc */
  public async reportError(input: ReportErrorInput): Promise<ErrorRecord> {
    const existing = this.#errors.get(input.errorKey);
    const record: ErrorRecord = {
      ...input,
      archived: false,
      id: existing?.id ?? randomUUID(),
      status: "open",
      version: this.version(),
    };
    this.#errors.set(record.errorKey, record);
    return clone(record);
  }
  /** @inheritdoc */
  public async resolveError(
    key: string,
    resolution: string,
  ): Promise<ErrorRecord> {
    const current = required(this.#errors.get(key), `Error not found: ${key}`);
    const next = {
      ...current,
      resolution,
      status: "resolved" as const,
      version: this.version(),
    };
    this.#errors.set(key, next);
    return clone(next);
  }

  private version(): string {
    this.#clock += 1;
    return `memory-${this.#clock}`;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}
function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
