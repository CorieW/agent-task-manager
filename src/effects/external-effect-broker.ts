/** Executes authorized agent intents through crash-reconcilable provider-backed handlers. */
import { digestJson } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { AgentResult } from "../runtime/contracts.js";
import {
  EffectCancellationAcknowledgedError,
  type ExternalEffectAuthorityVerifier,
  type ExternalEffectExecution,
  type ExternalEffectHandler,
  type ExternalEffectIntentRecord,
  type ExternalEffectObservation,
  type ExternalEffectReceipt,
  type ExternalEffectRequest,
} from "./contracts.js";
import type { ProviderEffectJournal } from "./provider-effect-journal.js";
import type { ResolvedExternalEffectEnvironment } from "./effect-environment.js";
import {
  createEffectObservation,
  validateEffectObservation,
} from "./observations.js";
import { withSingleHostEffectLock } from "./single-host-effect-lock.js";

/** Signals that an external effect cannot be proven applied or not applied. */
export class IndeterminateExternalEffectError extends Error {
  /** Creates an indeterminate result for the identified effect. */
  public constructor(
    /** Stable identifier for effect id. */ public readonly effectId: string,
    /** Keeps the provider claim until expiry when execution may continue. */ public readonly retainClaimUntilExpiry = false,
    options?: ErrorOptions,
  ) {
    super(`External effect is indeterminate: ${effectId}`, options);
  }
}

/** Marks a handler that did not prove terminal cancellation within its grace period. */
class UnacknowledgedEffectCancellationError extends Error {}

/** Reconciles and executes authorized effects through a durable replay barrier. */
export class ExternalEffectBroker {
  /** Creates a broker over resolved handlers, durable journal, and authority verifier. */
  public constructor(
    /** Resolves the handler registered for each proposed effect kind. */ private readonly environment: ResolvedExternalEffectEnvironment,
    /** Persists intent, observation, claim, quarantine, and receipt state. */ private readonly journal: ProviderEffectJournal,
    /** Revalidates authority before an effect crosses the broker boundary. */ private readonly authority: ExternalEffectAuthorityVerifier,
    /** Cancellation grace in milliseconds. */ private readonly cancellationGraceMilliseconds = 5_000,
    /** Unacknowledged cancellation quarantine in milliseconds. */ private readonly unacknowledgedCancellationQuarantineMilliseconds = 86_400_000,
  ) {}

  /** Preflights every proposed intent before executing effects in proposal order. */
  public async executeResult(
    result: AgentResult,
    deadlineAt: number,
  ): Promise<readonly ExternalEffectExecution[]> {
    validateDeadline(deadlineAt);

    /** Collects materialized and authorized requests before execution begins. */
    const requests = await Promise.all(
      result.proposedIntents.map(async (proposed, intentIndex) => {
        /** Binds the proposed intent to its immutable agent-result source. */
        const request = finalizeRequest({
          kind: proposed.kind,
          payload: proposed.payload,
          source: {
            contextDigest: result.contextDigest,
            definitionDigest: result.definitionDigest,
            intentIndex,
            resultDigest: result.digest,
            runId: result.runId,
          },
        });
        /** Selects the handler whose payload contract must accept the request. */
        const handler = this.environment.handlers.get(request.kind);
        handler.validate(request.payload);
        await this.authority.verify(request);
        return request;
      }),
    );

    /** Preserves proposal order in the returned effect executions. */
    const executions: ExternalEffectExecution[] = [];
    for (const request of requests) {
      /** Stops dependent effects unless every predecessor was applied. */
      const execution = await this.execute(request, deadlineAt);
      executions.push(execution);
      if (execution.state !== "applied") break;
    }
    return executions;
  }

  /** Executes or reconciles one effect under a durable single-host claim. */
  public async execute(
    request: ExternalEffectRequest,
    deadlineAt: number,
  ): Promise<ExternalEffectExecution> {
    validateDeadline(deadlineAt);
    await this.authority.verify(request);

    /** Retains the claim across cancellation grace and quarantine windows. */
    const claimExpiresAt =
      deadlineAt +
      this.cancellationGraceMilliseconds +
      this.unacknowledgedCancellationQuarantineMilliseconds;
    return withSingleHostEffectLock(request.effectId, () =>
      this.journal.withClaim(request.effectId, claimExpiresAt, async () => {
        await this.authority.verify(request);
        return this.executeLocked(request, deadlineAt);
      }),
    );
  }

