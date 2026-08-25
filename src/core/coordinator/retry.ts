/** Retry-chain limits and stable identities. */

/** Maximum attempts in one retry chain before human resolution is required. */
export const MAX_ATTEMPTS = 3;

/** Returns the stable Error key that gates a retry chain after its limit. */
export function retryErrorKey(retryKey: string): string {
  return `active-agent-retry:${retryKey}`;
}
