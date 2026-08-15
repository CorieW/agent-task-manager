/** Constructs and validates the shared external-effect observation protocol. */
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ExternalEffectObservation } from "./contracts.js";

export function createEffectObservation(
  state: ExternalEffectObservation["state"],
  evidence: unknown,
  externalIdentity: unknown = {},
): ExternalEffectObservation {
  const observation = { evidence: jsonObject(evidence, "External-effect evidence"), externalIdentity: jsonObject(externalIdentity, "External-effect identity"), state };
  validateEffectObservation(observation);
  return observation;
}

export function validateEffectObservation(value: ExternalEffectObservation): void {
  if (!["applied", "failed", "indeterminate", "not_applied"].includes(value.state)) throw new TypeError("External-effect observation state is invalid");
  jsonObject(value.evidence, "External-effect evidence");
  jsonObject(value.externalIdentity, "External-effect identity");
}

function jsonObject(value: unknown, label: string): JsonObject {
  const converted = toJsonValue(value);
  if (converted === null || typeof converted !== "object" || Array.isArray(converted)) throw new TypeError(`${label} must be an object`);
  return converted;
}
