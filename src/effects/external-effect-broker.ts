// Executes authorized agent intents through crash-reconcilable provider-backed handlers.
import { digestJson } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { AgentResult } from "../runtime/contracts.js";
import type { ExternalEffectAuthorityVerifier, ExternalEffectExecution, ExternalEffectHandler, ExternalEffectIntentRecord, ExternalEffectObservation, ExternalEffectReceipt, ExternalEffectRequest } from "./contracts.js";
import { ProviderEffectJournal } from "./provider-effect-journal.js";
import type { ResolvedExternalEffectEnvironment } from "./effect-environment.js";
import { createEffectObservation, validateEffectObservation } from "./observations.js";
import { withSingleHostEffectLock } from "./single-host-effect-lock.js";

export class IndeterminateExternalEffectError extends Error {
  public constructor(public readonly effectId: string) { super(`External effect is indeterminate: ${effectId}`); }
}

export class ExternalEffectBroker {
  public constructor(
    private readonly environment: ResolvedExternalEffectEnvironment,
    private readonly journal: ProviderEffectJournal,
    private readonly authority: ExternalEffectAuthorityVerifier,
  ) {}

  public async executeResult(result: AgentResult, deadlineAt: number): Promise<readonly ExternalEffectExecution[]> {
    validateDeadline(deadlineAt);
    const requests = await Promise.all(result.proposedIntents.map(async (proposed, intentIndex) => {
      const request = finalizeRequest({
        kind: proposed.kind,
        payload: proposed.payload,
        source: { contextDigest: result.contextDigest, definitionDigest: result.definitionDigest, intentIndex, resultDigest: result.digest, runId: result.runId },
      });
      const handler = this.environment.handlers.get(request.kind); handler.validate(request.payload); await this.authority.verify(request); return request;
    }));
    const executions: ExternalEffectExecution[] = [];
    for (const request of requests) executions.push(await this.execute(request, deadlineAt));
    return executions;
  }

  public async execute(request: ExternalEffectRequest, deadlineAt: number): Promise<ExternalEffectExecution> {
    validateDeadline(deadlineAt);
    await this.authority.verify(request);
    return withSingleHostEffectLock(request.effectId, () => this.journal.withClaim(request.effectId, deadlineAt, async () => { await this.authority.verify(request); return this.executeLocked(request, deadlineAt); }));
  }

  private async executeLocked(request: ExternalEffectRequest, deadlineAt: number): Promise<ExternalEffectExecution> {
    validateRequest(request);
    const handler = this.environment.handlers.get(request.kind);
    handler.validate(request.payload);
    let record = await this.journal.read(request.effectId);
    if (record === null) {
      record = {
        ...request,
        handlerId: handler.id,
        handlerVersion: handler.version,
        lastObservation: null,
        receipt: null,
        schema: "external-effect-intent-v1",
        state: "pending",
      };
      await this.journal.write(record);
    } else {
      validateStoredRequest(record, request, handler);
      if (record.receipt !== null) return { receipt: record.receipt, request, state: record.receipt.state };
    }

    let observed: ExternalEffectObservation;
    try { observed = await invokeHandler((control) => handler.reconcile(request, control), deadlineAt); }
    catch (error) { await this.pauseForUnknown(record, error); throw new IndeterminateExternalEffectError(request.effectId); }
    validateEffectObservation(observed);
    if (observed.state !== "not_applied") return this.finalizeOrPause(record, request, observed);

    let applied: ExternalEffectObservation;
    try { applied = await invokeHandler((control) => handler.apply(request, control), deadlineAt); }
    catch (error) {
      await this.pauseForUnknown(record, error);
      throw new IndeterminateExternalEffectError(request.effectId);
    }
    validateEffectObservation(applied);
    if (applied.state === "indeterminate") return this.finalizeOrPause(record, request, applied);
    if (applied.state === "not_applied") throw new Error(`External-effect handler returned not_applied after execution: ${handler.kind}`);
    return this.finalizeOrPause(record, request, applied);
  }

  private async pauseForUnknown(record: ExternalEffectIntentRecord, error: unknown): Promise<void> { await this.journal.write({ ...record, lastObservation: createEffectObservation("indeterminate", { errorClass: safeErrorClass(error) }), state: "indeterminate" }); }

  private async finalizeOrPause(record: ExternalEffectIntentRecord, request: ExternalEffectRequest, observation: ExternalEffectObservation): Promise<ExternalEffectExecution> {
    if (observation.state === "indeterminate") {
      await this.journal.write({ ...record, lastObservation: observation, state: "indeterminate" });
      throw new IndeterminateExternalEffectError(record.effectId);
    }
    const receipt: ExternalEffectReceipt = {
      ...observation,
      effectId: record.effectId,
      handlerId: record.handlerId,
      handlerVersion: record.handlerVersion,
      schema: "external-effect-receipt-v1",
    };
    await this.journal.write({ ...record, lastObservation: observation, receipt, state: observation.state });
    return { receipt, request: structuredClone(request), state: observation.state };
  }
}

export function finalizeRequest(input: Omit<ExternalEffectRequest, "effectId" | "payloadDigest">): ExternalEffectRequest {
  const payloadDigest = digestJson(toJsonValue(input.payload));
  const effectId = digestJson(toJsonValue({ kind: input.kind, payloadDigest, source: input.source }));
  return { ...structuredClone(input), effectId, payloadDigest };
}

function validateRequest(request: ExternalEffectRequest): void {
  const rebuilt = finalizeRequest({ kind: request.kind, payload: request.payload, source: request.source });
  if (rebuilt.effectId !== request.effectId || rebuilt.payloadDigest !== request.payloadDigest) throw new Error("External-effect request digest is invalid");
}
function validateStoredRequest(record: ExternalEffectIntentRecord, request: ExternalEffectRequest, handler: ExternalEffectHandler): void {
  if (record.kind !== request.kind || record.payloadDigest !== request.payloadDigest || digestJson(toJsonValue(record.source)) !== digestJson(toJsonValue(request.source)) || record.handlerId !== handler.id || record.handlerVersion !== handler.version) {
    throw new Error(`External-effect intent conflicts with its durable record: ${request.effectId}`);
  }
}
function safeErrorClass(error: unknown): string { return error instanceof Error && error.name !== "" ? error.name.slice(0, 100) : "UnknownError"; }
function validateDeadline(deadlineAt: number): void { if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now() || deadlineAt > Date.now() + 86_400_000) throw new TypeError("External-effect deadline is invalid"); }
async function invokeHandler(operation: (control: { readonly deadlineAt: number; readonly signal: AbortSignal }) => Promise<ExternalEffectObservation>, deadlineAt: number): Promise<ExternalEffectObservation> {
  const controller = new AbortController(); const remaining = deadlineAt - Date.now(); if (remaining < 1) throw new Error("External-effect deadline exceeded");
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation({ deadlineAt, signal: controller.signal }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("External-effect deadline exceeded")); }, remaining); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
