import { createHash } from "node:crypto";

import type { JsonValue } from "../domain/json.js";
import { canonicalize } from "./canonical-json.js";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestJson(value: JsonValue): string {
  return sha256(canonicalize(value));
}
