/** Provides SHA-256 helpers for raw bytes and canonical provider-neutral JSON. */
import { createHash } from "node:crypto";

import type { JsonValue } from "../domain/json.js";
import { canonicalize } from "./canonical-json.js";

/** Returns the hexadecimal SHA-256 digest of UTF-8 text. */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Returns the SHA-256 digest of a value's canonical JSON representation. */
export function digestJson(value: JsonValue): string {
  return sha256(canonicalize(value));
}
