/** Supplies process-local replay semantics for provider conformance and adapter tests. */
import { digestJson } from "./digest.js";
import { toJsonValue, type JsonValue } from "../domain/json.js";

interface LedgerEntry {
  readonly fingerprint: string;
  readonly operation: string;
  readonly result: unknown;
}

export class IdempotencyLedger {
  readonly #entries = new Map<string, LedgerEntry>();

  public read<T>(
    key: string,
    operation: string,
    payload: JsonValue,
  ): T | undefined {
    const normalizedPayload = toJsonValue(payload);
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    const fingerprint = digestJson({ operation, payload: normalizedPayload });
    if (entry.operation !== operation || entry.fingerprint !== fingerprint) {
      throw new Error(
        `Idempotency key reused with a different operation: ${key}`,
      );
    }
    return structuredClone(entry.result as T);
  }

  public write<T>(
    key: string,
    operation: string,
    payload: JsonValue,
    result: T,
  ): T {
    const normalizedPayload = toJsonValue(payload);
    if (this.#entries.has(key)) {
      const replay = this.read<T>(key, operation, normalizedPayload);
      if (replay === undefined)
        throw new Error(`Unable to replay idempotency key: ${key}`);
      return replay;
    }
    this.#entries.set(key, {
      fingerprint: digestJson({ operation, payload: normalizedPayload }),
      operation,
      result: structuredClone(result),
    });
    return structuredClone(result);
  }
}
