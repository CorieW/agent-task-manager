// Selects due provider-defined roles without ranking or selecting their Tasks.
import type { SubAgentDefinition } from "../domain/records.js";
import { validateDefinitionSet } from "./sub-agent-definition.js";

export interface InvocationScheduleRequest {
  readonly activeRuns: Readonly<Record<string, number>>;
  readonly definitions: readonly SubAgentDefinition[];
  readonly limit: number;
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
        (request.activeRuns[definition.id] ?? 0) < definition.concurrency,
    )
    .sort(
      (left, right) =>
        right.invocationPriority - left.invocationPriority || left.id.localeCompare(right.id),
    )
    .slice(0, request.limit)
    .map((definition) => structuredClone(definition));
}
