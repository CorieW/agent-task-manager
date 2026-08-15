// Defines provider-persisted external-effect intents, observations, and receipts.
import type { JsonObject } from "../domain/json.js";

export type ExternalEffectState = "applied" | "failed" | "indeterminate" | "not_applied" | "pending";

export interface ExternalEffectSource {
  readonly contextDigest: string;
  readonly definitionDigest: string;
  readonly intentIndex: number;
  readonly resultDigest: string;
  readonly runId: string;
}

export interface ExternalEffectRequest {
  readonly effectId: string;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly payloadDigest: string;
  readonly source: ExternalEffectSource;
}

export interface ExternalEffectObservation {
  readonly evidence: JsonObject;
  readonly externalIdentity: JsonObject;
  readonly state: Exclude<ExternalEffectState, "pending">;
}

export interface ExternalEffectReceipt extends ExternalEffectObservation {
  readonly effectId: string;
  readonly handlerId: string;
  readonly handlerVersion: string;
  readonly schema: "external-effect-receipt-v1";
}

export interface ExternalEffectIntentRecord extends ExternalEffectRequest {
  readonly automaticReplayBlocked: boolean;
  readonly handlerId: string;
  readonly handlerVersion: string;
  readonly lastObservation: ExternalEffectObservation | null;
  readonly receipt: ExternalEffectReceipt | null;
  readonly schema: "external-effect-intent-v2";
  readonly state: ExternalEffectState;
}

export interface ExternalEffectHandler {
  readonly id: string;
  readonly kind: string;
  readonly version: string;
  apply(request: ExternalEffectRequest, control: ExternalEffectControl): Promise<ExternalEffectObservation>;
  reconcile(request: ExternalEffectRequest, control: ExternalEffectControl): Promise<ExternalEffectObservation>;
  validate(payload: JsonObject): void;
}
export interface ExternalEffectControl { readonly deadlineAt: number; readonly signal: AbortSignal; }

export interface ExternalEffectAuthorityVerifier { verify(request: ExternalEffectRequest): Promise<void>; }

export interface ExternalEffectExecution {
  readonly receipt: ExternalEffectReceipt | null;
  readonly request: ExternalEffectRequest;
  readonly state: Exclude<ExternalEffectState, "pending">;
}

export class EffectCancellationAcknowledgedError extends Error {}
export class EffectTerminationUnconfirmedError extends AggregateError {
  public readonly effectExecutionMayContinue = true;
}
