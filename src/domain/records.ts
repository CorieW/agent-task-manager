/** Provider-neutral Task, Agent, Resource, run, and Error records. */
import type { JsonObject } from "./json.js";
import {
  parseAgentCommandPolicy,
  type AgentCommandPolicy,
} from "./commands.js";

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
  readonly calledBy: string;
  readonly commands: AgentCommandPolicy;
  readonly enabled: boolean;
  readonly id: string;
  readonly model: string;
  readonly notes: string;
  readonly reasoning: string;
  readonly resourceKeys: readonly string[];
  readonly transitions: AgentTransitions;
}

/** Provider-neutral projection of one Task record. */
export interface TaskRecord {
  readonly archived: boolean;
  readonly body: string;
  readonly dependencies: readonly string[];
  readonly id: string;
  readonly priority: number | null;
  readonly properties: JsonObject;
  readonly status: string;
  readonly title: string;
  readonly type: string;
  readonly version: string;
}

/** Provider-neutral projection of one Resource record. */
export interface ResourceRecord {
  readonly archived: boolean;
  readonly body: string;
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly properties: JsonObject;
  readonly state: ResourceState;
  readonly version: string;
}

/** Provider-neutral projection of one Agent record and resolved configuration. */
export interface AgentRecord {
  /** Task statuses from which this Agent may be assigned work. */
  readonly allowedStatuses: readonly string[];
  /** Task types on which this Agent may be assigned work. */
  readonly allowedTaskTypes: readonly string[];
  readonly archived: boolean;
  readonly body: string;
  readonly calledBy: string;
  readonly commands: AgentCommandPolicy;
  readonly enabled: boolean;
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Stable lookup key declared by the Agent definition. */
  readonly key: string;
  readonly model: string;
  readonly name: string;
  readonly notes: string;
  readonly properties: JsonObject;
  readonly reasoning: string;
  readonly resourceIds: readonly string[];
  /** Provider-supplied prior versions accepted only when rebasing a restart. */
  readonly restartCompatibleVersions?: readonly string[];
  readonly transitions: AgentTransitions;
  readonly version: string;
}

/** Provider-neutral projection of one Active Agent run record. */
export interface ActiveAgentRecord {
  readonly agentId: string;
  /** Agent record version captured when this run started. */
  readonly agentVersion: string;
  readonly archived: boolean;
  /** One-based attempt number within the retry chain. */
  readonly attempt: number;
  readonly failureSummary: string;
  readonly finishedAt: string | null;
  readonly harnessId: string;
  /** Provider-owned record identifier. */
  readonly id: string;
  readonly lastHeartbeat: string;
  readonly outcome: string;
  /** Run ID of the parent attempt, or null for a root. */
  readonly parentRunId: string | null;
  /** Run ID of the preceding terminated attempt, or null initially. */
  readonly restartOfRunId: string | null;
  /** Stable identifier shared by attempts in one retry chain. */
  readonly retryKey: string;
  /** Harness-supplied idempotency identifier for this run attempt. */
  readonly runId: string;
  readonly startedAt: string;
  readonly status: ActiveAgentStatus;
  readonly taskId: string;
  /** Provider version of this Active Agent record. */
  readonly version: string;
}

/** Provider-neutral projection of one keyed Error record. */
export interface ErrorRecord {
  readonly activeAgentId: string | null;
  readonly agentId: string | null;
  readonly archived: boolean;
  readonly description: string;
  readonly errorKey: string;
  readonly id: string;
  readonly resolution: string;
  readonly severity: ErrorSeverity;
  readonly source: ErrorSource;
  readonly status: ErrorStatus;
  readonly taskId: string | null;
  readonly title: string;
  readonly version: string;
}

/** Immutable Task, Agent, Resource, and run context returned at start. */
export interface ActiveAgentContext {
  readonly agent: AgentRecord;
  readonly resources: readonly ResourceRecord[];
  readonly run: ActiveAgentRecord;
  /** Mandatory run-bound instructions supplied as a system prompt. */
  readonly systemPrompt: string;
  readonly task: TaskRecord;
}

/** Caller-supplied identity and hierarchy required to start a run. */
export interface StartActiveAgentInput {
  readonly agentKey: string;
  readonly harnessId: string;
  readonly parentRunId: string | null;
  readonly runId: string;
  readonly taskId: string;
}

/** Replacement run and harness identity for restarting a terminated run. */
export interface RestartActiveAgentInput {
  /** Run ID of the failed or stale attempt being replaced. */
  readonly restartOfRunId: string;
  readonly harnessId: string;
  readonly runId: string;
}

/** Strict provider-neutral payload for creating or reopening a keyed Error. */
export interface ReportErrorInput {
  /** Provider record ID used for the optional Active Agent relation. */
  readonly activeAgentId: string | null;
  readonly agentId: string | null;
  readonly description: string;
  readonly errorKey: string;
  readonly resolution: string;
  readonly severity: ErrorSeverity;
  readonly source: ErrorSource;
  readonly taskId: string | null;
  readonly title: string;
}

