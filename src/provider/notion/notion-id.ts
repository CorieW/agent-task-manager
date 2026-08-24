/** Shared Notion identifier normalization. */

/** Extracts a compact, lowercase 32-hex identifier from a Notion ID or URL. */
export function normalizeNotionId(value: string): string {
  /** Trimmed identifier or URL supplied at the configuration boundary. */
  const input = value.trim();
  /** Raw compact or dashed ID accepted without URL parsing. */
  const raw = input.replaceAll("-", "");
  if (/^[a-fA-F0-9]{32}$/u.test(raw)) return raw.toLowerCase();

  /** URL pathname isolated from query and fragment identifiers such as view IDs. */
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(input).pathname);
  } catch {
    throw new TypeError(`Invalid Notion identifier: ${value}`);
  }
  /** Last page/database identifier embedded in the Notion pathname. */
  const identifierMatches = [
    ...pathname.matchAll(
      /[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}|[a-fA-F0-9]{32}/gu,
    ),
  ];
  /** Last identifier candidate found in the decoded pathname. */
  const identifierMatch = identifierMatches.at(-1)?.[0]?.replaceAll("-", "");
  if (identifierMatch === undefined)
    throw new TypeError(`Invalid Notion identifier: ${value}`);
  return identifierMatch.toLowerCase();
}
