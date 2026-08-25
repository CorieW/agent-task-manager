/** Provider-neutral Task, Agent, Resource, run, and Error records. */
import type { JsonObject } from "../json.js";
import type { AgentCommandPolicy } from "../commands.js";
import type { AgentLifecycleConfig } from "../lifecycle.js";
import type { AgentTaskDescriptionConfig } from "../task-description.js";

/** Lifecycle state of a Resource. */
export type ResourceState = "active" | "draft" | "retired";
/** Terminal or running state of an Active Agent. */
export type ActiveAgentStatus =
  "running" | "failed" | "stale" | "completed" | "stopped";
/** Origin classification of an Error. */
export type ErrorSource = "human" | "ai" | "system";
/** Resolution state of an Error. */
export type ErrorStatus = "open" | "resolved";
/** Impact classification of an Error. */
export type ErrorSeverity = "critical" | "high" | "medium" | "low";
/** Maps Agent outcomes to Task statuses; `$current` preserves the status. */
export type AgentTransitions = Readonly<Record<string, string>>;

/** Validated authoritative configuration parsed from an Agent page body. */
export interface AgentDefinition {
  /** Task statuses from which this Agent may be assigned work. */
  readonly allowedStatuses: readonly string[];
  /** Task types on which this Agent may be assigned work. */
  readonly allowedTaskTypes: readonly string[];
  /** Harness identity allowed to invoke this Agent. */
  readonly calledBy: string;
  /** Agent command inclusion or exclusion policy. */
  readonly commands: AgentCommandPolicy;
  /** Whether the Agent may currently receive assignments. */
  readonly enabled: boolean;
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Trusted host commands surrounding the Agent lifecycle. */
  readonly lifecycleCommands: AgentLifecycleConfig;
  /** Model identifier requested by the Agent definition. */
  readonly model: string;
  /** Optional operator-facing Agent notes. */
  readonly notes: string;
  /** Reasoning-effort setting requested by the Agent definition. */
  readonly reasoning: string;
  /** Stable Resource keys requested by the Agent definition. */
  readonly resourceKeys: readonly string[];
  /** Agent capabilities for reading and updating Task-description sections. */
  readonly taskDescription: AgentTaskDescriptionConfig;
  /** Mapping from Agent outcomes to destination Task statuses. */
  readonly transitions: AgentTransitions;
}

/** Provider-neutral projection of one Task record. */
export interface TaskRecord {
  /** Whether the provider record is archived. */
  readonly archived: boolean;
  /** Authoritative Markdown body of the provider record. */
  readonly body: string;
  /** Provider IDs of Tasks that this Task depends on. */
  readonly dependencies: readonly string[];
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Optional Task scheduling priority. */
  readonly priority: number | null;
  /** Provider-specific properties retained at the domain boundary. */
  readonly properties: JsonObject;
  /** Current lifecycle status of the record or process. */
  readonly status: string;
  /** Human-readable title of the record or command. */
  readonly title: string;
  /** Domain, provider, or protocol type discriminator. */
  readonly type: string;
  /** Provider version used for optimistic consistency checks. */
  readonly version: string;
}

/** Provider-neutral projection of one Resource record. */
export interface ResourceRecord {
  /** Whether the provider record is archived. */
  readonly archived: boolean;
  /** Authoritative Markdown body of the provider record. */
  readonly body: string;
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Stable domain key used for lookup. */
  readonly key: string;
  /** Domain or protocol classification of the record. */
  readonly kind: string;
  /** Provider-specific properties retained at the domain boundary. */
  readonly properties: JsonObject;
  /** Lifecycle state of the Resource. */
  readonly state: ResourceState;
  /** Provider version used for optimistic consistency checks. */
  readonly version: string;
}

/** Provider-neutral projection of one Agent record and resolved configuration. */
export interface AgentRecord {
  /** Task statuses from which this Agent may be assigned work. */
  readonly allowedStatuses: readonly string[];
  /** Task types on which this Agent may be assigned work. */
  readonly allowedTaskTypes: readonly string[];
  /** Whether the provider record is archived. */
  readonly archived: boolean;
  /** Authoritative Markdown body of the provider record. */
  readonly body: string;
  /** Harness identity allowed to invoke this Agent. */
  readonly calledBy: string;
  /** Agent command inclusion or exclusion policy. */
  readonly commands: AgentCommandPolicy;
  /** Whether the Agent may currently receive assignments. */
  readonly enabled: boolean;
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Stable lookup key declared by the Agent definition. */
  readonly key: string;
  /** Trusted host commands surrounding the Agent lifecycle. */
  readonly lifecycleCommands: AgentLifecycleConfig;
  /** Model identifier requested by the Agent definition. */
  readonly model: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Optional operator-facing Agent notes. */
  readonly notes: string;
  /** Provider-specific properties retained at the domain boundary. */
  readonly properties: JsonObject;
  /** Reasoning-effort setting requested by the Agent definition. */
  readonly reasoning: string;
  /** Provider record IDs of Resources supplied to the Agent. */
  readonly resourceIds: readonly string[];
  /** Provider-supplied prior versions accepted only when rebasing a restart. */
  readonly restartCompatibleVersions?: readonly string[];
  /** Agent capabilities for reading and updating Task-description sections. */
  readonly taskDescription: AgentTaskDescriptionConfig;
  /** Mapping from Agent outcomes to destination Task statuses. */
  readonly transitions: AgentTransitions;
  /** Provider version used for optimistic consistency checks. */
  readonly version: string;
}

