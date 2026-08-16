/** Renders, parses, and verifies the only human-editable Task-body slot format. */
import { canonicalize } from "../core/canonical-json.js";
import { digestJson } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type {
  HumanAuthority,
  HumanInteractionSlot,
  HumanSlotKind,
  HumanSlotResponse,
} from "./contracts.js";

/** Stores slot fields used by the current operation. */
const SLOT_FIELDS = [
  "createdAt",
  "generation",
  "kind",
  "prompt",
  "requestedBy",
  "response",
  "routes",
  "schema",
  "slotId",
  "sourceErrorKey",
  "taskId",
] as const;
/** Stores slot token used by the current operation. */
const SLOT_TOKEN = "<!-- agent-task-manager:human-slot:";
/** Stores slot pattern used by the current operation. */
const SLOT_PATTERN =
  /<!-- agent-task-manager:human-slot:([a-f0-9]{64}):start -->\n```json\n([\s\S]*?)\n```\n<!-- agent-task-manager:human-slot:\1:end -->/gu;
/** Tracks unique kinds values. */
const KINDS = new Set<HumanSlotKind>([
  "answer",
  "resolution",
  "review",
  "testing",
]);

/** Defines the new human interaction slot data shape. */
export type NewHumanInteractionSlot = Omit<
  HumanInteractionSlot,
  "response" | "schema" | "slotId"
>;

/** Creates human interaction slot after validating its inputs. */
export function createHumanInteractionSlot(
  input: NewHumanInteractionSlot,
): HumanInteractionSlot {
  /** Collects the canonical fields used to compute the record digest. */
  const core = normalizeCore(input);
  /** Stores slot id used by create human interaction slot. */
  const slotId = digestJson(toJsonValue(core));
  return {
    ...core,
    response: null,
    schema: "human-interaction-slot-v1",
    slotId,
  };
}

/** Renders human interaction slot in its canonical text form. */
export function renderHumanInteractionSlot(slot: HumanInteractionSlot): string {
  /** Stores checked used by render human interaction slot. */
  const checked = parseHumanInteractionSlot(toJsonValue(slot), slot.slotId);
  return `<!-- agent-task-manager:human-slot:${checked.slotId}:start -->\n\`\`\`json\n${JSON.stringify(checked, null, 2)}\n\`\`\`\n<!-- agent-task-manager:human-slot:${checked.slotId}:end -->`;
}

/** Appends one canonical human-interaction slot while preserving existing body text. */
export function appendHumanInteractionSlot(
  body: string,
  slot: HumanInteractionSlot,
): string {
  /** Stores normalized used by append human interaction slot. */
  const normalized = normalizeText(body);
  /** Stores existing used by append human interaction slot. */
  const existing = parseHumanInteractionSlots(normalized).find(
    (candidate) => candidate.slotId === slot.slotId,
  );
  if (existing !== undefined) {
    if (canonicalize(toJsonValue(existing)) !== canonicalize(toJsonValue(slot)))
      throw new Error(
        `Human interaction slot conflicts with Task body: ${slot.slotId}`,
      );
    return normalized;
  }
  /** Stores rendered used by append human interaction slot. */
  const rendered = renderHumanInteractionSlot(slot);
  return normalized === ""
    ? rendered
    : `${normalized.replace(/\n+$/u, "")}\n\n${rendered}`;
}

/** Parses and validates human interaction slots. */
export function parseHumanInteractionSlots(
  body: string,
): readonly HumanInteractionSlot[] {
  /** Stores normalized used by parse human interaction slots. */
  const normalized = normalizeText(body);
  /** Stores slots used by parse human interaction slots. */
  const slots: HumanInteractionSlot[] = [];
  /** Stores match used by parse human interaction slots. */
  let match: RegExpExecArray | null;
  SLOT_PATTERN.lastIndex = 0;
  while ((match = SLOT_PATTERN.exec(normalized)) !== null)
    slots.push(
      parseHumanInteractionSlot(
        JSON.parse(required(match[2], "Human slot body")) as unknown,
        required(match[1], "Human slot marker"),
      ),
    );
  /** Stores token count used by parse human interaction slots. */
  const tokenCount = normalized.split(SLOT_TOKEN).length - 1;
  if (tokenCount !== slots.length * 2)
    throw new TypeError(
      "Task body contains an incomplete or malformed human interaction marker",
    );
  if (new Set(slots.map((slot) => slot.slotId)).size !== slots.length)
    throw new TypeError("Task body contains duplicate human interaction slots");
  return slots;
}

/** Verifies allowed human delta against authoritative state. */
export function verifyAllowedHumanDelta(
  baseline: HumanInteractionSlot,
  edited: HumanInteractionSlot,
): HumanAuthority {
  /** Stores checked baseline used by verify allowed human delta. */
  const checkedBaseline = parseHumanInteractionSlot(
    toJsonValue(baseline),
    baseline.slotId,
  );
  /** Stores checked edited used by verify allowed human delta. */
  const checkedEdited = parseHumanInteractionSlot(
    toJsonValue(edited),
    baseline.slotId,
  );
  if (checkedBaseline.response !== null)
    throw new Error("Human interaction baseline already contains a response");
  if (checkedEdited.response === null)
    throw new Error("Human interaction response is blank");
  if (
    canonicalize(toJsonValue(machineProjection(checkedBaseline))) !==
    canonicalize(toJsonValue(machineProjection(checkedEdited)))
  )
    throw new Error("Human edited machine-owned slot content");
  if (!Object.hasOwn(checkedEdited.routes, checkedEdited.response.action))
    throw new Error(
      `Human response action is not allowed: ${checkedEdited.response.action}`,
    );
  /** Stores target status used by verify allowed human delta. */
  const targetStatus = checkedEdited.routes[checkedEdited.response.action];
  if (typeof targetStatus !== "string")
    throw new Error(
      `Human response action is not allowed: ${checkedEdited.response.action}`,
    );
  return {
    action: checkedEdited.response.action,
    responseDigest: digestJson(toJsonValue(checkedEdited.response)),
    schema: "human-authority-v1",
    slotId: checkedEdited.slotId,
    targetStatus,
    text: checkedEdited.response.text,
  };
}

