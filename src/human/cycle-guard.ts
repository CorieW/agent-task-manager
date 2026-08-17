/** Implements the provider-neutral state machine shared by remediation-cycle guards. */
import { digestJson, isSha256Digest } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";

/** Provider-neutral provider property names, limits, and diagnostics for one remediation cycle contract. */
export interface CyclePolicy {
  /** Human-readable cycle name used in validation and limit errors. */
  readonly label: string;
  /** Task property containing the SHA-256 digest of the canonical evidence keys. */
  readonly digestProperty: string;
  /** Consecutive occurrence count that stops automatic remediation. */
  readonly identicalSetLimit: number;
  /** Task property containing the canonical evidence-key JSON array. */
  readonly keysProperty: string;
  /** Maximum completed failure transitions before human resolution is required. */
  readonly maxRounds: number;
  /** Task property containing the consecutive occurrence count for the current key set. */
  readonly repeatCountProperty: string;
  /** Task property containing the completed remediation-round count. */
  readonly roundProperty: string;
  /** Task property identifying the stage that most recently requested remediation. */
  readonly sourceProperty: string;
  /** Provider-visible value identifying this remediation stage. */
  readonly sourceValue: string;
}

/** Represents one validated remediation-cycle snapshot. */
export interface CycleState {
  /** Digest of the canonical evidence-key array, or null before the first failure. */
  readonly digest: string | null;
  /** Canonical sorted evidence keys from the previous failed result. */
  readonly keys: readonly string[];
  /** Consecutive occurrence count for the current evidence set. */
  readonly repeatCount: number;
  /** Number of failed transitions already recorded. */
  readonly round: number;
}

/** One successful state advancement and its replacement Task properties. */
export interface CycleAdvance {
  /** Replacement provider-visible Task properties containing the advanced state. */
  readonly nextProperties: JsonObject;
  /** Advanced immutable remediation-cycle state. */
  readonly state: CycleState;
}

/** Classifies generic remediation limits before a stage-specific wrapper maps them. */
export type CycleLimitReason = "identical_set_repeated" | "round_limit";

/** Signals that the shared state machine rejected another automatic remediation. */
export class CycleLimitError extends Error {
  /** Creates a generic cycle-limit error with the verified prior state. */
  public constructor(
    /** Machine-readable generic limit that stopped automatic routing. */
    public readonly reason: CycleLimitReason,
    /** Remediation-cycle state observed before the rejected advancement. */
    public readonly state: CycleState,
    /** Human-readable cycle name used in the diagnostic. */
    label: string,
  ) {
    super(
      reason === "round_limit"
        ? `${label} reached the maximum automatic remediation rounds`
        : `${label} repeated the same evidence set`,
    );
  }
}

/** Decodes and validates generic remediation state from provider-visible Task properties. */
export function readCycleState(
  properties: JsonObject,
  policy: CyclePolicy,
): CycleState {
  assertPolicy(policy);
  /** Reads the persisted round, defaulting only a wholly absent state to zero. */
  const round = optionalCount(
    properties[policy.roundProperty],
    policy.roundProperty,
  );
  /** Reads the persisted repeated-evidence count. */
  const repeatCount = optionalCount(
    properties[policy.repeatCountProperty],
    policy.repeatCountProperty,
  );
  /** Reads the persisted evidence digest. */
  const digest = optionalDigest(
    properties[policy.digestProperty],
    policy.digestProperty,
  );
  /** Reads and canonicalizes the persisted evidence keys. */
  const keys = optionalKeys(
    properties[policy.keysProperty],
    policy.keysProperty,
    policy.label,
  );
  /** Rebuilds the digest when prior evidence exists. */
  const rebuiltDigest =
    keys.length === 0 ? null : digestJson(toJsonValue(keys));

  if (digest !== rebuiltDigest) {
    throw new TypeError(
      `${policy.label}-cycle evidence keys do not match their digest`,
    );
  }
  if (
    (round === 0 && (repeatCount !== 0 || keys.length !== 0)) ||
    (round > 0 && (repeatCount === 0 || keys.length === 0))
  ) {
    throw new TypeError(`${policy.label}-cycle Task properties are incomplete`);
  }

  return { digest, keys, repeatCount, round };
}

