/** Builds the minimal host environment needed for executable lookup and runtime locale behavior. */

/** Host variables implicitly forwarded to trusted child-process boundaries. */
const PROCESS_LOOKUP_ENVIRONMENT_KEYS = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
] as const;

/** Copies the ordered process-lookup allowlist without forwarding other host state. */
export function processLookupEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    PROCESS_LOOKUP_ENVIRONMENT_KEYS.flatMap((key) => {
      /** Host value retained exactly when defined, including an empty string. */
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}
