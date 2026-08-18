/** Small provider boundary used by the coordination service. */
import type {
  ActiveAgentRecord,
  AgentRecord,
  ErrorRecord,
  ReportErrorInput,
  ResourceRecord,
  TaskRecord,
} from "../domain/records.js";
import type { ValidationReport, WorkspacePlan } from "../domain/provider.js";

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
}
export interface ActiveAgentPatch {
  readonly failureSummary?: string;
  readonly finishedAt?: string | null;
  readonly lastHeartbeat?: string;
  readonly outcome?: string;
  readonly status?: ActiveAgentRecord["status"];
}

export interface AgentTaskProvider {
  validateEnvironment(): Promise<ValidationReport>;
  validateWorkspace(): Promise<ValidationReport>;
  planWorkspace(environmentId: string): Promise<WorkspacePlan>;
  applyWorkspacePlan(
    plan: WorkspacePlan,
  ): Promise<Readonly<Record<string, string>>>;
  listTasks(status?: string): Promise<readonly TaskRecord[]>;
  getTask(id: string): Promise<TaskRecord | null>;
  setTaskStatus(id: string, status: string): Promise<TaskRecord>;
  listAgents(): Promise<readonly AgentRecord[]>;
  getAgentByKey(key: string): Promise<AgentRecord | null>;
  listResources(): Promise<readonly ResourceRecord[]>;
  getResourceByKey(key: string): Promise<ResourceRecord | null>;
  listActiveAgents(): Promise<readonly ActiveAgentRecord[]>;
  getActiveAgent(runId: string): Promise<ActiveAgentRecord | null>;
  createActiveAgent(input: CreateActiveAgentRecord): Promise<ActiveAgentRecord>;
  updateActiveAgent(
    runId: string,
    patch: ActiveAgentPatch,
  ): Promise<ActiveAgentRecord>;
  archiveActiveAgent(runId: string): Promise<void>;
  listErrors(): Promise<readonly ErrorRecord[]>;
  getErrorByKey(key: string): Promise<ErrorRecord | null>;
  reportError(input: ReportErrorInput): Promise<ErrorRecord>;
  resolveError(key: string, resolution: string): Promise<ErrorRecord>;
}
