/** Defines provider-persisted external-effect intents, observations, and receipts. */
import type { JsonObject } from "../domain/json.js";

/** Enumerates the supported external effect state variants. */
export type ExternalEffectState =
  "applied" | "failed" | "indeterminate" | "not_applied" | "pending";

/** Defines the data and behavior required by external effect source. */
export interface ExternalEffectSource {
  /** Stores the SHA-256 digest of context. */
  readonly contextDigest: string;
  /** Stores the SHA-256 digest of definition. */
  readonly definitionDigest: string;
  /** Provides intent index to external effect source. */
  readonly intentIndex: number;
  /** Stores the SHA-256 digest of result. */
  readonly resultDigest: string;
  /** Identifies run. */
  readonly runId: string;
}

/** Defines the data and behavior required by external effect request. */
export interface ExternalEffectRequest {
  /** Identifies effect. */
  readonly effectId: string;
  /** Discriminates the kind variant. */
  readonly kind: string;
  /** Provides payload to external effect request. */
  readonly payload: JsonObject;
  /** Stores the SHA-256 digest of payload. */
  readonly payloadDigest: string;
  /** Provides source to external effect request. */
  readonly source: ExternalEffectSource;
}

/** Defines the data and behavior required by external effect observation. */
export interface ExternalEffectObservation {
  /** Provides evidence to external effect observation. */
  readonly evidence: JsonObject;
  /** Provides external identity to external effect observation. */
  readonly externalIdentity: JsonObject;
  /** Records the current state for workflow decisions. */
  readonly state: Exclude<ExternalEffectState, "pending">;
}

/** Defines the data and behavior required by external effect receipt. */
export interface ExternalEffectReceipt extends ExternalEffectObservation {
  /** Identifies effect. */
  readonly effectId: string;
  /** Identifies handler. */
  readonly handlerId: string;
  /** Records the handler version used for compatibility checks. */
  readonly handlerVersion: string;
  /** Version tag for the external effect receipt representation. */
  readonly schema: "external-effect-receipt-v1";
}

/** Defines the data and behavior required by external effect intent record. */
export interface ExternalEffectIntentRecord extends ExternalEffectRequest {
  /** Indicates whether automatic replay blocked. */
  readonly automaticReplayBlocked: boolean;
  /** Identifies handler. */
  readonly handlerId: string;
  /** Records the handler version used for compatibility checks. */
  readonly handlerVersion: string;
  /** Provides last observation to external effect intent record. */
  readonly lastObservation: ExternalEffectObservation | null;
  /** Provides receipt to external effect intent record. */
  readonly receipt: ExternalEffectReceipt | null;
  /** Version tag for the external effect intent record representation. */
  readonly schema: "external-effect-intent-v2";
  /** Records the current state for workflow decisions. */
  readonly state: ExternalEffectState;
}

/** Defines the data and behavior required by external effect handler. */
export interface ExternalEffectHandler {
  /** Provides id to external effect handler. */
  readonly id: string;
  /** Discriminates the kind variant. */
  readonly kind: string;
  /** Records the version used for compatibility checks. */
  readonly version: string;
  /** Applies the requested external effect. */
  apply(
    request: ExternalEffectRequest,
    control: ExternalEffectControl,
  ): Promise<ExternalEffectObservation>;
  /** Reconciles previously observed external effect state. */
  reconcile(
    request: ExternalEffectRequest,
    control: ExternalEffectControl,
  ): Promise<ExternalEffectObservation>;
  /** Validates the supplied payload against this handler contract. */
  validate(payload: JsonObject): void;
}
/** Defines the data and behavior required by external effect control. */
export interface ExternalEffectControl {
  /** Records the canonical timestamp for deadline. */
  readonly deadlineAt: number;
  /** Provides signal to external effect control. */
  readonly signal: AbortSignal;
}

/** Defines the data and behavior required by external effect authority verifier. */
export interface ExternalEffectAuthorityVerifier {
  /** Verifies that the request still has live execution authority. */
  verify(request: ExternalEffectRequest): Promise<void>;
}

/** Defines the data and behavior required by external effect execution. */
export interface ExternalEffectExecution {
  /** Provides receipt to external effect execution. */
  readonly receipt: ExternalEffectReceipt | null;
  /** Provides request to external effect execution. */
  readonly request: ExternalEffectRequest;
  /** Records the current state for workflow decisions. */
  readonly state: Exclude<ExternalEffectState, "pending">;
}

/** Represents a effect cancellation acknowledged failure. */
export class EffectCancellationAcknowledgedError extends Error {}
/** Represents a effect termination unconfirmed failure. */
export class EffectTerminationUnconfirmedError extends AggregateError {
  /** Provides effect execution may continue to effect termination unconfirmed error. */
  public readonly effectExecutionMayContinue = true;
}
