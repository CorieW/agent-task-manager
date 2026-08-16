/** Tracks bounded code-review remediation rounds in provider-owned Task properties. */
import { digestJson } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";

/** Names and limits used to persist one review cycle without provider-specific storage. */
export interface ReviewCyclePolicy {
  /** Task property containing the canonical finding-key JSON array. */
  readonly findingKeysProperty: string;
  /** Task property containing the SHA-256 digest of the canonical finding keys. */
  readonly findingsDigestProperty: string;
  /** Maximum number of changes-requested transitions before human resolution is required. */
  readonly maxChangesRequestedRounds: number;
  /** Consecutive occurrence count that stops automatic remediation. */
  readonly identicalFindingSetLimit: number;
  /** Task property containing the consecutive occurrence count for the current finding set. */
  readonly repeatCountProperty: string;
  /** Task property containing the completed changes-requested round count. */
  readonly roundProperty: string;
}

/** Default Task-property contract used by the bundled Notion workflow. */
export const DEFAULT_REVIEW_CYCLE_POLICY: ReviewCyclePolicy = {
  findingKeysProperty: "Review Finding Keys",
  findingsDigestProperty: "Review Findings Digest",
  maxChangesRequestedRounds: 3,
  identicalFindingSetLimit: 2,
  repeatCountProperty: "Review Repeat Count",
  roundProperty: "Review Round",
};

/** Immutable review-cycle state decoded from one Task snapshot. */
export interface ReviewCycleState {
  /** Canonical sorted finding keys from the previous changes-requested result. */
  readonly findingKeys: readonly string[];
  /** Digest of the canonical finding-key array, or null before the first review failure. */
  readonly findingsDigest: string | null;
  /** Consecutive occurrence count for the current finding set. */
  readonly repeatCount: number;
  /** Number of changes-requested transitions already recorded. */
  readonly round: number;
}

/** Successful state advancement and replacement Task properties. */
export interface ReviewCycleAdvance {
  /** Replacement provider-visible Task properties containing the advanced state. */
  readonly nextProperties: JsonObject;
  /** Advanced immutable review-cycle state. */
  readonly state: ReviewCycleState;
}

/** Reasons that require human resolution instead of another automatic remediation round. */
export type ReviewCycleLimitReason =
  "identical_findings_repeated" | "review_round_limit";

/** Signals that another automatic code-review remediation transition is forbidden. */
export class ReviewCycleLimitError extends Error {
  /** Creates a fail-closed review-cycle limit error with the observed state. */
  public constructor(
    /** Machine-readable limit that stopped automatic routing. */
    public readonly reason: ReviewCycleLimitReason,
    /** Review-cycle state observed before the rejected advancement. */
    public readonly state: ReviewCycleState,
  ) {
    super(
      reason === "review_round_limit"
        ? "Code review reached the maximum automatic remediation rounds"
        : "Code review repeated the same finding set",
    );
  }
}

/** Decodes and validates review-cycle state from provider-visible Task properties. */
export function readReviewCycleState(
  properties: JsonObject,
  policy: ReviewCyclePolicy = DEFAULT_REVIEW_CYCLE_POLICY,
): ReviewCycleState {
  assertPolicy(policy);
  /** Reads the persisted review round, defaulting only a wholly absent state to zero. */
  const round = optionalCount(
    properties[policy.roundProperty],
    policy.roundProperty,
  );
  /** Reads the persisted repeated-finding count. */
  const repeatCount = optionalCount(
    properties[policy.repeatCountProperty],
    policy.repeatCountProperty,
  );
  /** Reads the persisted finding digest. */
  const findingsDigest = optionalDigest(
    properties[policy.findingsDigestProperty],
    policy.findingsDigestProperty,
  );
  /** Reads and canonicalizes the persisted finding keys. */
  const findingKeys = optionalFindingKeys(
    properties[policy.findingKeysProperty],
    policy.findingKeysProperty,
  );
  /** Rebuilds the digest when prior findings exist. */
  const rebuiltDigest =
    findingKeys.length === 0 ? null : digestJson(toJsonValue(findingKeys));

  if (findingsDigest !== rebuiltDigest) {
    throw new TypeError("Review-cycle finding keys do not match their digest");
  }
  if (
    (round === 0 && (repeatCount !== 0 || findingKeys.length !== 0)) ||
    (round > 0 && (repeatCount === 0 || findingKeys.length === 0))
  ) {
    throw new TypeError("Review-cycle Task properties are incomplete");
  }

  return { findingKeys, findingsDigest, repeatCount, round };
}

