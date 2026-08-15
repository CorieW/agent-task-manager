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

export class IndeterminateExternalEffectError extends Error {
  public constructor(
    public readonly effectId: string,
    public readonly retainClaimUntilExpiry = false,
    options?: ErrorOptions,
  ) {
    super(`External effect is indeterminate: ${effectId}`, options);
  }
}
class UnacknowledgedEffectCancellationError extends Error {}

export class ExternalEffectBroker {
  public constructor(
    private readonly environment: ResolvedExternalEffectEnvironment,
    private readonly journal: ProviderEffectJournal,
    private readonly authority: ExternalEffectAuthorityVerifier,
    private readonly cancellationGraceMilliseconds = 5_000,
    private readonly unacknowledgedCancellationQuarantineMilliseconds = 86_400_000,
  ) {}

  public async executeResult(
    result: AgentResult,
    deadlineAt: number,
  ): Promise<readonly ExternalEffectExecution[]> {
    validateDeadline(deadlineAt);
    const requests = await Promise.all(
      result.proposedIntents.map(async (proposed, intentIndex) => {
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
        const handler = this.environment.handlers.get(request.kind);
        handler.validate(request.payload);
        await this.authority.verify(request);
        return request;
      }),
    );
    const executions: ExternalEffectExecution[] = [];
    for (const request of requests)
      executions.push(await this.execute(request, deadlineAt));
    return executions;
  }

  public async execute(
    request: ExternalEffectRequest,
    deadlineAt: number,
  ): Promise<ExternalEffectExecution> {
    validateDeadline(deadlineAt);
    await this.authority.verify(request);
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

  private async executeLocked(
    request: ExternalEffectRequest,
    deadlineAt: number,
  ): Promise<ExternalEffectExecution> {
    validateRequest(request);
    const handler = this.environment.handlers.get(request.kind);
    handler.validate(request.payload);
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

    let observed: ExternalEffectObservation;
    try {
      observed = await invokeHandler(
        (control) => handler.reconcile(request, control),
        deadlineAt,
        this.cancellationGraceMilliseconds,
      );
    } catch (error) {
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
    let applied: ExternalEffectObservation;
    try {
      applied = await invokeHandler(
        (control) => handler.apply(request, control),
        deadlineAt,
        this.cancellationGraceMilliseconds,
      );
    } catch (error) {
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

export function finalizeRequest(
  input: Omit<ExternalEffectRequest, "effectId" | "payloadDigest">,
): ExternalEffectRequest {
  const payloadDigest = digestJson(toJsonValue(input.payload));
  const effectId = digestJson(
    toJsonValue({ kind: input.kind, payloadDigest, source: input.source }),
  );
  return { ...structuredClone(input), effectId, payloadDigest };
}

function validateRequest(request: ExternalEffectRequest): void {
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
function safeErrorClass(error: unknown): string {
  return error instanceof Error && error.name !== ""
    ? error.name.slice(0, 100)
    : "UnknownError";
}
function executionMayContinue(error: unknown): boolean {
  return (
    error instanceof UnacknowledgedEffectCancellationError ||
    (error !== null &&
      typeof error === "object" &&
      "effectExecutionMayContinue" in error &&
      (error as { readonly effectExecutionMayContinue?: unknown })
        .effectExecutionMayContinue === true)
  );
}
function validateDeadline(deadlineAt: number): void {
  if (
    !Number.isSafeInteger(deadlineAt) ||
    deadlineAt <= Date.now() ||
    deadlineAt > Date.now() + 86_400_000
  )
    throw new TypeError("External-effect deadline is invalid");
}
async function invokeHandler(
  operation: (control: {
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
  }) => Promise<ExternalEffectObservation>,
  deadlineAt: number,
  cancellationGraceMilliseconds: number,
): Promise<ExternalEffectObservation> {
  const controller = new AbortController();
  const remaining = deadlineAt - Date.now();
  if (remaining < 1) throw new Error("External-effect deadline exceeded");
  const running = operation({ deadlineAt, signal: controller.signal });
  let timer: NodeJS.Timeout | undefined;
  const timed = await Promise.race([
    running.then(
      (value) => ({ kind: "settled" as const, value }),
      (error: unknown) => ({ error, kind: "rejected" as const }),
    ),
    new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (timed.kind === "settled") return timed.value;
  if (timed.kind === "rejected") throw timed.error;
  controller.abort();
  let graceTimer: NodeJS.Timeout | undefined;
  const acknowledged = await Promise.race([
    running.then(
      (value) => ({ kind: "fulfilled" as const, value }),
      (error: unknown) => ({ error, kind: "rejected" as const }),
    ),
    new Promise<{ readonly kind: "timeout" }>((resolve) => {
      graceTimer = setTimeout(
        () => resolve({ kind: "timeout" }),
        cancellationGraceMilliseconds,
      );
    }),
  ]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  if (acknowledged.kind === "timeout") {
    void running.catch(() => undefined);
    throw new UnacknowledgedEffectCancellationError(
      "External-effect cancellation was not acknowledged",
    );
  }
  if (
    acknowledged.kind === "rejected" &&
    !(acknowledged.error instanceof EffectCancellationAcknowledgedError)
  )
    throw new UnacknowledgedEffectCancellationError(
      "External-effect cancellation did not produce a verified terminal acknowledgement",
      { cause: acknowledged.error },
    );
  throw new Error("External-effect deadline exceeded");
}
