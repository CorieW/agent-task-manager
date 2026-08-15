// Maps arbitrary typed outcomes through provider-defined transition data.
import type { SubAgentDefinition } from "../domain/records.js";

export function routeOutcome(input: {
  readonly currentStatus: string;
  readonly definition: SubAgentDefinition;
  readonly outcome: string;
  readonly validStatuses: readonly string[];
}): string {
  const configured = input.definition.transitions[input.outcome];
  if (configured === undefined) throw new Error(`Definition has no transition for outcome ${input.outcome}`);
  if (configured === "$current") return input.currentStatus;
  if (!input.validStatuses.includes(configured)) throw new Error(`Transition target is not a valid Task status: ${configured}`);
  return configured;
}
