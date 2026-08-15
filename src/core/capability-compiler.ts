// Compiles one least-privilege capability grant from definition and runtime facts.
import type { ProviderCapabilities } from "../domain/provider.js";
import type { SubAgentDefinition } from "../domain/records.js";

export interface CapabilityGrant {
  readonly allowedIntents: readonly string[];
  readonly capabilities: readonly string[];
  readonly providerRequirements: readonly string[];
}

export function compileCapabilityGrant(input: {
  readonly definition: SubAgentDefinition;
  readonly installedCapabilities: readonly string[];
  readonly installedIntents?: readonly string[];
  readonly providerCapabilities: ProviderCapabilities;
}): CapabilityGrant {
  const installed = new Set(input.installedCapabilities);
  for (const capability of input.definition.capabilities) {
    if (!installed.has(capability)) throw new Error(`Capability adapter is unavailable: ${capability}`);
  }
  const prohibited = new Set(input.definition.prohibitedCapabilities);
  if (input.definition.capabilities.some((capability) => prohibited.has(capability))) throw new Error("Definition grants a prohibited capability");
  for (const requirement of input.definition.requiredProviderCapabilities) {
    if (!providerRequirementMet(input.providerCapabilities, requirement)) throw new Error(`Provider capability is unavailable: ${requirement}`);
  }
  const installedIntents = new Set(input.installedIntents ?? input.definition.allowedIntents);
  for (const intent of input.definition.allowedIntents) if (!installedIntents.has(intent)) throw new Error(`Intent handler is unavailable: ${intent}`);
  return {
    allowedIntents: [...input.definition.allowedIntents].sort(),
    capabilities: [...input.definition.capabilities].sort(),
    providerRequirements: [...input.definition.requiredProviderCapabilities].sort(),
  };
}

function providerRequirementMet(capabilities: ProviderCapabilities, requirement: string): boolean {
  const [name, expected] = requirement.split("=", 2);
  if (name === undefined || name === "") return false;
  if (!(name in capabilities)) return false;
  const actual = capabilities[name as keyof ProviderCapabilities];
  return expected === undefined ? actual === true : String(actual) === expected;
}
