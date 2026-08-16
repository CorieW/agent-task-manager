/** Activates only definitions whose Resources, capabilities, intents, and routes verify. */
import {
  compileCapabilityGrant,
  type CapabilityGrant,
} from "./capability-compiler.js";
import { digestJson } from "./digest.js";
import { toJsonValue } from "../domain/json.js";
import {
  resolveLoadedDefinition,
  type ResolvedDefinition,
} from "./definition-resolver.js";
import { validateDefinitionSet } from "./agent-definition.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";

/** Binds a validated definition and Resource graph to its executable authority grant. */
export interface ActivatedDefinition {
  /** SHA-256 digest of the activated definition and resolved Resources. */
  readonly digest: string;
  /** Capabilities and effect intents authorized for this activation. */
  readonly grant: CapabilityGrant;
  /** Validated definition with its immutable Resource graph. */
  readonly resolved: ResolvedDefinition;
}

/** Validates and activates definitions that the current runtime can execute. */
export async function activateDefinitions(input: {
  /** Optional exact definition IDs to activate after validating the complete set. */
  readonly definitionIds?: readonly string[];
  /** Capability identifiers implemented by the current host. */
  readonly installedCapabilities: readonly string[];
  /** Effect-intent kinds implemented by the current host. */
  readonly installedIntents: readonly string[];
  /** Runner profiles available in the current host. */
  readonly installedRunnerProfiles: readonly string[];
  /** Provider supplying definitions, Resources, statuses, and capabilities. */
  readonly provider: AgentTaskProvider;
  /** Allowed reasoning levels keyed by installed model identifier. */
  readonly supportedModels: Readonly<Record<string, readonly string[]>>;
}): Promise<readonly ActivatedDefinition[]> {
  /** Complete definition set validated before target filtering. */
  const definitions = await input.provider.listAgentDefinitions();
  /** Validation issues collected during this operation. */
  const issues = validateDefinitionSet(definitions);
  if (issues.length > 0)
    throw new Error(
      `Agent definition set is invalid:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`,
    );
  /** Provider features used to compile each activation grant. */
  const providerCapabilities = await input.provider.getCapabilities();
  /** Valid Task statuses accepted by outcome routes. */
  const statuses = new Set(await input.provider.listTaskStatusOptions());
  /** Successfully validated activations returned in definition-ID order. */
  const activated: ActivatedDefinition[] = [];
  /** Optional exact target set, distinct from complete-set validation. */
  const requestedIds =
    input.definitionIds === undefined ? null : new Set(input.definitionIds);
  if (requestedIds !== null) {
    if (requestedIds.size !== input.definitionIds?.length)
      throw new Error("Definition activation IDs contain duplicates");
    for (const id of requestedIds) {
      /** Requested definition whose availability is checked before activation. */
      const definition = definitions.find((candidate) => candidate.id === id);
      if (definition === undefined)
        throw new Error(`Agent definition is unavailable: ${id}`);
      if (!definition.enabled)
        throw new Error(`Agent definition is disabled: ${id}`);
    }
  }
  for (const definition of definitions.filter(
    (candidate) =>
      candidate.enabled &&
      (requestedIds === null || requestedIds.has(candidate.id)),
  )) {
    if (!input.installedRunnerProfiles.includes(definition.runnerProfile))
      throw new Error(
        `${definition.id}.runnerProfile is unavailable: ${definition.runnerProfile}`,
      );
    /** Reasoning levels installed for the definition's selected model. */
    const reasoning = input.supportedModels[definition.model];
    if (reasoning === undefined || !reasoning.includes(definition.reasoning))
      throw new Error(
        `${definition.id} uses an unsupported model/reasoning pair`,
      );
    for (const [outcome, status] of Object.entries(definition.transitions)) {
      if (status !== "$current" && !statuses.has(status))
        throw new Error(
          `${definition.id}.transitions.${outcome} targets unavailable Task status ${status}`,
        );
    }
    /** Definition and immutable Resources resolved at their declared revisions. */
    const resolved = await resolveLoadedDefinition(input.provider, definition);
    /** Least authority compiled from the definition and installed host surface. */
    const grant = compileCapabilityGrant({
      definition: resolved.definition,
      installedCapabilities: input.installedCapabilities,
      installedIntents: input.installedIntents,
      providerCapabilities,
    });
    activated.push({
      digest: digestJson(
        toJsonValue({ grant, resolvedDigest: resolved.digest }),
      ),
      grant,
      resolved,
    });
  }
  return activated.sort((left, right) =>
    left.resolved.definition.id.localeCompare(right.resolved.definition.id),
  );
}
