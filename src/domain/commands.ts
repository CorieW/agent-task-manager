/** Defines and evaluates the command policy stored in an Agent definition. */

/** Inclusion permits only listed commands; exclusion permits all but listed commands. */
export type AgentCommandPolicy =
  | {
      /** Normalized commands that are exclusively permitted. */
      readonly inclusion: readonly string[];
    }
  | {
      /** Normalized commands denied while every other command remains permitted. */
      readonly exclusion: readonly string[];
    };

/** Normalizes one path-free executable name for deterministic policy matching. */
export function normalizeCommandName(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  /** NFC-normalized value used for equality and validation. */
  const normalized = value.normalize("NFC");
  if (!/^[a-z0-9][a-z0-9._+-]{0,127}$/iu.test(normalized))
    throw new TypeError(`Invalid command name: ${value}`);
  if (platform !== "win32") return normalized;
  /** Canonical command key selected from positional arguments. */
  const command = normalized
    .toLowerCase()
    .replace(/(?:\.(?:bat|cmd|com|exe)|\.)+$/u, "");
  if (command.length === 0)
    throw new TypeError(`Invalid command name: ${value}`);
  return command;
}

/** Strictly parses a mutually exclusive inclusion or exclusion policy. */
export function parseAgentCommandPolicy(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): AgentCommandPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Agent definition commands must be an object");
  /** Strictly decoded Agent command policy. */
  const policy = value as Record<string, unknown>;
  /** Allowlisted keys accepted by the current boundary. */
  const keys = Object.keys(policy);
  if (keys.length !== 1 || (keys[0] !== "inclusion" && keys[0] !== "exclusion"))
    throw new TypeError(
      "Agent definition commands must define exactly one of inclusion or exclusion",
    );
  /** Stable domain key used for lookup. */
  const key = keys[0];
  /** Ordered entries being validated or transformed. */
  const entries = policy[key];
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => typeof entry !== "string")
  )
    throw new TypeError(
      `Agent definition commands.${key} must be a string array`,
    );
  /** Agent command inclusion or exclusion policy. */
  const commands = entries.map((entry) =>
    normalizeCommandName(entry, platform),
  );
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
  platform: NodeJS.Platform = process.platform,
): boolean {
  /** NFC-normalized value used for equality and validation. */
  const normalized = normalizeCommandName(command, platform);
  return "inclusion" in policy
    ? policy.inclusion.includes(normalized)
    : !policy.exclusion.includes(normalized);
}
