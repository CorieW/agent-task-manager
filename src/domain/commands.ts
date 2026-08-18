/** Defines and evaluates the command policy stored in an Agent definition. */

/** Inclusion permits only listed commands; exclusion permits all but listed commands. */
export type AgentCommandPolicy =
  | { readonly inclusion: readonly string[] }
  | { readonly exclusion: readonly string[] };

/** Normalizes one path-free executable name for deterministic policy matching. */
export function normalizeCommandName(value: string): string {
  const normalized = value.normalize("NFC").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._+-]{0,127}$/u.test(normalized))
    throw new TypeError(`Invalid command name: ${value}`);
  const command = normalized.replace(/(?:\.(?:bat|cmd|com|exe)|\.)+$/u, "");
  if (command.length === 0)
    throw new TypeError(`Invalid command name: ${value}`);
  return command;
}

/** Strictly parses a mutually exclusive inclusion or exclusion policy. */
export function parseAgentCommandPolicy(value: unknown): AgentCommandPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Agent definition commands must be an object");
  const policy = value as Record<string, unknown>;
  const keys = Object.keys(policy);
  if (keys.length !== 1 || (keys[0] !== "inclusion" && keys[0] !== "exclusion"))
    throw new TypeError(
      "Agent definition commands must define exactly one of inclusion or exclusion",
    );
  const key = keys[0];
  const entries = policy[key];
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => typeof entry !== "string")
  )
    throw new TypeError(
      `Agent definition commands.${key} must be a string array`,
    );
  const commands = entries.map((entry) => normalizeCommandName(entry));
  if (new Set(commands).size !== commands.length)
    throw new TypeError(`Agent definition commands.${key} contains duplicates`);
  return key === "inclusion"
    ? { inclusion: commands }
    : { exclusion: commands };
}

/** Returns whether a normalized top-level executable is permitted by a policy. */
export function commandIsAllowed(
  policy: AgentCommandPolicy,
  command: string,
): boolean {
  const normalized = normalizeCommandName(command);
  return "inclusion" in policy
    ? policy.inclusion.includes(normalized)
    : !policy.exclusion.includes(normalized);
}
