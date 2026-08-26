/** Pure Notion property codecs, schema payloads, and Markdown helpers. */
import { sha256 } from "../../../core/digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../../domain/json.js";
import type { ValidationIssue } from "../../../domain/provider.js";
import type { NotionTableKind } from "../notion-schema.js";
import type {
  ActiveAgentRecord,
  ErrorSource,
} from "../../../domain/records.js";
import { normalizeNotionId as normalizeId } from "../notion-id.js";
import type { NotionPropertyDescriptor } from "../notion-schema.js";

/** Builds the Notion schema payload for one canonical property. */
export function propertySchema(
  descriptor: NotionPropertyDescriptor,
  tables: Readonly<Record<NotionTableKind, string | null>>,
): JsonObject {
  if (descriptor.relation !== null) {
    /** Configured Notion data-source ID for the relation target. */
    const target = tables[descriptor.relation];
    if (target === null)
      throw new Error(`Relation target is unavailable: ${descriptor.relation}`);
    return {
      relation: {
        data_source_id: normalizeId(target),
        ...(descriptor.syncedName === undefined
          ? { single_property: {} }
          : { dual_property: { synced_property_name: descriptor.syncedName } }),
      },
    };
  }
  if (descriptor.type === "title") return { title: {} };
  if (descriptor.type === "rich_text") return { rich_text: {} };
  if (descriptor.type === "checkbox") return { checkbox: {} };
  if (descriptor.type === "number") return { number: { format: "number" } };
  if (descriptor.type === "date") return { date: {} };
  if (descriptor.type === "url") return { url: {} };
  if (descriptor.type === "people") return { people: {} };
  if (descriptor.type === "created_time") return { created_time: {} };
  if (descriptor.type === "last_edited_time") return { last_edited_time: {} };
  if (descriptor.type === "select")
    return {
      select: {
        options: descriptor.options.map((name) => ({ name })),
      },
    };
  throw new Error(`Unsupported Notion property type: ${descriptor.type}`);
}

/** Returns a concise mismatch description for one observed property contract. */
export function propertyContractMismatch(
  descriptor: NotionPropertyDescriptor,
  observed: JsonObject,
  tables: Readonly<Record<NotionTableKind, string | null>>,
): string | null {
  /** Observed property discriminator compared before type-specific details. */
  const actualType =
    typeof observed.type === "string" ? observed.type : "missing type";
  if (actualType !== descriptor.type) return actualType;
  if (descriptor.relation !== null) {
    /** Untrusted relation configuration returned by Notion. */
    const relationConfiguration = observed.relation;
    if (
      relationConfiguration === null ||
      typeof relationConfiguration !== "object" ||
      Array.isArray(relationConfiguration)
    )
      return "relation configuration is missing";
    /** Configured data-source ID required by the canonical relation. */
    const expectedTargetId = tables[descriptor.relation];
    if (expectedTargetId === null) return "relation target is unavailable";
    if (
      typeof relationConfiguration.data_source_id !== "string" ||
      normalizeId(relationConfiguration.data_source_id) !==
        normalizeId(expectedTargetId)
    )
      return "relation target differs";
    if (descriptor.syncedName === undefined) {
      /** Single-relation mode accepted for the canonical created schema. */
      const singleProperty = relationConfiguration.single_property;
      /** Whether the observed relation uses Notion's single-property mode. */
      const singleMode =
        singleProperty !== null &&
        typeof singleProperty === "object" &&
        !Array.isArray(singleProperty);
      /** Dual mode is also compatible when the manager does not own the reverse relation. */
      const dualProperty = relationConfiguration.dual_property;
      /** Whether the observed relation uses Notion's dual-property mode. */
      const dualMode =
        dualProperty !== null &&
        typeof dualProperty === "object" &&
        !Array.isArray(dualProperty);
      if (singleMode === dualMode) return "relation mode differs";
    } else {
      /** Dual-relation configuration whose synchronized name must be exact. */
      const dualProperty = relationConfiguration.dual_property;
      if (
        dualProperty === null ||
        typeof dualProperty !== "object" ||
        Array.isArray(dualProperty) ||
        dualProperty.synced_property_name !== descriptor.syncedName
      )
        return "relation synchronization differs";
    }
  }
  if (descriptor.type === "select" && descriptor.options.length > 0) {
    /** Untrusted select configuration returned by Notion. */
    const selectConfiguration = observed.select;
    if (
      selectConfiguration === null ||
      typeof selectConfiguration !== "object" ||
      Array.isArray(selectConfiguration)
    )
      return "select configuration is missing";
    /** Raw option entries whose names define the observed select vocabulary. */
    const optionEntries = selectConfiguration.options;
    if (!Array.isArray(optionEntries)) return "select options differ";
    /** Observed option names extracted without accepting malformed entries. */
    const observedOptionNames = optionEntries.flatMap((option) => {
      if (
        option !== null &&
        typeof option === "object" &&
        !Array.isArray(option) &&
        typeof option.name === "string"
      )
        return [option.name];
      return [];
    });
    /** Canonical option names sorted for order-independent comparison. */
    const canonicalOptionNames = [...descriptor.options].sort();
    if (
      observedOptionNames.length !== optionEntries.length ||
      JSON.stringify(observedOptionNames.sort()) !==
        JSON.stringify(canonicalOptionNames)
    )
      return "select options differ";
  }
  return null;
}

