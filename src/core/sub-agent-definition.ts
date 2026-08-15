// Parses and validates provider-owned Sub-agent definitions without role-name logic.
import type { JsonObject, JsonValue } from "../domain/json.js";
import type {
  InvocationPolicy,
  RetryPolicy,
  SelectionPolicy,
  SubAgentDefinition,
} from "../domain/records.js";

const DEFINITION_KEYS = [
  "allowedIntents", "capabilities", "contextBudgetBytes", "deadlineSeconds", "enabled", "id",
  "inputResourceSelectors", "invocation", "maxAssignmentDepth", "maxAssignmentsPerRun", "maxConcurrency",
  "model", "name", "outputSchema", "priority", "prohibitedCapabilities", "promptResources", "reasoning",
  "requiredProviderCapabilities", "retry", "revision", "runnerProfile", "schema", "selection", "transitions",
] as const;

export interface DefinitionValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export function parseSubAgentDefinitionManifest(
  value: JsonObject,
): SubAgentDefinition {
  assertExactKeys(value, DEFINITION_KEYS, "Sub-agent definition");
  const definition: SubAgentDefinition = {
    allowedIntents: uniqueStrings(value.allowedIntents, "allowedIntents"),
    capabilities: uniqueStrings(value.capabilities, "capabilities"),
    maxConcurrency: positiveInteger(value.maxConcurrency, "maxConcurrency"),
    maxAssignmentsPerRun: positiveInteger(value.maxAssignmentsPerRun, "maxAssignmentsPerRun"),
    contextBudgetBytes: positiveInteger(value.contextBudgetBytes, "contextBudgetBytes"),
    deadlineSeconds: positiveInteger(value.deadlineSeconds, "deadlineSeconds"),
    enabled: booleanValue(value.enabled, "enabled"),
    id: requiredString(value.id, "id"),
    inputResourceSelectors: uniqueStrings(value.inputResourceSelectors, "inputResourceSelectors"),
    invocation: parseInvocation(objectValue(value.invocation, "invocation")),
    priority: integer(value.priority, "priority"),
    maxAssignmentDepth: nonNegativeInteger(value.maxAssignmentDepth, "maxAssignmentDepth"),
    model: requiredString(value.model, "model"),
    name: requiredString(value.name, "name"),
    outputSchema: requiredString(value.outputSchema, "outputSchema"),
    prohibitedCapabilities: uniqueStrings(value.prohibitedCapabilities, "prohibitedCapabilities"),
    promptResources: uniqueStrings(value.promptResources, "promptResources"),
    reasoning: requiredString(value.reasoning, "reasoning"),
    requiredProviderCapabilities: uniqueStrings(value.requiredProviderCapabilities, "requiredProviderCapabilities"),
    retry: parseRetry(objectValue(value.retry, "retry")),
    revision: positiveInteger(value.revision, "revision"),
    runnerProfile: requiredString(value.runnerProfile, "runnerProfile"),
    schema: schemaValue(value.schema),
    selection: parseSelection(objectValue(value.selection, "selection")),
    transitions: stringMap(objectValue(value.transitions, "transitions"), "transitions"),
  };
  const issues = validateSubAgentDefinition(definition);
  if (issues.length > 0) throw new TypeError(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  return definition;
}

export function validateSubAgentDefinition(
  definition: SubAgentDefinition,
): readonly DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];
  const capabilitySet = new Set(definition.capabilities);
  for (const capability of definition.prohibitedCapabilities) {
    if (capabilitySet.has(capability)) issues.push(issue("capability_conflict", `Capability ${capability} is both granted and prohibited`, "prohibitedCapabilities"));
  }
  if (definition.selection.mode === "coordinator" && !capabilitySet.has("dispatch.coordinate")) {
    issues.push(issue("coordinator_capability_missing", "Coordinator selection requires dispatch.coordinate", "capabilities"));
  }
  if (definition.selection.mode === "self") {
    if (!definition.selection.acceptsAssignmentsFrom.includes("self")) issues.push(issue("self_assignment_rejected", "Self selection must accept self assignments", "selection.acceptsAssignmentsFrom"));
    if (definition.selection.taskQueryResource === null) issues.push(issue("self_query_missing", "Self selection requires a task query Resource", "selection.taskQueryResource"));
  }
  if (definition.selection.mode === "coordinator" && definition.selection.taskQueryResource === null) {
    issues.push(issue("coordinator_query_missing", "Coordinator selection requires a task query Resource", "selection.taskQueryResource"));
  }
  if (definition.invocation.mode === "scheduled" && definition.invocation.scheduleResource === null) {
    issues.push(issue("schedule_missing", "Scheduled invocation requires a schedule Resource", "invocation.scheduleResource"));
  }
  if (definition.invocation.mode !== "scheduled" && definition.invocation.scheduleResource !== null) {
    issues.push(issue("schedule_unexpected", "Only scheduled invocation may reference a schedule Resource", "invocation.scheduleResource"));
  }
  if (definition.selection.maxCandidateSummaries > 100) issues.push(issue("candidate_limit_too_large", "Candidate summary limit cannot exceed 100", "selection.maxCandidateSummaries"));
  if (definition.contextBudgetBytes > 10_000_000) issues.push(issue("context_budget_too_large", "Context budget cannot exceed 10000000 bytes", "contextBudgetBytes"));
  if (definition.deadlineSeconds > 86_400) issues.push(issue("deadline_too_large", "Deadline cannot exceed 86400 seconds", "deadlineSeconds"));
  if (Object.keys(definition.transitions).length === 0) issues.push(issue("transitions_missing", "At least one outcome transition is required", "transitions"));
  return issues;
}

