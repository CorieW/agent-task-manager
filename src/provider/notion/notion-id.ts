/** Shared Notion identifier normalization. */

/** Extracts a compact, lowercase 32-hex identifier from a Notion ID or URL. */
export function normalizeNotionId(value: string): string {
  const compact = value.replace(/[^a-fA-F0-9]/gu, "");
  const match = compact.match(/[a-fA-F0-9]{32}$/u);
  if (match === null)
    throw new TypeError(`Invalid Notion identifier: ${value}`);
  return match[0]!.toLowerCase();
}
