/** Persistence and workspace-management contract used by the coordinator. */
import type {
  ActiveAgentRecord,
  AgentRecord,
  ErrorRecord,
  ReportErrorInput,
  ResourceRecord,
  TaskRecord,
} from "../domain/records.js";
import type { ValidationReport, WorkspacePlan } from "../domain/provider.js";

/** Complete immutable input required to create a running Active Agent. */
export interface CreateActiveAgentRecord {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly attempt: number;
  readonly harnessId: string;
  readonly parentRunId: string | null;
  readonly restartOfRunId: string | null;
  readonly retryKey: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly taskId: string;
  readonly workingDirectory: string | null;
}
/** Mutable lifecycle fields accepted when updating an Active Agent. */
export interface ActiveAgentPatch {
  readonly failureSummary?: string;
  readonly finishedAt?: string | null;
  readonly lastHeartbeat?: string;
  readonly outcome?: string;
  readonly status?: ActiveAgentRecord["status"];
}

/** Provider-neutral persistence boundary for all five managed record families. */
export interface AgentTaskProvider {
  /** Validates provider configuration without mutating external state. */
  validateEnvironment(): Promise<ValidationReport>;
  /** Validates configured tables, schema, and managed records without mutation. */
  validateWorkspace(): Promise<ValidationReport>;
  /** Builds a deterministic digest-bearing workspace plan without mutation. */
  planWorkspace(environmentId: string): Promise<WorkspacePlan>;
  /** Applies an authorized plan and returns the resulting table identifiers. */
  applyWorkspacePlan(
    plan: WorkspacePlan,
  ): Promise<Readonly<Record<string, string>>>;
  /** Lists live, non-archived Tasks, optionally filtered by status. */
  listTasks(status?: string): Promise<readonly TaskRecord[]>;
  /** Returns a Task by provider record ID, or null. */
  getTask(id: string): Promise<TaskRecord | null>;
  /** Replaces a Task status and returns the versioned record. */
  setTaskStatus(id: string, status: string): Promise<TaskRecord>;
  /** Atomically replaces exact Task Markdown and returns the versioned record. */
  updateTaskBody(
    id: string,
    expectedBody: string,
    body: string,
  ): Promise<TaskRecord>;
  /** Lists live, non-archived Agents. */
  listAgents(): Promise<readonly AgentRecord[]>;
  /** Returns an Agent by provider record ID without loading unrelated Agents. */
  getAgent(id: string): Promise<AgentRecord | null>;
  /** Returns the Agent with the stable definition key, or null. */
  getAgentByKey(key: string): Promise<AgentRecord | null>;
  /** Lists live, non-archived Resources. */
  listResources(): Promise<readonly ResourceRecord[]>;
  /** Returns the uniquely keyed Resource, or null. */
  getResourceByKey(key: string): Promise<ResourceRecord | null>;
  /** Lists live, non-archived Active Agent records. */
  listActiveAgents(): Promise<readonly ActiveAgentRecord[]>;
  /** Returns the Active Agent identified by its harness Run ID, or null. */
  getActiveAgent(runId: string): Promise<ActiveAgentRecord | null>;
  /** Creates one new running Active Agent; duplicate Run IDs are rejected. */
  createActiveAgent(input: CreateActiveAgentRecord): Promise<ActiveAgentRecord>;
  /** Applies a lifecycle patch and returns the newly versioned record. */
  updateActiveAgent(
    runId: string,
    patch: ActiveAgentPatch,
  ): Promise<ActiveAgentRecord>;
  /** Archives an Active Agent record without deleting its history. */
  archiveActiveAgent(runId: string): Promise<void>;
  /** Lists live, non-archived Errors. */
  listErrors(): Promise<readonly ErrorRecord[]>;
  /** Returns the Error with the stable key, or null. */
  getErrorByKey(key: string): Promise<ErrorRecord | null>;
  /** Creates or reopens the Error identified by `errorKey`. */
  reportError(input: ReportErrorInput): Promise<ErrorRecord>;
  /** Stores a resolution and marks the keyed Error resolved. */
  resolveError(key: string, resolution: string): Promise<ErrorRecord>;
}
