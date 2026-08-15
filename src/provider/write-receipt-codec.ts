// Parses provider write receipts with one closed runtime contract.
import { TABLE_KINDS, type TableKind, type WriteReceipt } from "../domain/provider.js";
import type { JsonObject, JsonValue } from "../domain/json.js";

export function parseWriteReceipt(value: JsonValue): WriteReceipt {
  const object = exactObject(value, ["idempotencyKey", "observedVersion", "providerRecord", "writtenAt"], "Write receipt");
  const providerRecord = exactObject(object.providerRecord ?? null, ["id", "table"], "Provider record");
  const table = requiredString(providerRecord.table, "Provider record table");
  if (!TABLE_KINDS.includes(table as TableKind)) throw new TypeError("Provider record table is invalid");
  return {
    idempotencyKey: requiredString(object.idempotencyKey, "Receipt idempotencyKey"),
    observedVersion: requiredString(object.observedVersion, "Receipt observedVersion"),
    providerRecord: { id: requiredString(providerRecord.id, "Provider record id"), table: table as TableKind },
    writtenAt: requiredString(object.writtenAt, "Receipt writtenAt"),
  };
}

function exactObject(value: JsonValue, keys: readonly string[], label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new TypeError(`${label} has unexpected or missing fields`);
  return value;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
