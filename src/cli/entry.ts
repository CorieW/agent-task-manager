/** Direct-execution detection and stable CLI output helpers. */
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EnvironmentConfigError } from "../config/environment.js";
import type { JsonValue } from "../domain/json.js";

/** Converts a rejected CLI invocation into its stable machine-readable envelope. */
export function cliErrorPayload(error: unknown): JsonValue {
  /** Human-readable failure text preserved without serializing sensitive causes. */
  const message = error instanceof Error ? error.message : String(error);
  /** Structured validation details available for aggregate configuration errors. */
  const issues =
    error instanceof EnvironmentConfigError ? [...error.issues] : undefined;
  return {
    error: {
      ...(issues === undefined ? {} : { issues }),
      message,
      name: error instanceof Error ? error.name : "Error",
    },
  };
}

/** Identifies a CLI entry point after resolving package-manager links. */
export function isDirectExecution(
  moduleUrl: string,
  argumentPath: string | undefined,
): boolean {
  if (argumentPath === undefined) return false;
  try {
    /** Canonical path of this module. */
    const modulePath = realpathSync(fileURLToPath(moduleUrl));
    /** Canonical path used to invoke the process. */
    const invokedPath = realpathSync(argumentPath);
    return process.platform === "win32"
      ? modulePath.toLowerCase() === invokedPath.toLowerCase()
      : modulePath === invokedPath;
  } catch {
    return moduleUrl === pathToFileURL(argumentPath).href;
  }
}

/** Returns a nonzero status for failed or signalled proxied commands. */
export function proxyExitCode(result: JsonValue): number | null {
  if (result === null || Array.isArray(result) || typeof result !== "object")
    return null;
  if (typeof result.signal === "string") return 1;
  return typeof result.exitCode === "number" ? result.exitCode : null;
}