/** Provider-neutral projection of one Active Agent run record. */
export interface ActiveAgentRecord {
  /** Provider record ID of the related Agent. */
  readonly agentId: string;
  /** Agent record version captured when this run started. */
  readonly agentVersion: string;
  /** Whether the provider record is archived. */
  readonly archived: boolean;
  /** One-based attempt number within the retry chain. */
  readonly attempt: number;
  /** Terminal failure explanation recorded for the run. */
  readonly failureSummary: string;
  /** ISO timestamp when the run reached a terminal state. */
  readonly finishedAt: string | null;
  /** Identity of the harness that owns the run. */
  readonly harnessId: string;
  /** Provider-owned record identifier. */
  readonly id: string;
  /** ISO timestamp of the run's most recent heartbeat. */
  readonly lastHeartbeat: string;
  /** Agent-declared terminal outcome. */
  readonly outcome: string;
  /** Task status captured when resumable completion began. */
  readonly completionTaskStatus?: string;
  /** Run ID of the parent attempt, or null for a root. */
  readonly parentRunId: string | null;
  /** Run ID of the preceding terminated attempt, or null initially. */
  readonly restartOfRunId: string | null;
  /** Stable identifier shared by attempts in one retry chain. */
  readonly retryKey: string;
  /** Harness-supplied idempotency identifier for this run attempt. */
  readonly runId: string;
  /** ISO timestamp when the run attempt started. */
  readonly startedAt: string;
  /** Current lifecycle status of the record or process. */
  readonly status: ActiveAgentStatus;
  /** Provider record ID of the assigned Task. */
  readonly taskId: string;
  /** Provider version of this Active Agent record. */
  readonly version: string;
  /** Absolute configured command directory, or null for the host default. */
  readonly workingDirectory: string | null;
}

/** Provider-neutral projection of one keyed Error record. */
export interface ErrorRecord {
  /** Provider record ID of the related Active Agent, when one exists. */
  readonly activeAgentId: string | null;
  /** Provider record ID of the related Agent. */
  readonly agentId: string | null;
  /** Whether the provider record is archived. */
  readonly archived: boolean;
  /** Detailed human-readable explanation of the Error. */
  readonly description: string;
  /** Stable idempotency key for creating or reopening an Error. */
  readonly errorKey: string;
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Human-provided Error resolution text. */
  readonly resolution: string;
  /** Operational impact assigned to the Error. */
  readonly severity: ErrorSeverity;
  /** Origin classification of the Error or provider data. */
  readonly source: ErrorSource;
  /** Current lifecycle status of the record or process. */
  readonly status: ErrorStatus;
  /** Provider record ID of the assigned Task. */
  readonly taskId: string | null;
  /** Human-readable title of the record or command. */
  readonly title: string;
  /** Provider version used for optimistic consistency checks. */
  readonly version: string;
}

/** Agent fields intentionally exposed to the external execution harness. */
export type HarnessAgentContext = Pick<
  AgentRecord,
  | "allowedStatuses"
  | "allowedTaskTypes"
  | "id"
  | "key"
  | "model"
  | "name"
  | "notes"
  | "reasoning"
  | "taskDescription"
  | "transitions"
  | "version"
>;
/** Resource fields intentionally exposed to the external execution harness. */
export type HarnessResourceContext = Pick<
  ResourceRecord,
  "body" | "id" | "key" | "kind" | "state" | "version"
>;
/** Task fields intentionally exposed to the external execution harness. */
export type HarnessTaskContext = Pick<
  TaskRecord,
  | "body"
  | "dependencies"
  | "id"
  | "priority"
  | "status"
  | "title"
  | "type"
  | "version"
>;

/** Immutable Task, Agent, Resource, and run context returned at start. */
export interface ActiveAgentContext {
  /** Agent definition resolved for the current run. */
  readonly agent: HarnessAgentContext;
  /** Ordered Resources supplied as immutable Agent context. */
  readonly resources: readonly HarnessResourceContext[];
  /** Active Agent run included in the immutable execution context. */
  readonly run: ActiveAgentRecord;
  /** Mandatory run-bound instructions supplied as a system prompt. */
  readonly systemPrompt: string;
  /** Task included in the immutable Agent execution context. */
  readonly task: HarnessTaskContext;
}

/** Caller-supplied identity and hierarchy required to start a run. */
export interface StartActiveAgentInput {
  /** Stable Agent-definition key used for lookup. */
  readonly agentKey: string;
  /** Identity of the harness that owns the run. */
  readonly harnessId: string;
  /** Run ID of the parent run, or null for a root. */
  readonly parentRunId: string | null;
  /** Harness-supplied idempotency identity of the run attempt. */
  readonly runId: string;
  /** Provider record ID of the assigned Task. */
  readonly taskId: string;
}

/** Replacement run and harness identity for restarting a terminated run. */
export interface RestartActiveAgentInput {
  /** Run ID of the failed or stale attempt being replaced. */
  readonly restartOfRunId: string;
  /** Identity of the harness that owns the run. */
  readonly harnessId: string;
  /** Harness-supplied idempotency identity of the run attempt. */
  readonly runId: string;
}

/** Strict provider-neutral payload for creating or reopening a keyed Error. */
export interface ReportErrorInput {
  /** Provider record ID used for the optional Active Agent relation. */
  readonly activeAgentId: string | null;
  /** Provider record ID of the related Agent. */
  readonly agentId: string | null;
  /** Detailed human-readable explanation of the Error. */
  readonly description: string;
  /** Stable idempotency key for creating or reopening an Error. */
  readonly errorKey: string;
  /** Human-provided Error resolution text. */
  readonly resolution: string;
  /** Operational impact assigned to the Error. */
  readonly severity: ErrorSeverity;
  /** Origin classification of the Error or provider data. */
  readonly source: ErrorSource;
  /** Provider record ID of the assigned Task. */
  readonly taskId: string | null;
  /** Human-readable title of the record or command. */
  readonly title: string;
}
