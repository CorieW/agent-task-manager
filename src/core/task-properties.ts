/** Keeps the typed Task status and its provider-visible property projection identical. */
import type { JsonObject } from "../domain/json.js";

/** Returns Task properties with the provider-visible Status value synchronized. */
export function taskPropertiesWithStatus(
  properties: JsonObject,
  status: string,
): JsonObject {
  return { ...structuredClone(properties), Status: status };
}