/** Requires the properties object from a Notion page. */
export function pageProperties(page: JsonObject): JsonObject {
  return requireJsonObject(page.properties, "Page properties");
}

/** Converts Notion property objects to provider-neutral JSON values. */
export function plainProperties(value: JsonObject): JsonObject {
  return toJsonValue(value) as JsonObject;
}

/** Reads the required identifier from a Notion page. */
export function notionPageId(page: JsonObject): string {
  return requiredString(page.id, "Page id");
}

/** Derives a stable optimistic-concurrency version. */
export function notionPageVersion(page: JsonObject): string {
  return requiredString(page.last_edited_time, "Page version");
}

/** Binds a Notion Agent revision to both metadata and its authoritative body. */
export function agentVersion(page: JsonObject, body: string): string {
  /** Provider metadata version included in the Agent version digest. */
  const metadataVersion = notionPageVersion(page);
  return sha256(`${metadataVersion.length}:${metadataVersion}${body}`);
}

/** Reports whether Notion has archived or trashed a page. */
export function archived(page: JsonObject): boolean {
  return page.archived === true || page.in_trash === true;
}

/** Decodes plain text from a Notion rich-text property. */
export function textValue(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  /** Strictly decoded rich-text property object. */
  const property = requireJsonObject(value, "Text property");
  /** Title or rich-text entries to concatenate. */
  const values =
    property.type === "title" ? property.title : property.rich_text;
  if (!Array.isArray(values)) return "";
  return values
    .map((entry) => {
      /** Rich-text fragment currently being decoded. */
      const item = requireJsonObject(entry, "Rich text");
      return typeof item.plain_text === "string" ? item.plain_text : "";
    })
    .join("");
}

/** Requires a non-empty decoded Notion text property. */
export function requiredTextValue(
  value: JsonValue | undefined,
  label: string,
): string {
  /** Decoded text checked before it enters provider-neutral records. */
  const text = textValue(value);
  if (text.trim() === "") throw new Error(`${label} is required`);
  return text;
}

/** Decodes a nullable Notion rich-text value. */
export function nullableTextValue(value: JsonValue | undefined): string | null {
  /** Normalized text field reader for the strict input boundary. */
  const text = textValue(value);
  return text === "" ? null : text;
}

/** Decodes a Notion select value. */
export function selectValue(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  /** Select object after property-shape validation. */
  const selected = requireJsonObject(value, "Select property").select;
  return selected === null || selected === undefined
    ? ""
    : requiredString(
        requireJsonObject(selected, "Select value").name,
        "Select name",
      );
}

/** Decodes normalized page IDs from a Notion relation property. */
export function relationIds(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  /** Relation property checked for Notion's inline-reference truncation marker. */
  const property = requireJsonObject(value, "Relation property");
  if (property.has_more === true)
    throw new Error("Notion relation exceeds the inline reference limit");
  /** Relation entries containing referenced page IDs. */
  const values = property.relation;
  return Array.isArray(values)
    ? values.map((entry) =>
        requiredString(
          requireJsonObject(entry, "Relation item").id,
          "Relation id",
        ),
      )
    : [];
}

/** Decodes a nullable Notion number property. */
export function numberValue(value: JsonValue | undefined): number | null {
  /** Numeric Notion property value after shape validation. */
  const number =
    value === undefined
      ? null
      : requireJsonObject(value, "Number property").number;
  return typeof number === "number" ? number : null;
}

/** Decodes a Notion checkbox property. */
export function checkboxValue(value: JsonValue | undefined): boolean {
  return (
    value !== undefined &&
    requireJsonObject(value, "Checkbox property").checkbox === true
  );
}

/** Decodes a nullable Notion date start value. */
function dateValue(value: JsonValue | undefined): string | null {
  if (value === undefined) return null;
  /** Date object after property-shape validation. */
  const selected = requireJsonObject(value, "Date property").date;
  return selected === null || selected === undefined
    ? null
    : requiredString(
        requireJsonObject(selected, "Date value").start,
        "Date start",
      );
}

/** Requires a parseable ISO timestamp from a Notion date property. */
export function requiredIsoDateValue(
  value: JsonValue | undefined,
  label: string,
): string {
  /** Timestamp decoded from the managed date property. */
  const timestamp = dateValue(value);
  if (timestamp === null || !Number.isFinite(Date.parse(timestamp)))
    throw new Error(`${label} must be a valid timestamp`);
  return timestamp;
}

/** Decodes an optional parseable ISO timestamp from a Notion date property. */
export function optionalIsoDateValue(
  value: JsonValue | undefined,
  label: string,
): string | null {
  /** Optional timestamp decoded from the managed date property. */
  const timestamp = dateValue(value);
  if (timestamp !== null && !Number.isFinite(Date.parse(timestamp)))
    throw new Error(`${label} must be a valid timestamp`);
  return timestamp;
}

