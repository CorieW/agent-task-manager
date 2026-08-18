/** Provider-neutral records for the simplified coordination model. */
import type { JsonObject } from "./json.js";

export type ResourceState = "active" | "draft" | "retired";
export type ActiveAgentStatus =
  "running" | "failed" | "stale" | "completed" | "stopped";
export type ErrorSource = "human" | "ai" | "system";
export type ErrorStatus = "open" | "resolved";
export type ErrorSeverity = "critical" | "high" | "medium" | "low";
export type AgentTransitions = Readonly<Record<string, string>>;

export interface AgentDefinition {
  readonly calledBy: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly model: string;
  readonly notes: string;
  readonly reasoning: string;
  readonly resourceKeys: readonly string[];
  readonly transitions: AgentTransitions;
}

export interface TaskRecord {
  readonly archived: boolean;
  readonly body: string;
  readonly dependencies: readonly string[];
  readonly id: string;
  readonly priority: number | null;
  readonly properties: JsonObject;
  readonly status: string;
  readonly title: string;
  readonly version: string;
}

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

export interface AgentRecord {
  readonly archived: boolean;
  readonly body: string;
  readonly calledBy: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly key: string;
  readonly model: string;
  readonly name: string;
  readonly notes: string;
  readonly properties: JsonObject;
  readonly reasoning: string;
  readonly resourceIds: readonly string[];
  readonly transitions: AgentTransitions;
  readonly version: string;
}

export interface ActiveAgentRecord {
  readonly agentId: string;
  readonly agentVersion: string;
  readonly archived: boolean;
  readonly attempt: number;
  readonly failureSummary: string;
  readonly finishedAt: string | null;
  readonly harnessId: string;
  readonly id: string;
  readonly lastHeartbeat: string;
  readonly outcome: string;
  readonly parentRunId: string | null;
  readonly restartOfRunId: string | null;
  readonly retryKey: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly status: ActiveAgentStatus;
  readonly taskId: string;
  readonly version: string;
}

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

export interface ActiveAgentContext {
  readonly agent: AgentRecord;
  readonly resources: readonly ResourceRecord[];
  readonly run: ActiveAgentRecord;
  readonly task: TaskRecord;
}

export interface StartActiveAgentInput {
  readonly agentKey: string;
  readonly harnessId: string;
  readonly parentRunId: string | null;
  readonly runId: string;
  readonly taskId: string;
}

export interface RestartActiveAgentInput {
  readonly failedRunId: string;
  readonly harnessId: string;
  readonly runId: string;
}

export interface ReportErrorInput {
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
export function parseAgentTransitions(value: string): AgentTransitions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Agent Transitions must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Agent Transitions must be an object");
  const entries = Object.entries(parsed);
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

/** Parses the authoritative JSON configuration from an Agent page body. */
export function parseAgentDefinition(markdown: string): AgentDefinition {
  const match =
    /(?:^|\n)## Agent definition\s*\n+```json\s*\n?([\s\S]*?)```/u.exec(
      markdown,
    );
  if (match?.[1] === undefined)
    throw new TypeError(
      "Agent page body must contain an '## Agent definition' JSON block",
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]) as unknown;
  } catch {
    throw new TypeError("Agent definition must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Agent definition must be an object");

  const definition = parsed as Record<string, unknown>;
  rejectUnknownDefinitionFields(definition);
  if (definition.schema !== "agent-definition-v1")
    throw new TypeError(
      "Agent definition schema must equal agent-definition-v1",
    );
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
    calledBy: optionalDefinitionText(definition.calledBy, "calledBy"),
    enabled: definition.enabled,
    id: definitionText(definition.id, "id"),
    model: definitionText(definition.model, "model"),
    notes: optionalDefinitionText(definition.notes, "notes"),
    reasoning: definitionText(definition.reasoning, "reasoning"),
    resourceKeys: [...new Set([...promptResources, ...policyResources])],
    transitions: parseAgentTransitions(JSON.stringify(definition.transitions)),
  };
}

function rejectUnknownDefinitionFields(
  definition: Readonly<Record<string, unknown>>,
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
