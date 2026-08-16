/** Maps provider-neutral enum values to human-readable Notion select labels. */
import type { ErrorMutation, ResourceRecord } from "../../domain/records.js";
import type { TableKind } from "../../domain/provider.js";

/** Ordered Notion labels for Resource kinds. */
export const RESOURCE_KIND_OPTIONS = [
  "Prompt",
  "Policy",
  "Task Query",
  "JSON Schema",
  "Invocation Schedule",
  "System / Bootstrap",
  "System / Schema",
  "System / Workspace Step",
  "System / Environment Patch",
  "System / Bootstrap Session",
  "System / Human Interaction Slot",
  "System / Human Consumption",
  "System / External Effect Intent",
  "System / Child Agent Node Intent",
  "System / Workspace Ownership",
  "System / Lease",
  "System / Intent",
  "System / Assignment Intent",
  "System / Assignment Budget",
] as const;

/** Ordered Notion labels for Resource lifecycle states. */
export const RESOURCE_STATE_OPTIONS = ["Active", "Draft", "Retired"] as const;

/** Ordered Notion labels for Error severities. */
export const ERROR_SEVERITY_OPTIONS = [
  "Critical",
  "High",
  "Medium",
  "Low",
] as const;

/** Maps canonical Resource kinds to their Notion labels. */
const RESOURCE_KIND_LABELS: Readonly<Record<string, string>> = {
  prompt: "Prompt",
  policy: "Policy",
  "task-query": "Task Query",
  "json-schema": "JSON Schema",
  "invocation-schedule": "Invocation Schedule",
  "system/bootstrap": "System / Bootstrap",
  "system/schema": "System / Schema",
  "system/workspace-step": "System / Workspace Step",
  "system/environment-patch": "System / Environment Patch",
  "system/bootstrap-session": "System / Bootstrap Session",
  "system/human-interaction-slot": "System / Human Interaction Slot",
  "system/human-consumption": "System / Human Consumption",
  "system/external-effect-intent": "System / External Effect Intent",
  "system/child-agent-node-intent": "System / Child Agent Node Intent",
  "system/workspace-ownership": "System / Workspace Ownership",
  "system/lease": "System / Lease",
  "system/intent": "System / Intent",
  "system/assignment-intent": "System / Assignment Intent",
  "system/assignment-budget": "System / Assignment Budget",
};

/** Maps Notion Resource-kind labels back to canonical values. */
const RESOURCE_KINDS = reverse(RESOURCE_KIND_LABELS);

/** Maps canonical Resource states to their Notion labels. */
const RESOURCE_STATE_LABELS: Readonly<Record<ResourceRecord["state"], string>> =
  {
    active: "Active",
    draft: "Draft",
    retired: "Retired",
  };

/** Maps Notion Resource-state labels back to canonical values. */
const RESOURCE_STATES = reverse(RESOURCE_STATE_LABELS);

/** Maps canonical Error severities to their Notion labels. */
const ERROR_SEVERITY_LABELS: Readonly<
  Record<ErrorMutation["severity"], string>
> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Maps Notion Error-severity labels back to canonical values. */
const ERROR_SEVERITIES = reverse(ERROR_SEVERITY_LABELS);

/** Encodes a canonical Resource kind for Notion. */
export function encodeResourceKindOption(kind: string): string {
  return requiredMapping(RESOURCE_KIND_LABELS, kind, "Resource kind");
}

/** Decodes a Notion Resource-kind label. */
export function decodeResourceKindOption(label: string): string {
  return requiredMapping(RESOURCE_KINDS, label, "Resource Kind option");
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
    RESOURCE_STATES,
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
    ERROR_SEVERITIES,
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

/** Reverses a one-to-one string map. */
function reverse(
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
  const value = values[key];
  if (value === undefined) throw new TypeError(`${label} is invalid: ${key}`);
  return value;
}