  /** Reconciles and, only when safe, applies one claimed external effect. */
  private async executeLocked(
    request: ExternalEffectRequest,
    deadlineAt: number,
  ): Promise<ExternalEffectExecution> {
    validateRequest(request);

    /** Selects and validates the handler before touching durable state. */
    const handler = this.environment.handlers.get(request.kind);
    handler.validate(request.payload);

    /** Mutable state recording durable state across reconciliation and application. */
    let record = await this.journal.read(request.effectId);
    if (record === null) {
      record = {
        ...request,
        automaticReplayBlocked: false,
        handlerId: handler.id,
        handlerVersion: handler.version,
        lastObservation: null,
        receipt: null,
        schema: "external-effect-intent-v2",
        state: "pending",
      };
      await this.journal.write(record);
    } else {
      validateStoredRequest(record, request, handler);
      if (record.receipt !== null)
        return {
          receipt: record.receipt,
          request,
          state: record.receipt.state,
        };
    }

    /** The handler's observation of any prior external application. */
    let observed: ExternalEffectObservation;
    try {
      observed = await invokeHandler(
        (control) => handler.reconcile(request, control),
        deadlineAt,
        this.cancellationGraceMilliseconds,
      );
    } catch (error) {
      /** Whether cancellation may have left reconciliation running. */
      const mayContinue = executionMayContinue(error);
      await this.pauseForUnknown(
        record,
        error,
        record.automaticReplayBlocked || mayContinue,
      );
      throw new IndeterminateExternalEffectError(request.effectId, mayContinue);
    }

    validateEffectObservation(observed);
    if (record.automaticReplayBlocked) {
      if (observed.state === "applied" || observed.state === "failed")
        return this.finalizeOrPause(record, request, observed);
      await this.journal.write({
        ...record,
        automaticReplayBlocked: true,
        lastObservation: observed,
        state: "indeterminate",
      });
      throw new IndeterminateExternalEffectError(request.effectId);
    }
    if (observed.state !== "not_applied")
      return this.finalizeOrPause(record, request, observed);

    // Persist replay quarantine before apply so a crash cannot trigger an automatic duplicate.
    record = {
      ...record,
      automaticReplayBlocked: true,
      lastObservation: observed,
    };
    await this.journal.write(record);

    /** The observation returned by the permitted apply attempt. */
    let applied: ExternalEffectObservation;
    try {
      applied = await invokeHandler(
        (control) => handler.apply(request, control),
        deadlineAt,
        this.cancellationGraceMilliseconds,
      );
    } catch (error) {
      /** Whether cancellation may have left application running. */
      const mayContinue = executionMayContinue(error);
      await this.pauseForUnknown(
        record,
        error,
        record.automaticReplayBlocked || mayContinue,
      );
      throw new IndeterminateExternalEffectError(request.effectId, mayContinue);
    }

    validateEffectObservation(applied);
    if (applied.state === "indeterminate")
      return this.finalizeOrPause(record, request, applied);
    if (applied.state === "not_applied")
      throw new Error(
        `External-effect handler returned not_applied after execution: ${handler.kind}`,
      );
    return this.finalizeOrPause(record, request, applied);
  }

  /** Persists an indeterminate observation before surfacing an unknown outcome. */
  private async pauseForUnknown(
    record: ExternalEffectIntentRecord,
    error: unknown,
    automaticReplayBlocked: boolean,
  ): Promise<void> {
    try {
      await this.journal.write({
        ...record,
        automaticReplayBlocked,
        lastObservation: createEffectObservation("indeterminate", {
          errorClass: safeErrorClass(error),
        }),
        state: "indeterminate",
      });
    } catch (persistenceError) {
      throw new IndeterminateExternalEffectError(record.effectId, true, {
        cause: new AggregateError(
          [error, persistenceError],
          "External effect and quarantine persistence are indeterminate",
        ),
      });
    }
  }

  /** Finalizes a terminal observation or durably pauses an indeterminate one. */
  private async finalizeOrPause(
    record: ExternalEffectIntentRecord,
    request: ExternalEffectRequest,
    observation: ExternalEffectObservation,
  ): Promise<ExternalEffectExecution> {
    if (observation.state === "indeterminate") {
      await this.journal.write({
        ...record,
        lastObservation: observation,
        state: "indeterminate",
      });
      throw new IndeterminateExternalEffectError(record.effectId);
    }

    /** Converts the terminal observation into a handler-bound receipt. */
    const receipt: ExternalEffectReceipt = {
      ...observation,
      effectId: record.effectId,
      handlerId: record.handlerId,
      handlerVersion: record.handlerVersion,
      schema: "external-effect-receipt-v1",
    };

    await this.journal.write({
      ...record,
      automaticReplayBlocked: false,
      lastObservation: observation,
      receipt,
      state: observation.state,
    });

    return {
      receipt,
      request: structuredClone(request),
      state: observation.state,
    };
  }
}

/** Derives canonical payload and effect identities for an effect request. */
export function finalizeRequest(
  input: Omit<ExternalEffectRequest, "effectId" | "payloadDigest">,
): ExternalEffectRequest {
  /** Binds the request identity to canonical payload content. */
  const payloadDigest = digestJson(toJsonValue(input.payload));
  /** Binds one effect to its kind, payload, and immutable source identity. */
  const effectId = digestJson(
    toJsonValue({ kind: input.kind, payloadDigest, source: input.source }),
  );
  return { ...structuredClone(input), effectId, payloadDigest };
}

