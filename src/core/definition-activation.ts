// Activates only definitions whose Resources, capabilities, intents, and routes verify.
import { compileCapabilityGrant, type CapabilityGrant } from "./capability-compiler.js";
import { resolveDefinition, type ResolvedDefinition } from "./definition-resolver.js";
import { validateDefinitionSet } from "./sub-agent-definition.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";

export interface ActivatedDefinition {
  readonly grant: CapabilityGrant;
  readonly resolved: ResolvedDefinition;
}

export async function activateDefinitions(input: {
  readonly installedCapabilities: readonly string[];
  readonly installedIntents: readonly string[];
  readonly provider: AgentTaskProvider;
}): Promise<readonly ActivatedDefinition[]> {
  const definitions = await input.provider.listSubAgentDefinitions();
  const issues = validateDefinitionSet(definitions);
  if (issues.length > 0) throw new Error(`Sub-agent definition set is invalid:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`);
  const providerCapabilities = await input.provider.getCapabilities();
  const statuses = new Set(await input.provider.listTaskStatusOptions());
  const activated: ActivatedDefinition[] = [];
  for (const definition of definitions.filter((candidate) => candidate.enabled)) {
    for (const [outcome, status] of Object.entries(definition.transitions)) {
      if (status !== "$current" && !statuses.has(status)) throw new Error(`${definition.id}.transitions.${outcome} targets unavailable Task status ${status}`);
    }
    const resolved = await resolveDefinition(input.provider, definition.id);
    const grant = compileCapabilityGrant({
      definition,
      installedCapabilities: input.installedCapabilities,
      installedIntents: input.installedIntents,
      providerCapabilities,
    });
    activated.push({ grant, resolved });
  }
  return activated.sort((left, right) => left.resolved.definition.id.localeCompare(right.resolved.definition.id));
}
