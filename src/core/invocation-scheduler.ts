// Selects due provider-defined roles without ranking or selecting their Tasks.
import type { SubAgentDefinition } from "../domain/records.js";
import { validateDefinitionSet } from "./sub-agent-definition.js";

export interface InvocationScheduleRequest {
  readonly activeRuns: Readonly<Record<string, number>>;
  readonly definitions: readonly SubAgentDefinition[];
  readonly dueScheduledDefinitionIds: readonly string[];
  readonly limit: number;
  readonly source: "event" | "manual" | "scheduled";
}

export function scheduleInvocations(
  request: InvocationScheduleRequest,
): readonly SubAgentDefinition[] {
  if (!Number.isInteger(request.limit) || request.limit < 1) {
    throw new RangeError("Invocation schedule limit must be a positive integer");
  }
  const issues = validateDefinitionSet(request.definitions);
  if (issues.length > 0) throw new Error(`Sub-agent definitions are invalid:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`);
  return request.definitions
    .filter(
      (definition) =>
        definition.enabled &&
        definition.invocation.mode === request.source &&
        (request.source !== "scheduled" || request.dueScheduledDefinitionIds.includes(definition.id)) &&
        (request.activeRuns[definition.id] ?? 0) < definition.maxConcurrency,
    )
    .sort(
      (left, right) =>
        right.priority - left.priority || left.id.localeCompare(right.id),
    )
    .slice(0, request.limit)
    .map((definition) => structuredClone(definition));
}
