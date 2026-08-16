/** Parses and validates provider-owned Agent definitions without role-name logic. */
import type { JsonObject, JsonValue } from "../domain/json.js";
import type {
  InvocationPolicy,
  RetryPolicy,
  SelectionPolicy,
  AgentDefinition,
} from "../domain/records.js";

/** Exact top-level fields allowed in a definition manifest. */
const DEFINITION_KEYS = [
  "allowedIntents",
  "capabilities",
  "contextBudgetBytes",
  "deadlineSeconds",
  "enabled",
  "id",
  "humanResolutionOutcomes",
  "inputResourceSelectors",
  "invocation",
  "maxAssignmentDepth",
  "maxAssignmentsPerRun",
  "maxConcurrency",
  "model",
  "name",
  "outputSchema",
  "priority",
  "prohibitedCapabilities",
  "promptResources",
  "reasoning",
  "requiredProviderCapabilities",
  "retry",
  "revision",
  "runnerProfile",
  "schema",
  "selection",
  "transitions",
] as const;

/** Optional top-level fields supported by the definition manifest. */
const OPTIONAL_DEFINITION_KEYS = ["requiredIntentSequenceByOutcome"] as const;

/** Structured issue detected while validating definition validation. */
export interface DefinitionValidationIssue {
  /** Code for definition validation issue. */
  readonly code: string;
  /** Message for definition validation issue. */
  readonly message: string;
  /** Path for definition validation issue. */
  readonly path: string;
}

/** Parses a serialized agent definition and rejects invalid manifests. */
export function parseAgentDefinitionManifest(
  value: JsonObject,
): AgentDefinition {
  const schema = schemaValue(value.schema);
  assertKeys(
    value,
    DEFINITION_KEYS,
    OPTIONAL_DEFINITION_KEYS,
    "Agent definition",
  );
  /** Definition used during parse agent definition manifest. */
  const definition: AgentDefinition = {
    allowedIntents: uniqueStrings(value.allowedIntents, "allowedIntents"),
    capabilities: uniqueStrings(value.capabilities, "capabilities"),
    maxConcurrency: positiveInteger(value.maxConcurrency, "maxConcurrency"),
    maxAssignmentsPerRun: positiveInteger(
      value.maxAssignmentsPerRun,
      "maxAssignmentsPerRun",
    ),
    contextBudgetBytes: positiveInteger(
      value.contextBudgetBytes,
      "contextBudgetBytes",
    ),
    deadlineSeconds: positiveInteger(value.deadlineSeconds, "deadlineSeconds"),
    enabled: booleanValue(value.enabled, "enabled"),
    id: requiredString(value.id, "id"),
    humanResolutionOutcomes: uniqueStrings(
      value.humanResolutionOutcomes,
      "humanResolutionOutcomes",
    ),
    inputResourceSelectors: uniqueStrings(
      value.inputResourceSelectors,
      "inputResourceSelectors",
    ),
    invocation: parseInvocation(objectValue(value.invocation, "invocation")),
    priority: integer(value.priority, "priority"),
    maxAssignmentDepth: nonNegativeInteger(
      value.maxAssignmentDepth,
      "maxAssignmentDepth",
    ),
    model: requiredString(value.model, "model"),
    name: requiredString(value.name, "name"),
    outputSchema: requiredString(value.outputSchema, "outputSchema"),
    prohibitedCapabilities: uniqueStrings(
      value.prohibitedCapabilities,
      "prohibitedCapabilities",
    ),
    promptResources: uniqueStrings(value.promptResources, "promptResources"),
    reasoning: requiredString(value.reasoning, "reasoning"),
    requiredProviderCapabilities: uniqueStrings(
      value.requiredProviderCapabilities,
      "requiredProviderCapabilities",
    ),
    ...(value.requiredIntentSequenceByOutcome === undefined
      ? {}
      : {
          requiredIntentSequenceByOutcome: stringArrayMap(
            objectValue(
              value.requiredIntentSequenceByOutcome,
              "requiredIntentSequenceByOutcome",
            ),
            "requiredIntentSequenceByOutcome",
          ),
        }),
    retry: parseRetry(objectValue(value.retry, "retry")),
    revision: positiveInteger(value.revision, "revision"),
    runnerProfile: requiredString(value.runnerProfile, "runnerProfile"),
    schema,
    selection: parseSelection(objectValue(value.selection, "selection")),
    transitions: stringMap(
      objectValue(value.transitions, "transitions"),
      "transitions",
    ),
  };
  /** Validation issues collected during this operation. */
  const issues = validateAgentDefinition(definition);
  if (issues.length > 0)
    throw new TypeError(
      issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
    );
  return definition;
}

