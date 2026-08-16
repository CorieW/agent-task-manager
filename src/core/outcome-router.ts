/** Maps arbitrary typed outcomes through provider-defined transition data. */
import type { SubAgentDefinition } from "../domain/records.js";

/** Maps a typed outcome through provider-defined Task transitions. */
export function routeOutcome(input: {
  /** Current status for route outcome input. */
  readonly currentStatus: string;
  /** Definition for route outcome input. */
  readonly definition: Pick<SubAgentDefinition, "transitions">;
  /** Outcome for route outcome input. */
  readonly outcome: string;
  /** Valid statuses included in route outcome input. */
  readonly validStatuses: readonly string[];
}): string {
  /** Configured used during route outcome. */
  const configured = input.definition.transitions[input.outcome];
  if (configured === undefined)
    throw new Error(
      `Definition has no transition for outcome ${input.outcome}`,
    );
  if (configured === "$current") return input.currentStatus;
  if (!input.validStatuses.includes(configured))
    throw new Error(
      `Transition target is not a valid Task status: ${configured}`,
    );
  return configured;
}