/** Persists one distinct failed result or rejects a looping remediation cycle. */
export function advanceCycle(
  properties: JsonObject,
  evidenceKeys: readonly string[],
  policy: CyclePolicy,
): CycleAdvance {
  /** The verified prior remediation-cycle state. */
  const prior = readCycleState(properties, policy);
  if (prior.round >= policy.maxRounds) {
    throw new CycleLimitError("round_limit", prior, policy.label);
  }

  /** Canonicalizes evidence identities before hashing or persistence. */
  const keys = canonicalizeKeys(evidenceKeys, policy.label);
  /** Binds the exact evidence set independently of prose order. */
  const digest = digestJson(toJsonValue(keys));
  /** Counts consecutive appearances of the same complete evidence set. */
  const repeatCount = digest === prior.digest ? prior.repeatCount + 1 : 1;
  if (repeatCount >= policy.identicalSetLimit) {
    throw new CycleLimitError("identical_set_repeated", prior, policy.label);
  }

  /** Provider-neutral the advanced state persisted with the status transition contract. */
  const state: CycleState = {
    digest,
    keys,
    repeatCount,
    round: prior.round + 1,
  };
  return {
    nextProperties: {
      ...structuredClone(properties),
      [policy.digestProperty]: state.digest,
      [policy.keysProperty]: JSON.stringify(state.keys),
      [policy.repeatCountProperty]: state.repeatCount,
      [policy.roundProperty]: state.round,
      [policy.sourceProperty]: policy.sourceValue,
    },
    state,
  };
}

/** Validates generic property names and limits before reading provider-controlled state. */
function assertPolicy(policy: CyclePolicy): void {
  /** Collects the configured provider-visible property names. */
  const propertyNames = [
    policy.digestProperty,
    policy.keysProperty,
    policy.repeatCountProperty,
    policy.roundProperty,
    policy.sourceProperty,
  ];
  if (
    policy.label === "" ||
    policy.label.length > 100 ||
    policy.sourceValue === "" ||
    policy.sourceValue.length > 100 ||
    propertyNames.some((name) => name === "" || name.length > 100) ||
    new Set(propertyNames).size !== propertyNames.length
  ) {
    throw new TypeError(
      "Cycle label and property names must be distinct and bounded",
    );
  }
  if (
    !Number.isSafeInteger(policy.maxRounds) ||
    policy.maxRounds < 1 ||
    !Number.isSafeInteger(policy.identicalSetLimit) ||
    policy.identicalSetLimit < 2
  ) {
    throw new TypeError(`${policy.label}-cycle limits are invalid`);
  }
}

/** Returns a non-negative integer property, defaulting an absent value to zero. */
function optionalCount(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

/** Returns a SHA-256 property, defaulting an absent or empty value to null. */
function optionalDigest(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isSha256Digest(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest`);
  }
  return value;
}

/** Parses one persisted canonical evidence-key array. */
function optionalKeys(
  value: unknown,
  propertyLabel: string,
  cycleLabel: string,
): readonly string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new TypeError(`${propertyLabel} must be a JSON string`);
  }
  /** Parses the provider value before applying the closed evidence-key contract. */
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError(`${propertyLabel} must contain valid JSON`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${propertyLabel} must contain a JSON array`);
  }
  /** Reuses canonical validation while rejecting non-canonical persisted ordering. */
  const canonical = canonicalizeKeys(parsed, cycleLabel);
  if (JSON.stringify(parsed) !== JSON.stringify(canonical)) {
    throw new TypeError(
      `${propertyLabel} must contain canonical evidence keys`,
    );
  }
  return canonical;
}

/** Validates, deduplicates, and sorts stable evidence identities. */
function canonicalizeKeys(
  values: readonly unknown[],
  cycleLabel: string,
): readonly string[] {
  if (values.length === 0 || values.length > 100) {
    throw new TypeError(
      `${cycleLabel} evidence must contain between 1 and 100 keys`,
    );
  }
  /** Validates normalized key strings before deterministic sorting. */
  const keys = values.map((value) => {
    if (typeof value !== "string") {
      throw new TypeError(`${cycleLabel} evidence keys must be strings`);
    }
    /** Normalizes Unicode without silently changing surrounding whitespace. */
    const normalized = value.normalize("NFC");
    if (
      normalized === "" ||
      normalized.length > 512 ||
      normalized.trim() !== normalized
    ) {
      throw new TypeError(
        `${cycleLabel} evidence keys must be non-empty and bounded`,
      );
    }
    return normalized;
  });
  /** Produces the canonical set representation used for equality and hashing. */
  const canonical = [...new Set(keys)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (canonical.length !== keys.length) {
    throw new TypeError(`${cycleLabel} evidence keys must be unique`);
  }
  return canonical;
}
