/** Provides strict, shallow JSON boundary guards shared by Notion adapters. */
import type { JsonObject, JsonValue } from "../../domain/json.js";

/** Returns a non-null, non-array JSON object without copying it. */
export function objectValue(
  value: JsonValue | undefined,
  label: string,
): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new TypeError(`${label} must be an object`);
  return value;
}

/** Returns a required non-empty string or throws. */
export function requiredString(
  value: JsonValue | undefined,
  label: string,
): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
