/** Defines the JSON-only value boundary and rejects values that cannot cross provider or runtime serialization. */
/** Represents scalar values accepted by the strict JSON boundary. */
export type JsonPrimitive = boolean | null | number | string;

/** Represents recursively serializable JSON values. */
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Maps object keys to recursively serializable JSON values. */
export type JsonObject = { [key: string]: JsonValue };

/** Signals that a value cannot cross the strict JSON boundary. */
export class JsonValueError extends TypeError {}

/** Copies unknown input into strict JSON or rejects unsupported structure. */
export function toJsonValue(value: unknown): JsonValue {
  /** Mutable state recording object identities already visited by recursive conversion. */
  const seen = new WeakSet<object>();

  /** Recursively validates and copies a value at its diagnostic path. */
  function convert(input: unknown, path: string): JsonValue {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    ) {
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new JsonValueError(`${path} must contain a finite number`);
      }
      return input;
    }
    if (typeof input !== "object") {
      throw new JsonValueError(`${path} is not JSON-compatible`);
    }
    if (seen.has(input)) {
      throw new JsonValueError(`${path} contains a cycle`);
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        return Array.from({ length: input.length }, (_, index) => {
          if (!Object.hasOwn(input, index))
            throw new JsonValueError(
              `${path}[${index}] must not be a sparse array hole`,
            );
          return convert(input[index], `${path}[${index}]`);
        });
      }
      /** The input prototype for the plain-object boundary check. */
      const prototype = Object.getPrototypeOf(input) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new JsonValueError(`${path} must contain only plain objects`);
      }
      return Object.fromEntries(
        Object.entries(input).map(([key, entry]) => [
          key,
          convert(entry, `${path}.${key}`),
        ]),
      );
    } finally {
      seen.delete(input);
    }
  }

  return convert(value, "value");
}
