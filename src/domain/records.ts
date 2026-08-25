/** Provider-neutral Task, Agent, Resource, run, and Error records. */
import type { JsonObject } from "./json.js";
import {
  parseAgentCommandPolicy,
  type AgentCommandPolicy,
} from "./commands.js";
import {
  parseAgentLifecycleConfig,
  type AgentLifecycleConfig,
} from "./lifecycle.js";
import {
  parseAgentTaskDescriptionConfig,
  type AgentTaskDescriptionConfig,
} from "./task-description.js";

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

/** Strictly parses the complete payload accepted by Error reporting. */
export function parseReportErrorInput(value: unknown): ReportErrorInput {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Error input must be a JSON object");
  /** Validated input for the current boundary operation. */
  const input = value as Record<string, unknown>;
  /** Complete allowlist of accepted input field names. */
  const fields = [
    "activeAgentId",
    "agentId",
    "description",
    "errorKey",
    "resolution",
    "severity",
    "source",
    "taskId",
    "title",
  ];
  /** Unsupported keys discovered at the strict input boundary. */
  const unknown = Object.keys(input).filter((key) => !fields.includes(key));
  if (unknown.length !== 0)
    throw new TypeError(
      `Error input contains unsupported fields: ${unknown.join(", ")}`,
    );
  /** Normalized text field reader for the strict input boundary. */
  const text = (name: string, allowEmpty = false): string => {
    /** Untyped input field currently being validated. */
    const field = input[name];
    if (typeof field !== "string" || (!allowEmpty && field.trim() === ""))
      throw new TypeError(`Error input ${name} must be a string`);
    return field.normalize("NFC");
  };
  /** Strict reader for nullable provider identifiers. */
  const nullableId = (name: string): string | null => {
    /** Untyped input field currently being validated. */
    const field = input[name];
    if (field === null) return null;
    if (typeof field !== "string" || field.trim() === "")
      throw new TypeError(`Error input ${name} must be a string or null`);
    return field.normalize("NFC");
  };
  /** Operational impact assigned to the Error. */
  const severity = input.severity;
  if (
    !(["critical", "high", "medium", "low"] as const).includes(
      severity as never,
    )
  )
    throw new TypeError("Error input severity is invalid");
  /** Untrusted Error-source discriminator. */
  const source = input.source;
  if (!(["human", "ai", "system"] as const).includes(source as never))
    throw new TypeError("Error input source is invalid");
  return {
    activeAgentId: nullableId("activeAgentId"),
    agentId: nullableId("agentId"),
    description: text("description"),
    errorKey: text("errorKey"),
    resolution: text("resolution", true),
    severity: severity as ErrorSeverity,
    source: source as ErrorSource,
    taskId: nullableId("taskId"),
    title: text("title"),
  };
}

/** Parses a serialized outcome-to-status transition object. */
export function parseAgentTransitions(value: string): AgentTransitions {
  /** Untyped serialized input after JSON or argument parsing. */
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Agent Transitions must be valid JSON");
  }
  return validateAgentTransitions(parsed);
}

/** Validates an already-decoded outcome-to-status transition object. */
export function validateAgentTransitions(value: unknown): AgentTransitions {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Agent Transitions must be an object");
  /** Ordered entries being validated or transformed. */
  const entries = Object.entries(value);
  if (entries.length === 0)
    throw new TypeError("Agent Transitions must not be empty");
  /** Normalized outcome-to-status map after closed-shape validation. */
  const result: Record<string, string> = {};
  for (const [outcome, status] of entries) {
    /** NFC-normalized value used for equality and validation. */
    const normalized = outcome.normalize("NFC");
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(normalized))
      throw new TypeError(`Invalid Agent outcome: ${outcome}`);
    if (typeof status !== "string" || status.trim() === "")
      throw new TypeError(`Invalid Task status for outcome ${outcome}`);
    if (Object.hasOwn(result, normalized))
      throw new TypeError(`Duplicate normalized Agent outcome: ${outcome}`);
    result[normalized] = status.normalize("NFC");
  }
  return result;
}

/** Locates the JSON fence governed by the `Agent definition` heading. */
export function agentDefinitionSection(markdown: string): {
  /** Raw JSON inside the managed fenced block. */
  readonly content: string;
  /** Exclusive end offset of the matched Markdown region. */
  readonly end: number;
  /** Start offset of the managed heading, excluding a leading newline. */
  readonly start: number;
} | null {
  /** Single validated match selected after uniqueness checks. */
  const match =
    /(^|\r?\n)## Agent definition[^\S\r\n]*\r?\n(?:[^\S\r\n]*\r?\n)*```json[^\S\r\n]*(?:\r?\n)?([\s\S]*?)```[^\S\r\n]*(?:\r?\n)?/u.exec(
      markdown,
    );
  if (match?.[2] === undefined) return null;
  /** Leading newline length excluded from the managed section offset. */
  const prefixLength = match[1]?.length ?? 0;
  return {
    content: match[2],
    end: match.index + match[0].length,
    start: match.index + prefixLength,
  };
}

