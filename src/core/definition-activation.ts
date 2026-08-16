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

/** Canonical fields for activated definition. */
export interface ActivatedDefinition {
  /** SHA-256 digest of the activated definition and resolved Resources. */
  readonly digest: string;
  /** Grant for activated definition. */
  readonly grant: CapabilityGrant;
  /** Resolved for activated definition. */
  readonly resolved: ResolvedDefinition;
}

/** Validates and activates definitions that the current runtime can execute. */
export async function activateDefinitions(input: {
  /** Optional exact definition IDs to activate after validating the complete set. */
  readonly definitionIds?: readonly string[];
  /** Installed capabilities included in activate definitions input. */
  readonly installedCapabilities: readonly string[];
  /** Installed intents included in activate definitions input. */
  readonly installedIntents: readonly string[];
  /** Installed runner profiles included in activate definitions input. */
  readonly installedRunnerProfiles: readonly string[];
  /** Provider for activate definitions input. */
  readonly provider: AgentTaskProvider;
  /** Supported models included in activate definitions input. */
  readonly supportedModels: Readonly<Record<string, readonly string[]>>;
}): Promise<readonly ActivatedDefinition[]> {
  /** Definitions loaded during activate definitions. */
  const definitions = await input.provider.listAgentDefinitions();
  /** Validation issues collected during this operation. */
  const issues = validateDefinitionSet(definitions);
  if (issues.length > 0)
    throw new Error(
      `Agent definition set is invalid:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`,
    );
  /** Provider capabilities loaded during activate definitions. */
  const providerCapabilities = await input.provider.getCapabilities();
  /** Distinct statuses tracked during activate definitions. */
  const statuses = new Set(await input.provider.listTaskStatusOptions());
  /** Activated used during activate definitions. */
  const activated: ActivatedDefinition[] = [];
  const requestedIds =
    input.definitionIds === undefined ? null : new Set(input.definitionIds);
  if (requestedIds !== null) {
    if (requestedIds.size !== input.definitionIds?.length)
      throw new Error("Definition activation IDs contain duplicates");
    for (const id of requestedIds) {
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
    /** Reasoning used during activate definitions. */
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
    /** Resolved loaded during activate definitions. */
    const resolved = await resolveLoadedDefinition(input.provider, definition);
    /** Grant used during activate definitions. */
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