/** Parses and validates human interaction slot. */
export function parseHumanInteractionSlot(
  value: unknown,
  expectedSlotId: string | null = null,
): HumanInteractionSlot {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Human interaction slot must be an object");
  /** Holds the parsed value being validated by parse human interaction slot. */
  const found = value as Record<string, unknown>;
  closed(found, SLOT_FIELDS);
  /** Stores marker id used by parse human interaction slot. */
  const markerId =
    expectedSlotId ?? (typeof found.slotId === "string" ? found.slotId : "");
  if (
    found.schema !== "human-interaction-slot-v1" ||
    found.slotId !== markerId ||
    !isSha256Digest(markerId)
  )
    throw new TypeError("Human interaction slot identity is invalid");
  /** Collects the canonical fields used to compute the record digest. */
  const core = normalizeCore({
    createdAt: text(found.createdAt, "createdAt", 100),
    generation: integer(found.generation, "generation"),
    kind: kind(found.kind),
    prompt: text(found.prompt, "prompt", 10_000),
    requestedBy: text(found.requestedBy, "requestedBy", 200),
    routes: routes(found.routes),
    sourceErrorKey: nullableText(found.sourceErrorKey, "sourceErrorKey", 500),
    taskId: text(found.taskId, "taskId", 500),
  });
  if (digestJson(toJsonValue(core)) !== markerId)
    throw new TypeError("Human interaction slot digest is invalid");
  return {
    ...core,
    response: response(found.response),
    schema: "human-interaction-slot-v1",
    slotId: markerId,
  };
}

/** Normalizes the value into its canonical boundary representation. */
function normalizeCore(
  input: NewHumanInteractionSlot,
): NewHumanInteractionSlot {
  return {
    createdAt: iso(input.createdAt),
    generation: integer(input.generation, "generation"),
    kind: kind(input.kind),
    prompt: text(input.prompt, "prompt", 10_000),
    requestedBy: text(input.requestedBy, "requestedBy", 200),
    routes: routes(input.routes),
    sourceErrorKey: nullableText(input.sourceErrorKey, "sourceErrorKey", 500),
    taskId: text(input.taskId, "taskId", 500),
  };
}
/** Projects only the machine-owned fields used for delta verification. */
function machineProjection(
  slot: HumanInteractionSlot,
): Omit<HumanInteractionSlot, "response"> {
  /** Groups the response and machine values used by machine projection. */
  const { response: _response, ...machine } = slot;
  return machine;
}
/** Validates and returns an optional human-slot response. */
function response(value: unknown): HumanSlotResponse | null {
  if (value === null) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Human response must be an object or null");
  /** Holds the parsed value being validated by response. */
  const found = value as Record<string, unknown>;
  closed(found, ["action", "text"]);
  return {
    action: text(found.action, "response.action", 100),
    text: text(found.text, "response.text", 10_000),
  };
}
/** Validates response routes as a non-empty map of unique statuses. */
function routes(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Human routes must be an object");
  /** Stores entries used by routes. */
  const entries = Object.entries(value as Record<string, unknown>)
    .map(
      ([action, status]) =>
        [
          text(action, "route action", 100),
          text(status, "route status", 200),
        ] as const,
    )
    .sort(([left], [right]) => left.localeCompare(right));
  if (
    entries.length === 0 ||
    new Set(entries.map(([action]) => action)).size !== entries.length
  )
    throw new TypeError("Human routes must be non-empty and unique");
  return Object.fromEntries(entries);
}
/** Rejects objects whose keys differ from the expected closed shape. */
function closed(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0"))
    throw new TypeError(
      "Human interaction object has unexpected or missing fields",
    );
}
/** Returns whether a value is a lowercase SHA-256 digest. */
function isSha256Digest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
/** Validates and returns a positive integer. */
function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new TypeError(`${field} must be a positive integer`);
  return value as number;
}
/** Validates and returns a canonical UTC ISO timestamp. */
function iso(value: string): string {
  /** Stores normalized used by iso. */
  const normalized = text(value, "createdAt", 100);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalized) ||
    Number.isNaN(Date.parse(normalized))
  )
    throw new TypeError("createdAt must be canonical UTC ISO time");
  return normalized;
}
/** Validates and returns a supported human-slot kind. */
function kind(value: unknown): HumanSlotKind {
  if (typeof value !== "string" || !KINDS.has(value as HumanSlotKind))
    throw new TypeError("Human interaction kind is invalid");
  return value as HumanSlotKind;
}
/** Validates bounded text while preserving null. */
function nullableText(
  value: unknown,
  field: string,
  maximum: number,
): string | null {
  return value === null ? null : text(value, field, maximum);
}
/** Validates and normalizes a bounded text value. */
function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string")
    throw new TypeError(`${field} must be a string`);
  /** Stores normalized used by text. */
  const normalized = normalizeText(value).trim();
  if (normalized === "" || Buffer.byteLength(normalized, "utf8") > maximum)
    throw new TypeError(`${field} is blank or too large`);
  return normalized;
}
/** Normalizes the value into its canonical boundary representation. */
function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}
/** Returns d or throws when invalid or absent. */
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new TypeError(`${label} is missing`);
  return value;
}
