/** Exposes code-test-specific names over the shared remediation-cycle state machine. */
import type { JsonObject } from "../domain/json.js";
import {
  advanceCycle,
  CycleLimitError,
  readCycleState,
  type CyclePolicy,
  type CycleState,
} from "./cycle-guard.js";

/** Names and limits used to persist one test-remediation cycle. */
export interface TestCyclePolicy {
  /** Task property containing the canonical failure-key JSON array. */
  readonly failureKeysProperty: string;
  /** Task property containing the SHA-256 digest of the canonical failure keys. */
  readonly failuresDigestProperty: string;
  /** Consecutive occurrence count that stops automatic remediation. */
  readonly identicalFailureSetLimit: number;
  /** Maximum number of failed test transitions before human resolution is required. */
  readonly maxFailedTestRounds: number;
  /** Task property containing the consecutive occurrence count for the current failure set. */
  readonly repeatCountProperty: string;
  /** Task property containing the completed failed-test round count. */
  readonly roundProperty: string;
  /** Task property identifying the stage that most recently requested remediation. */
  readonly remediationSourceProperty: string;
}

/** Default Task-property contract used by the bundled Notion workflow. */
export const DEFAULT_TEST_CYCLE_POLICY: TestCyclePolicy = {
  failureKeysProperty: "Test Failure Keys",
  failuresDigestProperty: "Test Failures Digest",
  identicalFailureSetLimit: 2,
  maxFailedTestRounds: 3,
  repeatCountProperty: "Test Repeat Count",
  remediationSourceProperty: "Remediation Source",
  roundProperty: "Test Round",
};

/** Immutable test-cycle state decoded from one Task snapshot. */
export interface TestCycleState {
  /** Canonical sorted failure keys from the previous failed test result. */
  readonly failureKeys: readonly string[];
  /** Digest of the canonical failure-key array, or null before the first failure. */
  readonly failuresDigest: string | null;
  /** Consecutive occurrence count for the current failure set. */
  readonly repeatCount: number;
  /** Number of failed test transitions already recorded. */
  readonly round: number;
}

/** Successful test-cycle advancement and replacement Task properties. */
export interface TestCycleAdvance {
  /** Replacement provider-visible Task properties containing the advanced state. */
  readonly nextProperties: JsonObject;
  /** Advanced immutable test-cycle state. */
  readonly state: TestCycleState;
}

/** Reasons that require human resolution instead of another automatic test remediation. */
export type TestCycleLimitReason =
  "identical_failures_repeated" | "test_round_limit";

/** Signals that another automatic test-remediation transition is forbidden. */
export class TestCycleLimitError extends Error {
  /** Creates a fail-closed test-cycle limit error with the observed state. */
  public constructor(
    /** Machine-readable limit that stopped automatic routing. */
    public readonly reason: TestCycleLimitReason,
    /** Test-cycle state observed before the rejected advancement. */
    public readonly state: TestCycleState,
    /** Preserves the shared state-machine failure for diagnostics. */
    cause?: unknown,
  ) {
    super(
      reason === "test_round_limit"
        ? "Code testing reached the maximum automatic remediation rounds"
        : "Code testing repeated the same failure set",
      { cause },
    );
  }
}

/** Decodes and validates test-cycle state from provider-visible Task properties. */
export function readTestCycleState(
  properties: JsonObject,
  policy: TestCyclePolicy = DEFAULT_TEST_CYCLE_POLICY,
): TestCycleState {
  return testState(readCycleState(properties, sharedPolicy(policy)));
}

/** Records one distinct failed test result or rejects a looping test cycle. */
export function advanceTestCycle(
  properties: JsonObject,
  failureKeys: readonly string[],
  policy: TestCyclePolicy = DEFAULT_TEST_CYCLE_POLICY,
): TestCycleAdvance {
  try {
    /** Advances the shared state machine using test-specific property names. */
    const advanced = advanceCycle(
      properties,
      failureKeys,
      sharedPolicy(policy),
    );
    return {
      nextProperties: advanced.nextProperties,
      state: testState(advanced.state),
    };
  } catch (error) {
    if (!(error instanceof CycleLimitError)) throw error;
    throw new TestCycleLimitError(
      error.reason === "round_limit"
        ? "test_round_limit"
        : "identical_failures_repeated",
      testState(error.state),
      error,
    );
  }
}

/** Maps the public test policy onto the shared remediation policy. */
function sharedPolicy(policy: TestCyclePolicy): CyclePolicy {
  return {
    digestProperty: policy.failuresDigestProperty,
    identicalSetLimit: policy.identicalFailureSetLimit,
    keysProperty: policy.failureKeysProperty,
    label: "Code testing",
    maxRounds: policy.maxFailedTestRounds,
    repeatCountProperty: policy.repeatCountProperty,
    roundProperty: policy.roundProperty,
    sourceProperty: policy.remediationSourceProperty,
    sourceValue: "Test",
  };
}

/** Maps generic evidence state onto the public test vocabulary. */
function testState(state: CycleState): TestCycleState {
  return {
    failureKeys: state.keys,
    failuresDigest: state.digest,
    repeatCount: state.repeatCount,
    round: state.round,
  };
}
