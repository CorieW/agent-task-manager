/** Agent-configured, manager-owned Task-description section boundaries. */

/** Scoped Task-description capabilities declared by one Agent. */
export interface AgentTaskDescriptionConfig {
  /** Sections that a running Agent may replace through the manager. */
  readonly writableSections: readonly string[];
  /** Non-empty sections required before each declared outcome may complete. */
  readonly requiredSectionsByOutcome: Readonly<
    Record<string, readonly string[]>
  >;
}

/** Empty capability used by Agents that never write Task descriptions. */
export const EMPTY_AGENT_TASK_DESCRIPTION: AgentTaskDescriptionConfig = {
  requiredSectionsByOutcome: {},
  writableSections: [],
};

/** Parses and cross-validates an Agent's optional Task-description policy. */
export function parseAgentTaskDescriptionConfig(
  value: unknown,
  transitions: Readonly<Record<string, string>>,
): AgentTaskDescriptionConfig {
  if (value === undefined) return EMPTY_AGENT_TASK_DESCRIPTION;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Agent definition taskDescription must be an object");
  const input = value as Record<string, unknown>;
  rejectUnknownKeys(input, ["requiredSectionsByOutcome", "writableSections"]);
  const writableSections = sectionSet(
    input.writableSections,
    "taskDescription.writableSections",
  );
  if (writableSections.length === 0)
    throw new TypeError(
      "Agent definition taskDescription.writableSections must not be empty",
    );
  const required = input.requiredSectionsByOutcome;
  if (
    required === null ||
    typeof required !== "object" ||
    Array.isArray(required)
  )
    throw new TypeError(
      "Agent definition taskDescription.requiredSectionsByOutcome must be an object",
    );
  const requiredSectionsByOutcome: Record<string, readonly string[]> = {};
  for (const [outcome, sectionsValue] of Object.entries(required)) {
    if (!Object.hasOwn(transitions, outcome))
      throw new TypeError(
        `Agent definition taskDescription references unknown outcome: ${outcome}`,
      );
    const sections = sectionSet(
      sectionsValue,
      `taskDescription.requiredSectionsByOutcome.${outcome}`,
    );
    for (const section of sections)
      if (!writableSections.includes(section))
        throw new TypeError(
          `Agent definition required Task section is not writable: ${section}`,
        );
    requiredSectionsByOutcome[outcome] = sections;
  }
  return { requiredSectionsByOutcome, writableSections };
}

/** Replaces one exact level-two section or appends it when absent. */
export function upsertTaskDescriptionSection(
  markdown: string,
  section: string,
  content: string,
): string {
  const normalizedSection = taskSectionName(section);
  const normalizedMarkdown = normalizeMarkdown(markdown);
  const normalizedContent = normalizeMarkdown(content).trim();
  if (normalizedContent === "")
    throw new TypeError("Task section content must not be empty");
  if (headings(normalizedContent).some((entry) => entry.level <= 2))
    throw new TypeError(
      "Task section content must not contain level-one or level-two headings",
    );
  const matches = sectionMatches(normalizedMarkdown, normalizedSection);
  if (matches.length > 1)
    throw new Error(`Task description contains duplicate section: ${section}`);
  const replacement = `## ${normalizedSection}\n\n${normalizedContent}\n`;
  const match = matches[0];
  if (match !== undefined)
    return `${normalizedMarkdown.slice(0, match.start)}${replacement}${normalizedMarkdown.slice(match.end)}`;
  const separator =
    normalizedMarkdown === "" || normalizedMarkdown.endsWith("\n\n")
      ? ""
      : normalizedMarkdown.endsWith("\n")
        ? "\n"
        : "\n\n";
  return `${normalizedMarkdown}${separator}${replacement}`;
}

/** Reports whether one exact level-two section has non-empty content. */
export function taskDescriptionHasSection(
  markdown: string,
  section: string,
): boolean {
  const matches = sectionMatches(
    normalizeMarkdown(markdown),
    taskSectionName(section),
  );
  if (matches.length > 1)
    throw new Error(`Task description contains duplicate section: ${section}`);
  const match = matches[0];
  return match !== undefined && match.content.trim() !== "";
}

interface MarkdownHeading {
  readonly contentStart: number;
  readonly level: number;
  readonly start: number;
  readonly title: string;
}

interface SectionMatch {
  readonly content: string;
  readonly end: number;
  readonly start: number;
}

function sectionMatches(markdown: string, section: string): SectionMatch[] {
  const entries = headings(markdown);
  const result: SectionMatch[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.level !== 2 || entry.title !== section) continue;
    const following = entries
      .slice(index + 1)
      .find((candidate) => candidate.level <= entry.level);
    const end = following?.start ?? markdown.length;
    result.push({
      content: markdown.slice(entry.contentStart, end),
      end,
      start: entry.start,
    });
  }
  return result;
}

/** Finds Markdown headings outside fenced code blocks with source offsets. */
function headings(markdown: string): MarkdownHeading[] {
  const result: MarkdownHeading[] = [];
  let fence: { readonly character: string; readonly length: number } | null =
    null;
  let offset = 0;
  for (const segment of markdown.match(/[^\n]*(?:\n|$)/gu) ?? []) {
    if (segment === "") continue;
    const line = segment.endsWith("\n") ? segment.slice(0, -1) : segment;
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fenceMatch !== undefined) {
      const character = fenceMatch[0]!;
      if (fence === null) fence = { character, length: fenceMatch.length };
      else if (
        character === fence.character &&
        fenceMatch.length >= fence.length
      )
        fence = null;
    } else if (fence === null) {
      const match = /^[ \t]{0,3}(#{1,2})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined)
        result.push({
          contentStart: offset + segment.length,
          level: match[1].length,
          start: offset,
          title: match[2].normalize("NFC"),
        });
    }
    offset += segment.length;
  }
  return result;
}

function sectionSet(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new TypeError(`Agent definition ${name} must be a string array`);
  const sections = value.map((entry) => taskSectionName(entry as string));
  if (new Set(sections).size !== sections.length)
    throw new TypeError(`Agent definition ${name} must not contain duplicates`);
  return sections;
}

function taskSectionName(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (
    normalized === "" ||
    normalized.length > 128 ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) ||
    normalized.startsWith("#")
  )
    throw new TypeError("Task section name is invalid");
  return normalized;
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  supported: readonly string[],
): void {
  const unknown = Object.keys(value).filter((key) => !supported.includes(key));
  if (unknown.length !== 0)
    throw new TypeError(
      `Agent definition taskDescription contains unsupported fields: ${unknown.join(", ")}`,
    );
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}
