/** Exposes code-review-specific names over the shared remediation-cycle state machine. */
import type { JsonObject } from "../domain/json.js";
import {
  advanceCycle,
  CycleLimitError,
  readCycleState,
  type CyclePolicy,
  type CycleState,
} from "./cycle-guard.js";

/** Names and limits used to persist one review cycle without provider-specific storage. */
export interface ReviewCyclePolicy {
  /** Task property containing the canonical finding-key JSON array. */
  readonly findingKeysProperty: string;
  /** Task property containing the SHA-256 digest of the canonical finding keys. */
  readonly findingsDigestProperty: string;
  /** Consecutive occurrence count that stops automatic remediation. */
  readonly identicalFindingSetLimit: number;
  /** Maximum number of changes-requested transitions before human resolution is required. */
  readonly maxChangesRequestedRounds: number;
  /** Task property containing the consecutive occurrence count for the current finding set. */
  readonly repeatCountProperty: string;
  /** Task property containing the completed changes-requested round count. */
  readonly roundProperty: string;
  /** Task property identifying the stage that most recently requested remediation. */
  readonly remediationSourceProperty: string;
}

/** Default Task-property contract used by the bundled Notion workflow. */
export const DEFAULT_REVIEW_CYCLE_POLICY: ReviewCyclePolicy = {
  findingKeysProperty: "Review Finding Keys",
  findingsDigestProperty: "Review Findings Digest",
  identicalFindingSetLimit: 2,
  maxChangesRequestedRounds: 3,
  repeatCountProperty: "Review Repeat Count",
  remediationSourceProperty: "Remediation Source",
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

/** Reasons that require human resolution instead of another automatic review remediation. */
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
    /** Preserves the shared state-machine failure for diagnostics. */
    cause?: unknown,
  ) {
    super(
      reason === "review_round_limit"
        ? "Code review reached the maximum automatic remediation rounds"
        : "Code review repeated the same finding set",
      { cause },
    );
  }
}

/** Decodes and validates review-cycle state from provider-visible Task properties. */
export function readReviewCycleState(
  properties: JsonObject,
  policy: ReviewCyclePolicy = DEFAULT_REVIEW_CYCLE_POLICY,
): ReviewCycleState {
  return reviewState(readCycleState(properties, sharedPolicy(policy)));
}

/** Records one distinct changes-requested result or rejects a looping review cycle. */
export function advanceReviewCycle(
  properties: JsonObject,
  findingKeys: readonly string[],
  policy: ReviewCyclePolicy = DEFAULT_REVIEW_CYCLE_POLICY,
): ReviewCycleAdvance {
  try {
    /** Advances the shared state machine using review-specific property names. */
    const advanced = advanceCycle(
      properties,
      findingKeys,
      sharedPolicy(policy),
    );
    return {
      nextProperties: advanced.nextProperties,
      state: reviewState(advanced.state),
    };
  } catch (error) {
    if (!(error instanceof CycleLimitError)) throw error;
    throw new ReviewCycleLimitError(
      error.reason === "round_limit"
        ? "review_round_limit"
        : "identical_findings_repeated",
      reviewState(error.state),
      error,
    );
  }
}

/** Maps the public review policy onto the shared remediation policy. */
function sharedPolicy(policy: ReviewCyclePolicy): CyclePolicy {
  return {
    digestProperty: policy.findingsDigestProperty,
    identicalSetLimit: policy.identicalFindingSetLimit,
    keysProperty: policy.findingKeysProperty,
    label: "Code review",
    maxRounds: policy.maxChangesRequestedRounds,
    repeatCountProperty: policy.repeatCountProperty,
    roundProperty: policy.roundProperty,
    sourceProperty: policy.remediationSourceProperty,
    sourceValue: "Review",
  };
}

/** Maps generic evidence state onto the public review vocabulary. */
function reviewState(state: CycleState): ReviewCycleState {
  return {
    findingKeys: state.keys,
    findingsDigest: state.digest,
    repeatCount: state.repeatCount,
    round: state.round,
  };
}
