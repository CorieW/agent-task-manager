/** Loads an explicitly selected local execution-host module behind a closed factory contract. */
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AgentExecutionBindings,
  AgentExecutionHostFactory,
  AgentExecutionHostFactoryInput,
} from "./execution-host.js";

/** Loads and invokes the `createAgentExecutionHost` export from a local module. */
export async function loadAgentExecutionHost(
  modulePath: string,
  input: AgentExecutionHostFactoryInput,
): Promise<AgentExecutionBindings> {
  if (modulePath === "")
    throw new TypeError("Execution host module path is required");
  /** Absolute caller-selected path before symlink resolution. */
  const absolutePath = isAbsolute(modulePath)
    ? modulePath
    : resolve(modulePath);
  /** Canonical filesystem path used as the sole dynamic-import target. */
  const canonicalPath = await realpath(absolutePath);
  /** Imported namespace retained as untrusted data until shape validation. */
  const moduleNamespace: unknown = await import(
    pathToFileURL(canonicalPath).href
  );
  if (moduleNamespace === null || typeof moduleNamespace !== "object")
    throw new TypeError("Execution host module is invalid");

  /** Candidate factory exported by the explicitly selected module. */
  const factory = (
    moduleNamespace as {
      /** Optional export narrowed to the trusted host-factory contract below. */
      createAgentExecutionHost?: unknown;
    }
  ).createAgentExecutionHost;
  if (typeof factory !== "function")
    throw new TypeError(
      "Execution host module must export createAgentExecutionHost",
    );

  /** Host-owned bindings returned by the validated factory export. */
  const bindings = await (factory as AgentExecutionHostFactory)(input);
  validateBindings(bindings);
  return bindings;
}

/** Rejects incomplete host modules before any assignment is promoted. */
function validateBindings(
  value: unknown,
): asserts value is AgentExecutionBindings {
  if (value === null || typeof value !== "object")
    throw new TypeError("Execution host bindings are invalid");
  /** Partial binding surface inspected without invoking host callbacks. */
  const bindings = value as Partial<AgentExecutionBindings>;
  if (
    bindings.activationRuntime === undefined ||
    typeof bindings.prepare !== "function" ||
    typeof bindings.executeEffects !== "function" ||
    (bindings.close !== undefined && typeof bindings.close !== "function") ||
    (bindings.humanResolution !== undefined &&
      typeof bindings.humanResolution !== "function") ||
    (bindings.remediationCycle !== undefined &&
      typeof bindings.remediationCycle !== "function")
  )
    throw new TypeError("Execution host bindings are incomplete");
}