/** Records one distinct changes-requested result or rejects a looping review cycle. */
export function advanceReviewCycle(
  properties: JsonObject,
  findingKeys: readonly string[],
  policy: ReviewCyclePolicy = DEFAULT_REVIEW_CYCLE_POLICY,
): ReviewCycleAdvance {
  /** Captures the verified prior review-cycle state. */
  const prior = readReviewCycleState(properties, policy);
  if (prior.round >= policy.maxChangesRequestedRounds) {
    throw new ReviewCycleLimitError("review_round_limit", prior);
  }

  /** Canonicalizes the confirmed finding identities before hashing or persistence. */
  const canonicalFindingKeys = canonicalizeFindingKeys(findingKeys);
  /** Binds the exact confirmed finding set independently of prose order. */
  const findingsDigest = digestJson(toJsonValue(canonicalFindingKeys));
  /** Counts consecutive appearances of the same complete finding set. */
  const repeatCount =
    findingsDigest === prior.findingsDigest ? prior.repeatCount + 1 : 1;
  if (repeatCount >= policy.identicalFindingSetLimit) {
    throw new ReviewCycleLimitError("identical_findings_repeated", prior);
  }

  /** Defines the advanced review-cycle state persisted with the status transition. */
  const state: ReviewCycleState = {
    findingKeys: canonicalFindingKeys,
    findingsDigest,
    repeatCount,
    round: prior.round + 1,
  };
  return {
    nextProperties: {
      ...structuredClone(properties),
      [policy.findingKeysProperty]: JSON.stringify(state.findingKeys),
      [policy.findingsDigestProperty]: state.findingsDigest,
      [policy.repeatCountProperty]: state.repeatCount,
      [policy.roundProperty]: state.round,
    },
    state,
  };
}

/** Validates policy names and limits before reading provider-controlled properties. */
function assertPolicy(policy: ReviewCyclePolicy): void {
  /** Collects the configured provider-visible property names. */
  const propertyNames = [
    policy.findingKeysProperty,
    policy.findingsDigestProperty,
    policy.repeatCountProperty,
    policy.roundProperty,
  ];
  if (
    propertyNames.some((name) => name === "" || name.length > 100) ||
    new Set(propertyNames).size !== propertyNames.length
  ) {
    throw new TypeError(
      "Review-cycle property names must be distinct and bounded",
    );
  }
  if (
    !Number.isSafeInteger(policy.maxChangesRequestedRounds) ||
    policy.maxChangesRequestedRounds < 1 ||
    !Number.isSafeInteger(policy.identicalFindingSetLimit) ||
    policy.identicalFindingSetLimit < 2
  ) {
    throw new TypeError("Review-cycle limits are invalid");
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
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest`);
  }
  return value;
}

/** Parses one persisted canonical finding-key array. */
function optionalFindingKeys(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a JSON string`);
  }
  /** Parses the provider value before applying the closed finding-key contract. */
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError(`${label} must contain valid JSON`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${label} must contain a JSON array`);
  }
  /** Reuses canonical validation while rejecting non-canonical persisted ordering. */
  const canonical = canonicalizeFindingKeys(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(canonical)) {
    throw new TypeError(`${label} must contain canonical finding keys`);
  }
  return canonical;
}

/** Validates, deduplicates, and sorts stable finding identities. */
function canonicalizeFindingKeys(
  values: readonly unknown[],
): readonly string[] {
  if (values.length === 0 || values.length > 100) {
    throw new TypeError("Review findings must contain between 1 and 100 keys");
  }
  /** Validates normalized key strings before deterministic sorting. */
  const keys = values.map((value) => {
    if (typeof value !== "string") {
      throw new TypeError("Review finding keys must be strings");
    }
    /** Normalizes Unicode without silently changing surrounding whitespace. */
    const normalized = value.normalize("NFC");
    if (
      normalized === "" ||
      normalized.length > 512 ||
      normalized.trim() !== normalized
    ) {
      throw new TypeError("Review finding keys must be non-empty and bounded");
    }
    return normalized;
  });
  /** Produces the canonical set representation used for equality and hashing. */
  const canonical = [...new Set(keys)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (canonical.length !== keys.length) {
    throw new TypeError("Review finding keys must be unique");
  }
  return canonical;
}