/** Returns policy and capability violations in one agent definition. */
export function validateAgentDefinition(
  definition: AgentDefinition,
): readonly DefinitionValidationIssue[] {
  /** Validation issues collected during this operation. */
  const issues: DefinitionValidationIssue[] = [];
  /** Distinct capability set tracked during validate agent definition. */
  const capabilitySet = new Set(definition.capabilities);
  for (const capability of definition.prohibitedCapabilities) {
    if (capabilitySet.has(capability))
      issues.push(
        issue(
          "capability_conflict",
          `Capability ${capability} is both granted and prohibited`,
          "prohibitedCapabilities",
        ),
      );
  }
  if (
    definition.selection.mode === "coordinator" &&
    !capabilitySet.has("dispatch.coordinate")
  ) {
    issues.push(
      issue(
        "coordinator_capability_missing",
        "Coordinator selection requires dispatch.coordinate",
        "capabilities",
      ),
    );
  }
  if (definition.selection.mode === "self") {
    if (!definition.selection.acceptsAssignmentsFrom.includes("self"))
      issues.push(
        issue(
          "self_assignment_rejected",
          "Self selection must accept self assignments",
          "selection.acceptsAssignmentsFrom",
        ),
      );
    if (definition.selection.taskQueryResource === null)
      issues.push(
        issue(
          "self_query_missing",
          "Self selection requires a task query Resource",
          "selection.taskQueryResource",
        ),
      );
  }
  if (
    definition.selection.mode === "coordinator" &&
    definition.selection.taskQueryResource === null
  ) {
    issues.push(
      issue(
        "coordinator_query_missing",
        "Coordinator selection requires a task query Resource",
        "selection.taskQueryResource",
      ),
    );
  }
  if (
    definition.invocation.mode === "scheduled" &&
    definition.invocation.scheduleResource === null
  ) {
    issues.push(
      issue(
        "schedule_missing",
        "Scheduled invocation requires a schedule Resource",
        "invocation.scheduleResource",
      ),
    );
  }
  if (
    definition.invocation.mode !== "scheduled" &&
    definition.invocation.scheduleResource !== null
  ) {
    issues.push(
      issue(
        "schedule_unexpected",
        "Only scheduled invocation may reference a schedule Resource",
        "invocation.scheduleResource",
      ),
    );
  }
  if (definition.selection.maxCandidateSummaries > 100)
    issues.push(
      issue(
        "candidate_limit_too_large",
        "Candidate summary limit cannot exceed 100",
        "selection.maxCandidateSummaries",
      ),
    );
  if (definition.contextBudgetBytes > 10_000_000)
    issues.push(
      issue(
        "context_budget_too_large",
        "Context budget cannot exceed 10000000 bytes",
        "contextBudgetBytes",
      ),
    );
  if (definition.deadlineSeconds > 86_400)
    issues.push(
      issue(
        "deadline_too_large",
        "Deadline cannot exceed 86400 seconds",
        "deadlineSeconds",
      ),
    );
  if (definition.retry.maxAttempts > 5)
    issues.push(
      issue(
        "retry_limit_too_large",
        "Retry attempts cannot exceed 5",
        "retry.maxAttempts",
      ),
    );
  if (Object.keys(definition.transitions).length === 0)
    issues.push(
      issue(
        "transitions_missing",
        "At least one outcome transition is required",
        "transitions",
      ),
    );
  for (const outcome of definition.humanResolutionOutcomes) {
    if (!Object.hasOwn(definition.transitions, outcome))
      issues.push(
        issue(
          "human_resolution_transition_missing",
          `Human-resolution outcome ${outcome} has no transition`,
          "humanResolutionOutcomes",
        ),
      );
  }
  for (const [outcome, sequence] of Object.entries(
    definition.requiredIntentSequenceByOutcome ?? {},
  )) {
    if (!Object.hasOwn(definition.transitions, outcome))
      issues.push(
        issue(
          "required_intent_outcome_missing",
          `Required intent sequence outcome ${outcome} has no transition`,
          `requiredIntentSequenceByOutcome.${outcome}`,
        ),
      );
    for (const intent of sequence)
      if (!definition.allowedIntents.includes(intent))
        issues.push(
          issue(
            "required_intent_not_allowed",
            `Required intent ${intent} is not allowed`,
            `requiredIntentSequenceByOutcome.${outcome}`,
          ),
        );
  }
  return issues;
}

