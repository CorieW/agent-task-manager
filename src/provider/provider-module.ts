/** Runtime contract for dynamically loaded Agent Task Manager providers. */
import type { JsonObject } from "../domain/json.js";
import type { AgentTaskProvider } from "./agent-task-provider.js";

/** Versioned provider-module contract understood by this package version. */
export const AGENT_TASK_PROVIDER_MODULE_SCHEMA =
  "agent-task-provider-module-v1" as const;

/** Trusted host context supplied to a provider factory. */
export interface AgentTaskProviderFactoryContext {
  /** Stable identity used to isolate one managed environment. */
  readonly environmentId: string;
  /** Host environment available to the trusted provider adapter. */
  readonly environmentVariables: Readonly<Record<string, string | undefined>>;
  /** Opaque provider-owned JSON from the environment configuration. */
  readonly options: JsonObject;
}

/** Named export implemented by an importable provider module. */
export interface AgentTaskProviderModule {
  /** Creates a provider instance for one CLI invocation. */
  create(
    context: AgentTaskProviderFactoryContext,
  ): AgentTaskProvider | Promise<AgentTaskProvider>;
  /** Versioned module contract identifier. */
  readonly schema: typeof AGENT_TASK_PROVIDER_MODULE_SCHEMA;
  /** Stable human-readable provider type. */
  readonly type: string;
}

/** Required named export through which provider modules are discovered. */
export const AGENT_TASK_PROVIDER_MODULE_EXPORT =
  "agentTaskProviderModule" as const;

/** Validates an untrusted dynamic-module namespace. */
export function parseAgentTaskProviderModule(
  namespace: unknown,
  specifier: string,
): AgentTaskProviderModule {
  if (namespace === null || typeof namespace !== "object")
    throw new TypeError(`Provider module ${specifier} has no module namespace`);
  /** Required provider descriptor selected from the dynamic namespace. */
  const candidate = (namespace as Record<string, unknown>)[
    AGENT_TASK_PROVIDER_MODULE_EXPORT
  ];
  if (candidate === null || typeof candidate !== "object")
    throw new TypeError(
      `Provider module ${specifier} must export ${AGENT_TASK_PROVIDER_MODULE_EXPORT}`,
    );
  /** Record view used to validate the module descriptor. */
  const value = candidate as Record<string, unknown>;
  if (value.schema !== AGENT_TASK_PROVIDER_MODULE_SCHEMA)
    throw new TypeError(
      `Provider module ${specifier} schema must equal ${AGENT_TASK_PROVIDER_MODULE_SCHEMA}`,
    );
  if (typeof value.type !== "string" || value.type.trim() === "")
    throw new TypeError(`Provider module ${specifier} type must be non-empty`);
  if (typeof value.create !== "function")
    throw new TypeError(
      `Provider module ${specifier} must provide a create function`,
    );
  return candidate as AgentTaskProviderModule;
}

/** Verifies that a provider factory returned the complete runtime contract. */
export function assertAgentTaskProvider(
  value: unknown,
  providerType: string,
): asserts value is AgentTaskProvider {
  if (value === null || typeof value !== "object")
    throw new TypeError(`Provider ${providerType} did not return an object`);
  /** Complete method surface required by the coordinator and CLI. */
  const methods = [
    "validateEnvironment",
    "validateWorkspace",
    "planWorkspace",
    "applyWorkspacePlan",
    "listTasks",
    "getTask",
    "setTaskStatus",
    "updateTaskBody",
    "listAgents",
    "getAgent",
    "getAgentByKey",
    "listResources",
    "getResourceByKey",
    "listActiveAgents",
    "getActiveAgent",
    "createActiveAgent",
    "updateActiveAgent",
    "archiveActiveAgent",
    "listErrors",
    "getErrorByKey",
    "reportError",
    "resolveError",
  ] as const;
  for (const method of methods)
    if (typeof (value as Record<string, unknown>)[method] !== "function")
      throw new TypeError(
        `Provider ${providerType} is missing required method ${method}`,
      );
}
