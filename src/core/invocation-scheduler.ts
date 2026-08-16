/** Selects due provider-defined roles without ranking or selecting their Tasks. */
import type { AgentDefinition } from "../domain/records.js";
import { validateDefinitionSet } from "./agent-definition.js";

/** Inputs required to perform invocation schedule. */
export interface InvocationScheduleRequest {
  /** Active run count indexed by agent definition ID. */
  readonly activeRuns: Readonly<Record<string, number>>;
  /** Definitions included in invocation schedule request. */
  readonly definitions: readonly AgentDefinition[];
  /** Due scheduled definition IDs. */
  readonly dueScheduledDefinitionIds: readonly string[];
  /** Limit for invocation schedule request. */
  readonly limit: number;
  /** Source for invocation schedule request. */
  readonly source: "event" | "manual" | "scheduled";
}

/** Selects enabled definitions that are due and below their concurrency limits. */
export function scheduleInvocations(
  request: InvocationScheduleRequest,
): readonly AgentDefinition[] {
  if (!Number.isInteger(request.limit) || request.limit < 1) {
    throw new RangeError(
      "Invocation schedule limit must be a positive integer",
    );
  }
  /** Validation issues collected during this operation. */
  const issues = validateDefinitionSet(request.definitions);
  if (issues.length > 0)
    throw new Error(
      `Agent definitions are invalid:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`,
    );
  return request.definitions
    .filter(
      (definition) =>
        definition.enabled &&
        definition.invocation.mode === request.source &&
        (request.source !== "scheduled" ||
          request.dueScheduledDefinitionIds.includes(definition.id)) &&
        (request.activeRuns[definition.id] ?? 0) < definition.maxConcurrency,
    )
    .sort(
      (left, right) =>
        right.priority - left.priority || left.id.localeCompare(right.id),
    )
    .slice(0, request.limit)
    .map((definition) => structuredClone(definition));
}
