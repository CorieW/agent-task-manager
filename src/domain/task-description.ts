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
  /** Validated input for the current boundary operation. */
  const input = value as Record<string, unknown>;
  rejectUnknownKeys(input, ["requiredSectionsByOutcome", "writableSections"]);
  /** Task-description sections this Agent may replace. */
  const writableSections = sectionSet(
    input.writableSections,
    "taskDescription.writableSections",
  );
  if (writableSections.length === 0)
    throw new TypeError(
      "Agent definition taskDescription.writableSections must not be empty",
    );
  /** Outcome-to-sections object supplied by the Agent definition. */
  const required = input.requiredSectionsByOutcome;
  if (
    required === null ||
    typeof required !== "object" ||
    Array.isArray(required)
  )
    throw new TypeError(
      "Agent definition taskDescription.requiredSectionsByOutcome must be an object",
    );
  /** Validated section requirements indexed by Agent outcome. */
  const requiredSectionsByOutcome: Record<string, readonly string[]> = {};
  for (const [outcome, sectionsValue] of Object.entries(required)) {
    if (!Object.hasOwn(transitions, outcome))
      throw new TypeError(
        `Agent definition taskDescription references unknown outcome: ${outcome}`,
      );
    /** Validated Task-section names in declaration order. */
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
  /** Validated level-two section name. */
  const normalizedSection = taskSectionName(section);
  /** NFC-normalized Task Markdown being updated. */
  const normalizedMarkdown = normalizeMarkdown(markdown);
  /** NFC-normalized replacement content without outer whitespace. */
  const normalizedContent = normalizeMarkdown(content).trim();
  if (normalizedContent === "")
    throw new TypeError("Task section content must not be empty");
  if (headings(normalizedContent).some((entry) => entry.level <= 2))
    throw new TypeError(
      "Task section content must not contain level-one or level-two headings",
    );
  /** All candidates matching the requested stable key. */
  const matches = sectionMatches(normalizedMarkdown, normalizedSection);
  if (matches.length > 1)
    throw new Error(`Task description contains duplicate section: ${section}`);
  /** Canonical replacement text for the managed Markdown region. */
  const replacement = `## ${normalizedSection}\n\n${normalizedContent}\n`;
  /** Single validated match selected after uniqueness checks. */
  const match = matches[0];
  if (match !== undefined)
    return `${normalizedMarkdown.slice(0, match.start)}${replacement}${normalizedMarkdown.slice(match.end)}`;
  /** Minimal newline separator needed before an appended section. */
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
  /** All candidates matching the requested stable key. */
  const matches = sectionMatches(
    normalizeMarkdown(markdown),
    taskSectionName(section),
  );
  if (matches.length > 1)
    throw new Error(`Task description contains duplicate section: ${section}`);
  /** Single validated match selected after uniqueness checks. */
  const match = matches[0];
  return match !== undefined && match.content.trim() !== "";
}

/** Source offsets and normalized title for one Markdown heading. */
interface MarkdownHeading {
  /** Offset immediately after the heading line. */
  readonly contentStart: number;
  /** Markdown heading depth. */
  readonly level: number;
  /** Offset at which the heading begins. */
  readonly start: number;
  /** Trimmed heading text. */
  readonly title: string;
}

/** Content and source range for a matched Task-description section. */
interface SectionMatch {
  /** Section body without its heading. */
  readonly content: string;
  /** Exclusive end offset of the matched Markdown region. */
  readonly end: number;
  /** Offset at which the section heading begins. */
  readonly start: number;
}

/** Locates every exact level-two Task-description section. */
function sectionMatches(markdown: string, section: string): SectionMatch[] {
  /** Ordered entries being validated or transformed. */
  const entries = headings(markdown);
  /** Validated result returned by the current operation. */
  const result: SectionMatch[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    /** Current Markdown heading candidate. */
    const entry = entries[index]!;
    if (entry.level !== 2 || entry.title !== section) continue;
    /** Next heading that bounds the current section. */
    const following = entries
      .slice(index + 1)
      .find((candidate) => candidate.level <= entry.level);
    /** Exclusive end offset of the matched Markdown region. */
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
  /** Validated result returned by the current operation. */
  const result: MarkdownHeading[] = [];
  /** Active fenced-code delimiter, or null outside a fence. */
  let fence: {
    /** Backtick or tilde delimiter that opened the fenced block. */
    readonly character: string;
    /** Minimum delimiter length required to close the fenced block. */
    readonly length: number;
  } | null = null;
  /** Absolute source offset of the current Markdown line. */
  let offset = 0;
  for (const segment of markdown.match(/[^\n]*(?:\n|$)/gu) ?? []) {
    if (segment === "") continue;
    /** Current Markdown line, including its trailing newline when present. */
    const line = segment.endsWith("\n") ? segment.slice(0, -1) : segment;
    /** Fence delimiter parsed from the current Markdown line. */
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fenceMatch !== undefined) {
      /** Fence delimiter currently active while scanning Markdown. */
      const character = fenceMatch[0]!;
      if (fence === null) fence = { character, length: fenceMatch.length };
      else if (
        character === fence.character &&
        fenceMatch.length >= fence.length
      )
        fence = null;
    } else if (fence === null) {
      /** Single validated match selected after uniqueness checks. */
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

/** Parses a normalized, duplicate-free Task-section list. */
function sectionSet(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new TypeError(`Agent definition ${name} must be a string array`);
  /** Validated Task-section names in declaration order. */
  const sections = value.map((entry) => taskSectionName(entry as string));
  if (new Set(sections).size !== sections.length)
    throw new TypeError(`Agent definition ${name} must not contain duplicates`);
  return sections;
}

/** Validates and NFC-normalizes a Task-section heading. */
function taskSectionName(value: string): string {
  /** NFC-normalized value used for equality and validation. */
  const normalized = value.normalize("NFC").trim();
  if (
    normalized === "" ||
    normalized.length > 128 ||
    [...normalized].some((character) => {
      /** Machine-readable validation or provider error code. */
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) ||
    normalized.startsWith("#")
  )
    throw new TypeError("Task section name is invalid");
  return normalized;
}

/** Rejects unsupported Task-description configuration keys. */
function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  supported: readonly string[],
): void {
  /** Unsupported keys discovered at the strict input boundary. */
  const unknown = Object.keys(value).filter((key) => !supported.includes(key));
  if (unknown.length !== 0)
    throw new TypeError(
      `Agent definition taskDescription contains unsupported fields: ${unknown.join(", ")}`,
    );
}

/** Normalizes Markdown to LF line endings and NFC Unicode. */
function normalizeMarkdown(value: string): string {
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}
