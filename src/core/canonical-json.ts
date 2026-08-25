/** Canonicalizes JSON with normalized strings and deterministic object-key ordering for digest-bound protocols. */
import type { JsonValue } from "../domain/json.js";

/** Error raised when canonical JSON validation fails. */
export class CanonicalJsonError extends TypeError {}

/** Serializes a JSON value into deterministic canonical text. */
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

  /** Entries with keys normalized to NFC before collision detection. */
  const normalized = Object.entries(value).map(
    ([key, entry]) => [key.normalize("NFC"), entry] as const,
  );
  if (new Set(normalized.map(([key]) => key)).size !== normalized.length) {
    throw new CanonicalJsonError(
      "Object contains keys that collide after NFC normalization",
    );
  }
  /** Copied entries sorted lexicographically without mutating the input object. */
  const entries = normalized.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}