/** Returns validation issues for a definition set, including duplicate IDs. */
export function validateDefinitionSet(
  definitions: readonly AgentDefinition[],
): readonly DefinitionValidationIssue[] {
  /** Validation issues collected during this operation. */
  const issues: DefinitionValidationIssue[] = [];
  /** Identities indexed for lookup during validate definition set. */
  const identities = new Map<string, number>();
  for (const definition of definitions) {
    issues.push(
      ...validateAgentDefinition(definition).map((entry) => ({
        ...entry,
        path: `${definition.id}.${entry.path}`,
      })),
    );
    /** Prior used during validate definition set. */
    const prior = identities.get(definition.id);
    if (prior !== undefined)
      issues.push(
        issue(
          "duplicate_definition",
          `Definition ID repeats revisions ${prior} and ${definition.revision}`,
          definition.id,
        ),
      );
    else identities.set(definition.id, definition.revision);
  }
  return issues;
}

/** Parses a agent invocation policy. */
function parseInvocation(value: JsonObject): InvocationPolicy {
  assertExactKeys(value, ["mode", "scheduleResource"], "invocation");
  if (
    value.mode !== "event" &&
    value.mode !== "manual" &&
    value.mode !== "scheduled"
  )
    throw new TypeError("invocation.mode is invalid");
  return {
    mode: value.mode,
    scheduleResource:
      value.scheduleResource === null
        ? null
        : requiredString(value.scheduleResource, "invocation.scheduleResource"),
  };
}

/** Parses a agent Task-selection policy. */
function parseSelection(value: JsonObject): SelectionPolicy {
  assertExactKeys(
    value,
    [
      "acceptsAssignmentsFrom",
      "maxCandidateSummaries",
      "mode",
      "resultSchema",
      "taskQueryResource",
    ],
    "selection",
  );
  if (
    value.mode !== "coordinator" &&
    value.mode !== "explicit" &&
    value.mode !== "self"
  )
    throw new TypeError("selection.mode is invalid");
  /** Sources used during parse selection. */
  const sources = uniqueStrings(
    value.acceptsAssignmentsFrom,
    "selection.acceptsAssignmentsFrom",
  );
  if (
    sources.some(
      (source) =>
        source !== "coordinator" && source !== "explicit" && source !== "self",
    )
  )
    throw new TypeError(
      "selection.acceptsAssignmentsFrom contains an invalid source",
    );
  return {
    acceptsAssignmentsFrom:
      sources as SelectionPolicy["acceptsAssignmentsFrom"],
    maxCandidateSummaries: positiveInteger(
      value.maxCandidateSummaries,
      "selection.maxCandidateSummaries",
    ),
    mode: value.mode,
    resultSchema: requiredString(value.resultSchema, "selection.resultSchema"),
    taskQueryResource:
      value.taskQueryResource === null
        ? null
        : requiredString(
            value.taskQueryResource,
            "selection.taskQueryResource",
          ),
  };
}

