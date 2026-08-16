/** Maps provider-neutral enum values to human-readable Notion select labels. */
import type { ErrorMutation, ResourceRecord } from "../../domain/records.js";
import type { TableKind } from "../../domain/provider.js";

/** Maps canonical Resource kinds to their Notion labels. */
const RESOURCE_KIND_LABELS = {
  prompt: "Prompt",
  policy: "Policy",
  "task-query": "Task Query",
  "json-schema": "JSON Schema",
  "invocation-schedule": "Invocation Schedule",
  "agent/context": "Agent / Context",
} as const satisfies Readonly<Record<string, string>>;

/** Ordered Notion labels for Resource kinds. */
export const RESOURCE_KIND_OPTIONS: readonly string[] =
  Object.values(RESOURCE_KIND_LABELS);

/** Maps Notion Resource-kind labels back to canonical values. */
const RESOURCE_KIND_BY_LABEL = invertLabelMap(RESOURCE_KIND_LABELS);

/** Maps canonical Resource states to their Notion labels. */
const RESOURCE_STATE_LABELS = {
  active: "Active",
  draft: "Draft",
  retired: "Retired",
} as const satisfies Readonly<Record<ResourceRecord["state"], string>>;

/** Ordered Notion labels for Resource lifecycle states. */
export const RESOURCE_STATE_OPTIONS: readonly string[] = Object.values(
  RESOURCE_STATE_LABELS,
);

/** Maps Notion Resource-state labels back to canonical values. */
const RESOURCE_STATE_BY_LABEL = invertLabelMap(RESOURCE_STATE_LABELS);

/** Maps canonical Error severities to their Notion labels. */
const ERROR_SEVERITY_LABELS = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
} as const satisfies Readonly<Record<ErrorMutation["severity"], string>>;

/** Ordered Notion labels for Error severities. */
export const ERROR_SEVERITY_OPTIONS: readonly string[] = Object.values(
  ERROR_SEVERITY_LABELS,
);

/** Maps Notion Error-severity labels back to canonical values. */
const ERROR_SEVERITY_BY_LABEL = invertLabelMap(ERROR_SEVERITY_LABELS);

/** Encodes a canonical Resource kind for Notion. */
export function encodeResourceKindOption(kind: string): string {
  return requiredMapping(RESOURCE_KIND_LABELS, kind, "Resource kind");
}

/** Decodes a Notion Resource-kind label. */
export function decodeResourceKindOption(label: string): string {
  return requiredMapping(RESOURCE_KIND_BY_LABEL, label, "Resource Kind option");
}

/** Encodes a canonical Resource state for Notion. */
export function encodeResourceStateOption(
  state: ResourceRecord["state"],
): string {
  return requiredMapping(RESOURCE_STATE_LABELS, state, "Resource state");
}

/** Decodes a Notion Resource-state label. */
export function decodeResourceStateOption(
  label: string,
): ResourceRecord["state"] {
  return requiredMapping(
    RESOURCE_STATE_BY_LABEL,
    label,
    "Resource State option",
  ) as ResourceRecord["state"];
}

/** Encodes a canonical Error severity for Notion. */
export function encodeErrorSeverityOption(
  severity: ErrorMutation["severity"],
): string {
  return requiredMapping(ERROR_SEVERITY_LABELS, severity, "Error severity");
}

/** Decodes a Notion Error-severity label. */
export function decodeErrorSeverityOption(
  label: string,
): ErrorMutation["severity"] {
  return requiredMapping(
    ERROR_SEVERITY_BY_LABEL,
    label,
    "Error Severity option",
  ) as ErrorMutation["severity"];
}

/** Encodes a canonical select filter for a provider-owned property. */
export function encodeSelectFilter(
  table: TableKind,
  property: string,
  value: string,
): string {
  if (table === "resources" && property === "Kind") {
    return encodeResourceKindOption(value);
  }
  if (table === "resources" && property === "State") {
    return encodeResourceStateOption(value as ResourceRecord["state"]);
  }
  if (table === "errors" && property === "Severity") {
    return encodeErrorSeverityOption(value as ErrorMutation["severity"]);
  }
  return value;
}

/** Inverts a one-to-one canonical-value-to-label map. */
function invertLabelMap(
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [value, key]),
  );
}

/** Returns an exact mapped value or rejects an unsupported option. */
function requiredMapping(
  values: Readonly<Record<string, string>>,
  key: string,
  label: string,
): string {
  /** Canonical value associated with the provider-facing option label. */
  const value = values[key];
  if (value === undefined) throw new TypeError(`${label} is invalid: ${key}`);
  return value;
}
