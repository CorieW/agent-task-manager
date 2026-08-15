/** Canonicalizes JSON with normalized strings and deterministic object-key ordering for digest-bound protocols. */
import type { JsonValue } from "../domain/json.js";

export class CanonicalJsonError extends TypeError {}

export function canonicalize(value: JsonValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC"));
  }

  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(
        "Canonical JSON does not permit non-finite numbers",
      );
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }

  const normalized = Object.entries(value).map(
    ([key, entry]) => [key.normalize("NFC"), entry] as const,
  );
  if (new Set(normalized.map(([key]) => key)).size !== normalized.length) {
    throw new CanonicalJsonError(
      "Object contains keys that collide after NFC normalization",
    );
  }
  const entries = normalized.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}
