/** Parsing for authoritative Agent definitions embedded in Markdown. */
import { parseAgentCommandPolicy } from "../commands.js";
import { parseAgentLifecycleConfig } from "../lifecycle.js";
import { parseAgentTaskDescriptionConfig } from "../task-description.js";
import type { AgentDefinition, AgentTransitions } from "./record-types.js";

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

/** Strictly parses an authoritative Agent definition from record Markdown. */
export function parseAgentDefinition(markdown: string): AgentDefinition {
  /** Managed Markdown section located by its exact heading. */
  const section = agentDefinitionSection(markdown);
  if (section === null)
    throw new TypeError(
      "Agent body must contain an '## Agent definition' JSON block",
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