export function validateDefinitionSet(
  definitions: readonly SubAgentDefinition[],
): readonly DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];
  const identities = new Map<string, number>();
  for (const definition of definitions) {
    issues.push(...validateSubAgentDefinition(definition).map((entry) => ({ ...entry, path: `${definition.id}.${entry.path}` })));
    const prior = identities.get(definition.id);
    if (prior !== undefined) issues.push(issue("duplicate_definition", `Definition ID repeats revisions ${prior} and ${definition.revision}`, definition.id));
    else identities.set(definition.id, definition.revision);
  }
  return issues;
}

function parseInvocation(value: JsonObject): InvocationPolicy {
  assertExactKeys(value, ["mode", "scheduleResource"], "invocation");
  if (value.mode !== "event" && value.mode !== "manual" && value.mode !== "scheduled") throw new TypeError("invocation.mode is invalid");
  return {
    mode: value.mode,
    scheduleResource: value.scheduleResource === null ? null : requiredString(value.scheduleResource, "invocation.scheduleResource"),
  };
}

function parseSelection(value: JsonObject): SelectionPolicy {
  assertExactKeys(value, ["acceptsAssignmentsFrom", "maxCandidateSummaries", "mode", "resultSchema", "taskQueryResource"], "selection");
  if (value.mode !== "coordinator" && value.mode !== "explicit" && value.mode !== "self") throw new TypeError("selection.mode is invalid");
  const sources = uniqueStrings(value.acceptsAssignmentsFrom, "selection.acceptsAssignmentsFrom");
  if (sources.some((source) => source !== "coordinator" && source !== "explicit" && source !== "self")) throw new TypeError("selection.acceptsAssignmentsFrom contains an invalid source");
  return {
    acceptsAssignmentsFrom: sources as SelectionPolicy["acceptsAssignmentsFrom"],
    maxCandidateSummaries: positiveInteger(value.maxCandidateSummaries, "selection.maxCandidateSummaries"),
    mode: value.mode,
    resultSchema: requiredString(value.resultSchema, "selection.resultSchema"),
    taskQueryResource: value.taskQueryResource === null ? null : requiredString(value.taskQueryResource, "selection.taskQueryResource"),
  };
}

function parseRetry(value: JsonObject): RetryPolicy {
  assertExactKeys(value, ["maxAttempts", "noVerdict"], "retry");
  if (value.noVerdict !== "block" && value.noVerdict !== "retry") throw new TypeError("retry.noVerdict is invalid");
  return { maxAttempts: positiveInteger(value.maxAttempts, "retry.maxAttempts"), noVerdict: value.noVerdict };
}

function issue(code: string, message: string, path: string): DefinitionValidationIssue { return { code, message, path }; }
function assertExactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) throw new TypeError(`${label} has unexpected or missing fields`);
}
function uniqueStrings(value: JsonValue | undefined, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) throw new TypeError(`${label} must contain non-empty strings`);
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) throw new TypeError(`${label} contains duplicates`);
  return [...strings];
}
function stringMap(value: JsonObject, label: string): Readonly<Record<string, string>> {
  for (const [key, item] of Object.entries(value)) if (key === "" || typeof item !== "string" || item === "") throw new TypeError(`${label} must map non-empty strings`);
  return { ...value } as Readonly<Record<string, string>>;
}
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError(`${label} must be an integer`);
  return value;
}
function positiveInteger(value: JsonValue | undefined, label: string): number {
  const result = integer(value, label);
  if (result < 1) throw new TypeError(`${label} must be positive`);
  return result;
}
function nonNegativeInteger(value: JsonValue | undefined, label: string): number {
  const result = integer(value, label);
  if (result < 0) throw new TypeError(`${label} must be non-negative`);
  return result;
}
function booleanValue(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}
function schemaValue(value: JsonValue | undefined): "sub-agent-definition-v1" {
  if (value !== "sub-agent-definition-v1") throw new TypeError("Sub-agent definition schema is invalid");
  return value;
}
