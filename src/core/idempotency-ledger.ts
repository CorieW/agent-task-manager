/** Supplies process-local replay semantics for provider conformance and adapter tests. */
import { digestJson } from "./digest.js";
import { toJsonValue, type JsonValue } from "../domain/json.js";

/** Canonical fields for ledger entry. */
interface LedgerEntry {
  /** Fingerprint for ledger entry. */
  readonly fingerprint: string;
  /** Operation for ledger entry. */
  readonly operation: string;
  /** Result for ledger entry. */
  readonly result: unknown;
}

/** Process-local ledger that validates and replays idempotent operations. */
export class IdempotencyLedger {
  /** Entries for idempotency ledger. */
  readonly #entries = new Map<string, LedgerEntry>();

  /** Returns a matching process-local replay or rejects key reuse. */
  public read<T>(
    key: string,
    operation: string,
    payload: JsonValue,
  ): T | undefined {
    /** Normalized payload used during read. */
    const normalizedPayload = toJsonValue(payload);
    /** Entry used during read. */
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    /** Canonical digest of fingerprint. */
    const fingerprint = digestJson({ operation, payload: normalizedPayload });
    if (entry.operation !== operation || entry.fingerprint !== fingerprint) {
      throw new Error(
        `Idempotency key reused with a different operation: ${key}`,
      );
    }
    return structuredClone(entry.result as T);
  }

  /** Stores a result or returns the existing matching process-local replay. */
  public write<T>(
    key: string,
    operation: string,
    payload: JsonValue,
    result: T,
  ): T {
    /** Normalized payload used during write. */
    const normalizedPayload = toJsonValue(payload);
    if (this.#entries.has(key)) {
      /** Replay used during write. */
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