/** Parses an exact Error report payload at an untyped boundary. */
/** Strictly parses the complete payload accepted by Error reporting. */
export function parseReportErrorInput(value: unknown): ReportErrorInput {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Error input must be a JSON object");
  const input = value as Record<string, unknown>;
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
  const unknown = Object.keys(input).filter((key) => !fields.includes(key));
  if (unknown.length !== 0)
    throw new TypeError(
      `Error input contains unsupported fields: ${unknown.join(", ")}`,
    );
  const text = (name: string, allowEmpty = false): string => {
    const field = input[name];
    if (typeof field !== "string" || (!allowEmpty && field.trim() === ""))
      throw new TypeError(`Error input ${name} must be a string`);
    return field.normalize("NFC");
  };
  const nullableId = (name: string): string | null => {
    const field = input[name];
    if (field === null) return null;
    if (typeof field !== "string" || field.trim() === "")
      throw new TypeError(`Error input ${name} must be a string or null`);
    return field.normalize("NFC");
  };
  const severity = input.severity;
  if (
    !(["critical", "high", "medium", "low"] as const).includes(
      severity as never,
    )
  )
    throw new TypeError("Error input severity is invalid");
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

/** Parses a compact arbitrary outcome-to-Task-status map. */
/** Parses a serialized outcome-to-status transition object. */
export function parseAgentTransitions(value: string): AgentTransitions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Agent Transitions must be valid JSON");
  }
  return validateAgentTransitions(parsed);
}

/** Validates and normalizes an already-decoded Agent transition map. */
/** Validates an already-decoded outcome-to-status transition object. */
export function validateAgentTransitions(value: unknown): AgentTransitions {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Agent Transitions must be an object");
  const entries = Object.entries(value);
  if (entries.length === 0)
    throw new TypeError("Agent Transitions must not be empty");
  const result: Record<string, string> = {};
  for (const [outcome, status] of entries) {
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

/** Locates the managed Agent-definition section and its JSON content. */
/** Locates the JSON fence governed by the `Agent definition` heading. */
export function agentDefinitionSection(markdown: string): {
  readonly content: string;
  readonly end: number;
  readonly start: number;
} | null {
  const match =
    /(^|\r?\n)## Agent definition[^\S\r\n]*\r?\n(?:[^\S\r\n]*\r?\n)*```json[^\S\r\n]*(?:\r?\n)?([\s\S]*?)```[^\S\r\n]*(?:\r?\n)?/u.exec(
      markdown,
    );
  if (match?.[2] === undefined) return null;
  const prefixLength = match[1]?.length ?? 0;
  return {
    content: match[2],
    end: match.index + match[0].length,
    start: match.index + prefixLength,
  };
}

/** Parses the authoritative JSON configuration from an Agent page body. */
/** Strictly parses an authoritative Agent definition from page Markdown. */
export function parseAgentDefinition(markdown: string): AgentDefinition {
  const section = agentDefinitionSection(markdown);
  if (section === null)
    throw new TypeError(
      "Agent page body must contain an '## Agent definition' JSON block",
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(section.content) as unknown;
  } catch {
    throw new TypeError("Agent definition must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Agent definition must be an object");

  const definition = parsed as Record<string, unknown>;
  const schema = definition.schema;
  if (
    schema !== "agent-definition-v1" &&
    schema !== "agent-definition-v2" &&
    schema !== "agent-definition-v3"
  )
    throw new TypeError(
      "Agent definition schema must equal agent-definition-v1, agent-definition-v2, or agent-definition-v3",
    );
  rejectUnknownDefinitionFields(definition, schema);
  const promptResources = definitionStrings(
    definition.promptResources,
    "promptResources",
  );
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
  const policyResources = inputResourceSelectors.filter((key) =>
    key.startsWith("policy/"),
  );
  if (policyResources.length === 0)
    throw new TypeError(
      "Agent definition inputResourceSelectors must contain a policy/* key",
    );
  if (typeof definition.enabled !== "boolean")
    throw new TypeError("Agent definition enabled must be a boolean");

  return {
    allowedStatuses:
      schema === "agent-definition-v3"
        ? definitionStringSet(definition.allowedStatuses, "allowedStatuses")
        : [],
    allowedTaskTypes:
      schema === "agent-definition-v3"
        ? definitionStringSet(definition.allowedTaskTypes, "allowedTaskTypes")
        : [],
    calledBy: optionalDefinitionText(definition.calledBy, "calledBy"),
    commands:
      schema === "agent-definition-v1"
        ? { inclusion: [] }
        : parseAgentCommandPolicy(definition.commands),
    enabled: definition.enabled,
    id: definitionText(definition.id, "id"),
    model: definitionText(definition.model, "model"),
    notes: optionalDefinitionText(definition.notes, "notes"),
    reasoning: definitionText(definition.reasoning, "reasoning"),
    resourceKeys: [...new Set([...promptResources, ...policyResources])],
    transitions: validateAgentTransitions(definition.transitions),
  };
}

function rejectUnknownDefinitionFields(
  definition: Readonly<Record<string, unknown>>,
  schema: "agent-definition-v1" | "agent-definition-v2" | "agent-definition-v3",
): void {
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
    ...(schema === "agent-definition-v1" ? [] : ["commands"]),
    ...(schema === "agent-definition-v3"
      ? ["allowedStatuses", "allowedTaskTypes"]
      : []),
  ]);
  const unknown = Object.keys(definition).filter((key) => !supported.has(key));
  if (unknown.length !== 0)
    throw new TypeError(
      `Agent definition contains unsupported fields: ${unknown.join(", ")}`,
    );
}

function definitionText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new TypeError(`Agent definition ${name} must be a non-empty string`);
  return value.normalize("NFC");
}

function optionalDefinitionText(value: unknown, name: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string")
    throw new TypeError(`Agent definition ${name} must be a string`);
  return value.normalize("NFC");
}

function definitionStrings(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new TypeError(`Agent definition ${name} must be a string array`);
  return value.map((entry) => entry.normalize("NFC"));
}

function definitionStringSet(value: unknown, name: string): readonly string[] {
  const entries = definitionStrings(value, name);
  if (entries.some((entry) => entry.trim() === ""))
    throw new TypeError(
      `Agent definition ${name} must not contain empty values`,
    );
  if (new Set(entries).size !== entries.length)
    throw new TypeError(`Agent definition ${name} must not contain duplicates`);
  return entries;
}
