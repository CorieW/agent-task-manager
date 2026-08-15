/** Activates only definitions whose Resources, capabilities, intents, and routes verify. */
import { compileCapabilityGrant, type CapabilityGrant } from "./capability-compiler.js";
import { digestJson } from "./digest.js";
import { toJsonValue } from "../domain/json.js";
import { resolveLoadedDefinition, type ResolvedDefinition } from "./definition-resolver.js";
import { validateDefinitionSet } from "./sub-agent-definition.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";

export interface ActivatedDefinition {
  readonly digest: string;
  readonly grant: CapabilityGrant;
  readonly resolved: ResolvedDefinition;
}

export async function activateDefinitions(input: {
  readonly installedCapabilities: readonly string[];
  readonly installedIntents: readonly string[];
  readonly installedRunnerProfiles: readonly string[];
  readonly provider: AgentTaskProvider;
  readonly supportedModels: Readonly<Record<string, readonly string[]>>;
}): Promise<readonly ActivatedDefinition[]> {
  const definitions = await input.provider.listSubAgentDefinitions();
  const issues = validateDefinitionSet(definitions);
  if (issues.length > 0) throw new Error(`Sub-agent definition set is invalid:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`);
  const providerCapabilities = await input.provider.getCapabilities();
  const statuses = new Set(await input.provider.listTaskStatusOptions());
  const activated: ActivatedDefinition[] = [];
  for (const definition of definitions.filter((candidate) => candidate.enabled)) {
    if (!input.installedRunnerProfiles.includes(definition.runnerProfile)) throw new Error(`${definition.id}.runnerProfile is unavailable: ${definition.runnerProfile}`);
    const reasoning = input.supportedModels[definition.model];
    if (reasoning === undefined || !reasoning.includes(definition.reasoning)) throw new Error(`${definition.id} uses an unsupported model/reasoning pair`);
    for (const [outcome, status] of Object.entries(definition.transitions)) {
      if (status !== "$current" && !statuses.has(status)) throw new Error(`${definition.id}.transitions.${outcome} targets unavailable Task status ${status}`);
    }
    const resolved = await resolveLoadedDefinition(input.provider, definition);
    const grant = compileCapabilityGrant({
      definition: resolved.definition,
      installedCapabilities: input.installedCapabilities,
      installedIntents: input.installedIntents,
      providerCapabilities,
    });
    activated.push({ digest: digestJson(toJsonValue({ grant, resolvedDigest: resolved.digest })), grant, resolved });
  }
  return activated.sort((left, right) => left.resolved.definition.id.localeCompare(right.resolved.definition.id));
}
