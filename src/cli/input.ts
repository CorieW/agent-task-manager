/** CLI file, standard-input, flag, and environment readers. */
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import process from "node:process";

import { toJsonValue } from "../domain/json.js";
import {
  parseReportErrorInput,
  type ReportErrorInput,
} from "../domain/records.js";

/** Reads and strictly parses an error-report payload. */
export async function readErrorInput(path: string): Promise<ReportErrorInput> {
  /** Untrusted environment or provider payload before strict parsing. */
  const raw = await readTextInput(path);
  /** JSON-safe representation passed to domain validation. */
  const value = toJsonValue(JSON.parse(raw) as unknown);
  return parseReportErrorInput(value);
}

/** Reads UTF-8 text from a file or standard input. */
export async function readTextInput(path: string): Promise<string> {
  return path === "-" ? readStdin() : readFile(path, "utf8");
}

/** Collects standard input as UTF-8 text. */
async function readStdin(): Promise<string> {
  /** Binary chunks collected from the input stream. */
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a required string-valued CLI flag. */
export function requiredFlag(
  flags: Readonly<Record<string, boolean | string>>,
  name: string,
): string {
  /** String value supplied for the named flag. */
  const value = optionalString(flags[name]);
  if (value === undefined || value === "") throw new Error(`Missing --${name}`);
  return value;
}

/** Reads a non-empty identity value injected by the trusted harness. */
export function requiredEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  /** Raw value supplied by the trusted harness environment. */
  const value = env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`Missing ${name}`);
  return value;
}

/** Resolves manager-only lock storage provisioned outside Agent sandboxes. */
export function coordinationDirectory(env: NodeJS.ProcessEnv): string {
  /** Required manager-owned coordination path. */
  const path = requiredEnvironmentValue(
    env,
    "AGENT_TASK_MANAGER_COORDINATION_DIRECTORY",
  );
  if (!isAbsolute(path))
    throw new Error(
      "AGENT_TASK_MANAGER_COORDINATION_DIRECTORY must be an absolute path",
    );
  return path;
}

/** Narrows an optional flag value to a string. */
export function optionalString(
  value: boolean | string | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}
