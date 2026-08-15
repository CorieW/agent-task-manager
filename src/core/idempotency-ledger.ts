// Supplies process-local replay semantics for provider conformance and adapter tests.
import { digestJson } from "./digest.js";
import type { JsonValue } from "../domain/json.js";

interface LedgerEntry {
  readonly fingerprint: string;
  readonly operation: string;
  readonly result: unknown;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export class IdempotencyLedger {
  readonly #entries = new Map<string, LedgerEntry>();

  public read<T>(key: string, operation: string, payload: unknown): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    const fingerprint = digestJson(asJson({ operation, payload }));
    if (entry.operation !== operation || entry.fingerprint !== fingerprint) {
      throw new Error(`Idempotency key reused with a different operation: ${key}`);
    }
    return structuredClone(entry.result as T);
  }

  public write<T>(key: string, operation: string, payload: unknown, result: T): T {
    if (this.#entries.has(key)) {
      const replay = this.read<T>(key, operation, payload);
      if (replay === undefined) throw new Error(`Unable to replay idempotency key: ${key}`);
      return replay;
    }
    this.#entries.set(key, {
      fingerprint: digestJson(asJson({ operation, payload })),
      operation,
      result: structuredClone(result),
    });
    return structuredClone(result);
  }
}