/** Validates an Active Agent lifecycle status from its Notion select label. */
export function activeAgentStatus(value: string): ActiveAgentRecord["status"] {
  /** Normalized select label compared with the closed domain union. */
  const status = value.toLowerCase();
  if (
    status !== "running" &&
    status !== "failed" &&
    status !== "stale" &&
    status !== "completed" &&
    status !== "stopped"
  )
    throw new Error(`Invalid Active Agent status: ${value}`);
  return status;
}

/** Resolves an optional Active Agent relation to an inventoried Run ID. */
export function relatedRunId(
  pageId: string | null,
  runByPage: ReadonlyMap<string, string>,
  label: string,
): string | null {
  if (pageId === null) return null;
  /** Related Run ID required for a non-empty hierarchy relation. */
  const runId = runByPage.get(normalizeId(pageId));
  if (runId === undefined)
    throw new Error(`Active Agent ${label} relation is unavailable`);
  return runId;
}

/** Requires and returns a plain object at an untyped boundary. */
export function requireJsonObject(
  value: JsonValue | undefined,
  label: string,
): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new TypeError(`${label} must be an object`);
  return value;
}

/** Requires a non-empty string at a decoded Notion boundary. */
export function requiredString(
  value: JsonValue | undefined,
  label: string,
): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Returns a decoded value or throws the supplied error when it is absent. */
export function requirePresent<T>(
  value: T | null | undefined,
  message: string,
): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

/** Builds one structured workspace-validation issue. */
export function validationIssue(
  code: string,
  path: string,
  message: string,
): ValidationIssue {
  return { code, message, path };
}

/** Builds one Notion rich-text fragment. */
export function richTextPayload(value: string): JsonObject[] {
  /** Unicode-safe text fragments within Notion's per-fragment limit. */
  const fragments: string[] = [];
  /** Current Unicode-safe fragment accumulated below the provider limit. */
  let fragment = "";
  for (const character of value) {
    if (fragment.length + character.length > 2_000) {
      fragments.push(fragment);
      fragment = "";
    }
    fragment += character;
  }
  if (fragment !== "" || value === "") fragments.push(fragment);
  if (fragments.length > 100)
    throw new Error("Notion rich text exceeds 100 fragments");
  return fragments.map((content) => ({ text: { content }, type: "text" }));
}

/** Builds a Notion title-property payload. */
export function title(value: string): JsonObject {
  return { title: richTextPayload(value) };
}

/** Builds a Notion rich-text property payload. */
export function richText(value: string): JsonObject {
  return { rich_text: richTextPayload(value) };
}

/** Builds a Notion select-property payload. */
export function select(value: string): JsonObject {
  return { select: { name: value } };
}

/** Builds a Notion checkbox-property payload. */
export function checkbox(value: boolean): JsonObject {
  return { checkbox: value };
}

/** Builds a Notion relation-property payload. */
export function relation(ids: readonly string[]): JsonObject {
  return { relation: ids.map((value) => ({ id: normalizeId(value) })) };
}

/** Preserves immutable Task identity while removing reciprocal live ownership. */
export function detachedTaskProperties(taskId: string): JsonObject {
  if (taskId === "")
    throw new Error("Active Agent Task identity is unavailable");
  return { Task: relation([]), "Task ID": richText(taskId) };
}

/** Encodes an optional ISO timestamp as a Notion date property. */
export function date(value: string | null): JsonObject {
  return { date: value === null ? null : { start: value } };
}

/** Converts a normalized domain value to its Notion select label. */
export function toSelectLabel(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

/** Converts the closed Error source union to its canonical Notion option. */
export function errorSourceLabel(source: ErrorSource): string {
  return { ai: "AI", human: "Human", system: "System" }[source];
}

/** Renders the managed description and resolution sections of an Error page. */
export function errorMarkdown(description: string, resolution: string): string {
  return `## Error Description\n\n${quoteMarkdown(description)}\n\n## Error Resolution\n\n${quoteMarkdown(resolution)}\n`;
}

/** Quotes arbitrary Error text so its headings cannot escape the managed section. */
function quoteMarkdown(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Extracts a named level-two section from Markdown. */
export function markdownSection(markdown: string, heading: string): string {
  /** Pattern bounded by the next level-two heading. */
  const pattern = new RegExp(
    `(?:^|\\n)## ${heading}\\n+([\\s\\S]*?)(?=\\n## |$)`,
    "u",
  );
  /** Raw managed section, or the empty value for absent legacy content. */
  const section = pattern.exec(markdown)?.[1]?.trim() ?? "";
  /** Lines used to detect the unambiguous blockquoted representation. */
  const lines = section.split("\n");
  if (lines.every((line) => line === ">" || line.startsWith("> ")))
    return lines
      .map((line) => (line === ">" ? "" : line.slice(2)))
      .join("\n")
      .trim();
  return section;
}
