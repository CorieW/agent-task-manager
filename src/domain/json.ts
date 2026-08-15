/** Defines the JSON-only value boundary and rejects values that cannot cross provider or runtime serialization. */
export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export class JsonValueError extends TypeError {}

export function toJsonValue(value: unknown): JsonValue {
  const seen = new WeakSet<object>();

  function convert(input: unknown, path: string): JsonValue {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new JsonValueError(`${path} must contain a finite number`);
      return input;
    }
    if (typeof input !== "object") throw new JsonValueError(`${path} is not JSON-compatible`);
    if (seen.has(input)) throw new JsonValueError(`${path} contains a cycle`);
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        return Array.from({ length: input.length }, (_, index) => {
          if (!Object.hasOwn(input, index)) throw new JsonValueError(`${path}[${index}] must not be a sparse array hole`);
          return convert(input[index], `${path}[${index}]`);
        });
      }
      const prototype = Object.getPrototypeOf(input) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new JsonValueError(`${path} must contain only plain objects`);
      }
      return Object.fromEntries(
        Object.entries(input).map(([key, entry]) => [key, convert(entry, `${path}.${key}`)]),
      );
    } finally {
      seen.delete(input);
    }
  }

  return convert(value, "value");
}
