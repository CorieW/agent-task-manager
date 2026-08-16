/** Provider-neutral provider-persisted external-effect intents, observations, and receipts contract. */
import type { JsonObject } from "../domain/json.js";

/** Enumerates the supported external effect state variants. */
export type ExternalEffectState =
  "applied" | "failed" | "indeterminate" | "not_applied" | "pending";

/** Canonical external effect source representation. */
export interface ExternalEffectSource {
  /** SHA-256 digest of canonical context. */
  readonly contextDigest: string;
  /** SHA-256 digest of canonical definition. */
  readonly definitionDigest: string;
  /** Intent index dependency consumed by external effect source. */
  readonly intentIndex: number;
  /** SHA-256 digest of canonical result. */
  readonly resultDigest: string;
  /** Stable identifier for run id. */
  readonly runId: string;
}

/** Inputs accepted by external effect. */
export interface ExternalEffectRequest {
  /** Stable identifier for effect id. */
  readonly effectId: string;
  /** Discriminates the kind variant. */
  readonly kind: string;
  /** Validated effect payload. */
  readonly payload: JsonObject;
  /** SHA-256 digest of canonical payload. */
  readonly payloadDigest: string;
  /** Definition and intent indexes that identify the effect origin. */
  readonly source: ExternalEffectSource;
}

/** Canonical external effect observation representation. */
export interface ExternalEffectObservation {
  /** Canonical evidence used to verify the observed effect. */
  readonly evidence: JsonObject;
  /** Provider identity used to correlate the external effect. */
  readonly externalIdentity: JsonObject;
  /** Lifecycle state used for workflow decisions. */
  readonly state: Exclude<ExternalEffectState, "pending">;
}

/** Durable receipt returned by external effect. */
export interface ExternalEffectReceipt extends ExternalEffectObservation {
  /** Stable identifier for effect id. */
  readonly effectId: string;
  /** Stable identifier for handler id. */
  readonly handlerId: string;
  /** Opaque version token for handler. */
  readonly handlerVersion: string;
  /** Version tag for the external effect receipt representation. */
  readonly schema: "external-effect-receipt-v1";
}

/** Persisted state for external effect intent. */
export interface ExternalEffectIntentRecord extends ExternalEffectRequest {
  /** Indicates whether automatic replay blocked. */
  readonly automaticReplayBlocked: boolean;
  /** Stable identifier for handler id. */
  readonly handlerId: string;
  /** Opaque version token for handler. */
  readonly handlerVersion: string;
  /** Most recent durable observation, or null before reconciliation. */
  readonly lastObservation: ExternalEffectObservation | null;
  /** Applied-effect receipt, or null until mutation succeeds. */
  readonly receipt: ExternalEffectReceipt | null;
  /** Version tag for the external effect intent record representation. */
  readonly schema: "external-effect-intent-v2";
  /** Lifecycle state used for workflow decisions. */
  readonly state: ExternalEffectState;
}

/** Provider-neutral external effect handler contract. */
export interface ExternalEffectHandler {
  /** Stable identifier for external effect handler. */
  readonly id: string;
  /** Discriminates the kind variant. */
  readonly kind: string;
  /** Opaque version token used for compatibility checks. */
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

/** Canonical external effect control representation. */
export interface ExternalEffectControl {
  /** Canonical timestamp for deadline. */
  readonly deadlineAt: number;
  /** Cancellation signal for the operation. */
  readonly signal: AbortSignal;
}

/** External effect authority verifier boundary. */
export interface ExternalEffectAuthorityVerifier {
  /** Verifies that the request still has live execution authority. */
  verify(request: ExternalEffectRequest): Promise<void>;
}

/** Canonical external effect execution representation. */
export interface ExternalEffectExecution {
  /** Applied-effect receipt, or null until mutation succeeds. */
  readonly receipt: ExternalEffectReceipt | null;
  /** Request dependency consumed by external effect execution. */
  readonly request: ExternalEffectRequest;
  /** Lifecycle state used for workflow decisions. */
  readonly state: Exclude<ExternalEffectState, "pending">;
}

/** Represents a effect cancellation acknowledged failure. */
export class EffectCancellationAcknowledgedError extends Error {}

/** Represents a effect termination unconfirmed failure. */
export class EffectTerminationUnconfirmedError extends AggregateError {
  /** Effect execution may continue dependency consumed by effect termination unconfirmed error. */
  public readonly effectExecutionMayContinue = true;
}
