/** Constructs and validates the shared external-effect observation protocol. */
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ExternalEffectObservation } from "./contracts.js";

/** Creates effect observation after validating its inputs. */
export function createEffectObservation(
  state: ExternalEffectObservation["state"],
  evidence: unknown,
  externalIdentity: unknown = {},
): ExternalEffectObservation {
  /** Observation snapshot used consistently during the create effect observation operation. */
  const observation = {
    evidence: jsonObject(evidence, "External-effect evidence"),
    externalIdentity: jsonObject(externalIdentity, "External-effect identity"),
    state,
  };
  validateEffectObservation(observation);
  return observation;
}

/** Rejects invalid effect observation before it crosses the boundary. */
export function validateEffectObservation(
  value: ExternalEffectObservation,
): void {
  if (
    !["applied", "failed", "indeterminate", "not_applied"].includes(value.state)
  )
    throw new TypeError("External-effect observation state is invalid");
  jsonObject(value.evidence, "External-effect evidence");
  jsonObject(value.externalIdentity, "External-effect identity");
}

/** Validates and returns a non-array JSON object. */
function jsonObject(value: unknown, label: string): JsonObject {
  /** Result of `toJsonValue`, retained for the json object operation. */
  const converted = toJsonValue(value);
  if (
    converted === null ||
    typeof converted !== "object" ||
    Array.isArray(converted)
  )
    throw new TypeError(`${label} must be an object`);
  return converted;
}
