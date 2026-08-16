/** Compiles one least-privilege capability grant from definition and runtime facts. */
import type { ProviderCapabilities } from "../domain/provider.js";
import type { AgentDefinition } from "../domain/records.js";

/** Canonical fields for capability grant. */
export interface CapabilityGrant {
  /** Effect intents the definition may invoke. */
  readonly allowedIntents: readonly string[];
  /** Capabilities included in capability grant. */
  readonly capabilities: readonly string[];
  /** Provider requirements included in capability grant. */
  readonly providerRequirements: readonly string[];
}

/** Builds a least-privilege grant from a definition and installed capabilities. */
export function compileCapabilityGrant(input: {
  /** Definition for compile capability grant input. */
  readonly definition: AgentDefinition;
  /** Installed capabilities included in compile capability grant input. */
  readonly installedCapabilities: readonly string[];
  /** Installed intents included in compile capability grant input. */
  readonly installedIntents?: readonly string[];
  /** Provider capabilities for compile capability grant input. */
  readonly providerCapabilities: ProviderCapabilities;
}): CapabilityGrant {
  /** Distinct installed tracked during compile capability grant. */
  const installed = new Set(input.installedCapabilities);
  for (const capability of input.definition.capabilities) {
    if (!installed.has(capability))
      throw new Error(`Capability adapter is unavailable: ${capability}`);
  }
  /** Distinct prohibited tracked during compile capability grant. */
  const prohibited = new Set(input.definition.prohibitedCapabilities);
  if (
    input.definition.capabilities.some((capability) =>
      prohibited.has(capability),
    )
  )
    throw new Error("Definition grants a prohibited capability");
  for (const requirement of input.definition.requiredProviderCapabilities) {
    if (!providerRequirementMet(input.providerCapabilities, requirement))
      throw new Error(`Provider capability is unavailable: ${requirement}`);
  }
  /** Distinct installed intents tracked during compile capability grant. */
  const installedIntents = new Set(
    input.installedIntents ?? input.definition.allowedIntents,
  );
  for (const intent of input.definition.allowedIntents)
    if (!installedIntents.has(intent))
      throw new Error(`Intent handler is unavailable: ${intent}`);
  return {
    allowedIntents: [...input.definition.allowedIntents].sort(),
    capabilities: [...input.definition.capabilities].sort(),
    providerRequirements: [
      ...input.definition.requiredProviderCapabilities,
    ].sort(),
  };
}

/** Checks one encoded provider-capability requirement against observed capabilities. */
function providerRequirementMet(
  capabilities: ProviderCapabilities,
  requirement: string,
): boolean {
  /** Name and expected used during provider requirement met. */
  const [name, expected] = requirement.split("=", 2);
  if (name === undefined || name === "") return false;
  if (!(name in capabilities)) return false;
  /** Provider capability value compared with the encoded requirement. */
  const actual = capabilities[name as keyof ProviderCapabilities];
  return expected === undefined ? actual === true : String(actual) === expected;
}