/** Rejects a request whose payload or effect identity cannot be rebuilt. */
function validateRequest(request: ExternalEffectRequest): void {
  /** Rebuilds both digests from the request's semantic inputs. */
  const rebuilt = finalizeRequest({
    kind: request.kind,
    payload: request.payload,
    source: request.source,
  });
  if (
    rebuilt.effectId !== request.effectId ||
    rebuilt.payloadDigest !== request.payloadDigest
  )
    throw new Error("External-effect request digest is invalid");
}

/** Rejects durable state that conflicts with the current request or handler. */
function validateStoredRequest(
  record: ExternalEffectIntentRecord,
  request: ExternalEffectRequest,
  handler: ExternalEffectHandler,
): void {
  if (
    record.kind !== request.kind ||
    record.payloadDigest !== request.payloadDigest ||
    digestJson(toJsonValue(record.source)) !==
      digestJson(toJsonValue(request.source)) ||
    record.handlerId !== handler.id ||
    record.handlerVersion !== handler.version
  ) {
    throw new Error(
      `External-effect intent conflicts with its durable record: ${request.effectId}`,
    );
  }
}

/** Reduces an arbitrary failure to a bounded, non-sensitive class name. */
function safeErrorClass(error: unknown): string {
  return error instanceof Error && error.name !== ""
    ? error.name.slice(0, 100)
    : "UnknownError";
}

/** Returns whether failed cancellation may have left the effect running. */
function executionMayContinue(error: unknown): boolean {
  return (
    error instanceof UnacknowledgedEffectCancellationError ||
    (error !== null &&
      typeof error === "object" &&
      "effectExecutionMayContinue" in error &&
      (
        error as {
          /** Marks failures whose external operation may outlive cancellation. */ readonly effectExecutionMayContinue?: unknown;
        }
      ).effectExecutionMayContinue === true)
  );
}

/** Rejects expired, malformed, or excessively distant effect deadlines. */
function validateDeadline(deadlineAt: number): void {
  if (
    !Number.isSafeInteger(deadlineAt) ||
    deadlineAt <= Date.now() ||
    deadlineAt > Date.now() + 86_400_000
  )
    throw new TypeError("External-effect deadline is invalid");
}

/** Runs a handler under one absolute deadline and bounded cancellation grace. */
async function invokeHandler(
  operation: (control: {
    /** Canonical timestamp for deadline. */
    readonly deadlineAt: number;
    /** Cancellation signal for the operation. */
    readonly signal: AbortSignal;
  }) => Promise<ExternalEffectObservation>,
  deadlineAt: number,
  cancellationGraceMilliseconds: number,
): Promise<ExternalEffectObservation> {
  /** Owns the cancellation signal for this handler invocation. */
  const controller = new AbortController();
  /** Computes the remaining portion of the absolute deadline. */
  const remaining = deadlineAt - Date.now();
  if (remaining < 1) throw new Error("External-effect deadline exceeded");

  /** Starts the handler exactly once before racing its deadline. */
  const running = operation({ deadlineAt, signal: controller.signal });
  /** Timer for the primary deadline race. */
  let timer: NodeJS.Timeout | undefined;

  /** The handler-versus-deadline race result. */
  const deadlineResult = await Promise.race([
    running.then(
      (value) => ({ kind: "settled" as const, value }),
      (error: unknown) => ({ error, kind: "rejected" as const }),
    ),
    new Promise<{
      /** Kind callback invoked by expiration as the race outcome. */ readonly kind: "timeout";
    }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
    }),
  ]);

  if (timer !== undefined) clearTimeout(timer);
  if (deadlineResult.kind === "settled") return deadlineResult.value;
  if (deadlineResult.kind === "rejected") throw deadlineResult.error;

  controller.abort();
  /** Timer for the post-abort grace period. */
  let graceTimer: NodeJS.Timeout | undefined;

  /** The handler-versus-cancellation-grace race result. */
  const cancellationResult = await Promise.race([
    running.then(
      (value) => ({ kind: "fulfilled" as const, value }),
      (error: unknown) => ({ error, kind: "rejected" as const }),
    ),
    new Promise<{
      /** Kind callback invoked by grace-period expiration as the race outcome. */ readonly kind: "timeout";
    }>((resolve) => {
      graceTimer = setTimeout(
        () => resolve({ kind: "timeout" }),
        cancellationGraceMilliseconds,
      );
    }),
  ]);

  if (graceTimer !== undefined) clearTimeout(graceTimer);
  if (cancellationResult.kind === "timeout") {
    void running.catch(() => undefined);
    throw new UnacknowledgedEffectCancellationError(
      "External-effect cancellation was not acknowledged",
    );
  }
  if (
    cancellationResult.kind === "rejected" &&
    !(cancellationResult.error instanceof EffectCancellationAcknowledgedError)
  )
    throw new UnacknowledgedEffectCancellationError(
      "External-effect cancellation did not produce a verified terminal acknowledgement",
      { cause: cancellationResult.error },
    );
  throw new Error("External-effect deadline exceeded");
}
