/** Strict parsing for provider-neutral Error reports. */
import type {
  ErrorSeverity,
  ErrorSource,
  ReportErrorInput,
} from "./record-types.js";

/** Strictly parses the complete payload accepted by Error reporting. */
export function parseReportErrorInput(value: unknown): ReportErrorInput {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Error input must be a JSON object");
  /** Validated input for the current boundary operation. */
  const input = value as Record<string, unknown>;
  /** Complete allowlist of accepted input field names. */
  const fields = [
    "activeAgentId",
    "agentId",
    "description",
    "errorKey",
    "resolution",
    "severity",
    "source",
    "taskId",
    "title",
  ];
  /** Unsupported keys discovered at the strict input boundary. */
  const unknown = Object.keys(input).filter((key) => !fields.includes(key));
  if (unknown.length !== 0)
    throw new TypeError(
      `Error input contains unsupported fields: ${unknown.join(", ")}`,
    );
  /** Normalized text field reader for the strict input boundary. */
  const text = (name: string, allowEmpty = false): string => {
    /** Untyped input field currently being validated. */
    const field = input[name];
    if (typeof field !== "string" || (!allowEmpty && field.trim() === ""))
      throw new TypeError(`Error input ${name} must be a string`);
    return field.normalize("NFC");
  };
  /** Strict reader for nullable provider identifiers. */
  const nullableId = (name: string): string | null => {
    /** Untyped input field currently being validated. */
    const field = input[name];
    if (field === null) return null;
    if (typeof field !== "string" || field.trim() === "")
      throw new TypeError(`Error input ${name} must be a string or null`);
    return field.normalize("NFC");
  };
  /** Operational impact assigned to the Error. */
  const severity = input.severity;
  if (
    !(["critical", "high", "medium", "low"] as const).includes(
      severity as never,
    )
  )
    throw new TypeError("Error input severity is invalid");
  /** Untrusted Error-source discriminator. */
  const source = input.source;
  if (!(["human", "ai", "system"] as const).includes(source as never))
    throw new TypeError("Error input source is invalid");
  return {
    activeAgentId: nullableId("activeAgentId"),
    agentId: nullableId("agentId"),
    description: text("description"),
    errorKey: text("errorKey"),
    resolution: text("resolution", true),
    severity: severity as ErrorSeverity,
    source: source as ErrorSource,
    taskId: nullableId("taskId"),
    title: text("title"),
  };
}