/** Strictly parses an authoritative Agent definition from page Markdown. */
export function parseAgentDefinition(markdown: string): AgentDefinition {
  /** Managed Markdown section located by its exact heading. */
  const section = agentDefinitionSection(markdown);
  if (section === null)
    throw new TypeError(
      "Agent page body must contain an '## Agent definition' JSON block",
    );

  /** Untyped serialized input after JSON or argument parsing. */
  let parsed: unknown;
  try {
    parsed = JSON.parse(section.content) as unknown;
  } catch {
    throw new TypeError("Agent definition must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Agent definition must be an object");

  /** Strict Agent definition parsed from authoritative Markdown. */
  const definition = parsed as Record<string, unknown>;
  /** Versioned schema identifier for the serialized object. */
  const schema = definition.schema;
  if (schema !== "agent-definition-v1")
    throw new TypeError(
      "Agent definition schema must equal agent-definition-v1",
    );
  rejectUnknownDefinitionFields(definition);
  /** Prompt Resources selected by the Agent definition. */
  const promptResources = definitionStrings(
    definition.promptResources,
    "promptResources",
  );
  /** Additional Resource selectors granted to the Agent. */
  const inputResourceSelectors = definitionStrings(
    definition.inputResourceSelectors,
    "inputResourceSelectors",
  );
  if (
    promptResources.length === 0 ||
    promptResources.some((key) => !key.startsWith("prompt/"))
  )
    throw new TypeError(
      "Agent definition promptResources must contain prompt/* keys",
    );
  if (typeof definition.enabled !== "boolean")
    throw new TypeError("Agent definition enabled must be a boolean");

  /** Mapping from Agent outcomes to destination Task statuses. */
  const transitions = validateAgentTransitions(definition.transitions);
  return {
    allowedStatuses: definitionStringSet(
      definition.allowedStatuses,
      "allowedStatuses",
    ),
    allowedTaskTypes: definitionStringSet(
      definition.allowedTaskTypes,
      "allowedTaskTypes",
    ),
    calledBy: optionalDefinitionText(definition.calledBy, "calledBy"),
    commands: parseAgentCommandPolicy(definition.commands),
    enabled: definition.enabled,
    id: definitionText(definition.id, "id"),
    lifecycleCommands: parseAgentLifecycleConfig(definition.lifecycleCommands),
    model: definitionText(definition.model, "model"),
    notes: optionalDefinitionText(definition.notes, "notes"),
    reasoning: definitionText(definition.reasoning, "reasoning"),
    resourceKeys: [...new Set([...promptResources, ...inputResourceSelectors])],
    taskDescription: parseAgentTaskDescriptionConfig(
      definition.taskDescription,
      transitions,
    ),
    transitions,
  };
}

/** Rejects unsupported Agent-definition fields. */
function rejectUnknownDefinitionFields(
  definition: Readonly<Record<string, unknown>>,
): void {
  /** Distinct values tracked by reject unknown definition fields. */
  const supported = new Set([
    "calledBy",
    "enabled",
    "id",
    "inputResourceSelectors",
    "model",
    "notes",
    "promptResources",
    "reasoning",
    "schema",
    "transitions",
    "commands",
    "allowedStatuses",
    "allowedTaskTypes",
    "lifecycleCommands",
    "taskDescription",
  ]);
  /** Unsupported keys discovered at the strict input boundary. */
  const unknown = Object.keys(definition).filter((key) => !supported.has(key));
  if (unknown.length !== 0)
    throw new TypeError(
      `Agent definition contains unsupported fields: ${unknown.join(", ")}`,
    );
}

/** Requires and NFC-normalizes a non-empty Agent-definition string. */
function definitionText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new TypeError(`Agent definition ${name} must be a non-empty string`);
  return value.normalize("NFC");
}

/** Parses an optional NFC-normalized Agent-definition string. */
function optionalDefinitionText(value: unknown, name: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string")
    throw new TypeError(`Agent definition ${name} must be a string`);
  return value.normalize("NFC");
}

/** Parses and NFC-normalizes an Agent-definition string array. */
function definitionStrings(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new TypeError(`Agent definition ${name} must be a string array`);
  return value.map((entry) => entry.normalize("NFC"));
}

/** Parses a normalized, non-empty, duplicate-free string list. */
function definitionStringSet(value: unknown, name: string): readonly string[] {
  /** Ordered entries being validated or transformed. */
  const entries = definitionStrings(value, name);
  if (entries.some((entry) => entry.trim() === ""))
    throw new TypeError(
      `Agent definition ${name} must not contain empty values`,
    );
  if (new Set(entries).size !== entries.length)
    throw new TypeError(`Agent definition ${name} must not contain duplicates`);
  return entries;
}