/** Parses a agent retry policy. */
function parseRetry(value: JsonObject): RetryPolicy {
  assertExactKeys(value, ["maxAttempts", "noVerdict"], "retry");
  if (value.noVerdict !== "block" && value.noVerdict !== "retry")
    throw new TypeError("retry.noVerdict is invalid");
  return {
    maxAttempts: positiveInteger(value.maxAttempts, "retry.maxAttempts"),
    noVerdict: value.noVerdict,
  };
}

/** Issue. */
function issue(
  code: string,
  message: string,
  path: string,
): DefinitionValidationIssue {
  return { code, message, path };
}
/** Rejects objects with missing or unexpected fields. */
function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    throw new TypeError(`${label} has unexpected or missing fields`);
}
/** Rejects objects with missing required fields or unexpected fields. */
function assertKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const actual = new Set(Object.keys(value));
  if (
    required.some((key) => !actual.has(key)) ||
    [...actual].some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new TypeError(`${label} has unexpected or missing fields`);
}
/** Requires an array of unique strings. */
function uniqueStrings(
  value: JsonValue | undefined,
  label: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item === "")
  )
    throw new TypeError(`${label} must contain non-empty strings`);
  /** Strings used during unique strings. */
  const strings = value as string[];
  if (new Set(strings).size !== strings.length)
    throw new TypeError(`${label} contains duplicates`);
  return [...strings];
}
/** Requires an object whose values are strings. */
function stringMap(
  value: JsonObject,
  label: string,
): Readonly<Record<string, string>> {
  for (const [key, item] of Object.entries(value))
    if (key === "" || typeof item !== "string" || item === "")
      throw new TypeError(`${label} must map non-empty strings`);
  return { ...value } as Readonly<Record<string, string>>;
}
/** Requires an object whose values are non-empty arrays of unique strings. */
function stringArrayMap(
  value: JsonObject,
  label: string,
): Readonly<Record<string, readonly string[]>> {
  /** Collects validated intent sequences by outcome. */
  const result: Record<string, readonly string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "") throw new TypeError(`${label} contains an empty outcome`);
    /** Validates one required ordered intent sequence. */
    const sequence = uniqueStrings(item, `${label}.${key}`);
    if (sequence.length === 0)
      throw new TypeError(`${label}.${key} must not be empty`);
    result[key] = sequence;
  }
  return result;
}
/** Requires a field value to be a non-array JSON object. */
function objectValue(value: JsonValue | undefined, label: string): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new TypeError(`${label} must be an object`);
  return value;
}
/** Requires a non-empty string field value. */
function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
/** Requires a safe integer field value. */
function integer(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new TypeError(`${label} must be an integer`);
  return value;
}
/** Requires a positive safe integer field value. */
function positiveInteger(value: JsonValue | undefined, label: string): number {
  /** Result produced by positive integer. */
  const result = integer(value, label);
  if (result < 1) throw new TypeError(`${label} must be positive`);
  return result;
}
/** Requires a non-negative safe integer field value. */
function nonNegativeInteger(
  value: JsonValue | undefined,
  label: string,
): number {
  /** Result produced by non negative integer. */
  const result = integer(value, label);
  if (result < 0) throw new TypeError(`${label} must be non-negative`);
  return result;
}
/** Requires a boolean field value. */
function booleanValue(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${label} must be boolean`);
  return value;
}
/** Requires a supported schema discriminator. */
function schemaValue(value: JsonValue | undefined): "agent-definition-v1" {
  if (value !== "agent-definition-v1")
    throw new TypeError("Agent definition schema is invalid");
  return value;
}
