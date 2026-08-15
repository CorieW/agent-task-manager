// Executes authorized agent intents through crash-reconcilable provider-backed handlers.
import { digestJson } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { AgentResult } from "../runtime/contracts.js";
import type { ExternalEffectExecution, ExternalEffectHandler, ExternalEffectIntentRecord, ExternalEffectObservation, ExternalEffectReceipt, ExternalEffectRequest } from "./contracts.js";
import { ProviderEffectJournal } from "./provider-effect-journal.js";
import { ExternalEffectHandlerRegistry } from "./registry.js";

export class IndeterminateExternalEffectError extends Error {
  public constructor(public readonly effectId: string) { super(`External effect is indeterminate: ${effectId}`); }
}

export class ExternalEffectBroker {
  public constructor(
    private readonly handlers: ExternalEffectHandlerRegistry,
    private readonly journal: ProviderEffectJournal,
  ) {}

  public async executeResult(result: AgentResult, allowedIntents: readonly string[]): Promise<readonly ExternalEffectExecution[]> {
    const allowed = new Set(allowedIntents);
    const executions: ExternalEffectExecution[] = [];
    for (const [intentIndex, proposed] of result.proposedIntents.entries()) {
      if (!allowed.has(proposed.kind)) throw new Error(`External effect is not authorized: ${proposed.kind}`);
      const request = finalizeRequest({
        kind: proposed.kind,
        payload: proposed.payload,
        source: { contextDigest: result.contextDigest, intentIndex, resultDigest: result.digest, runId: result.runId },
      });
      executions.push(await this.execute(request));
    }
    return executions;
  }

  public async execute(request: ExternalEffectRequest): Promise<ExternalEffectExecution> {
    validateRequest(request);
    const handler = this.handlers.get(request.kind);
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

    const observed = await handler.reconcile(request);
    validateObservation(observed);
    if (observed.state !== "not_applied") return this.finalizeOrPause(record, observed);

    let applied: ExternalEffectObservation;
    try { applied = await handler.apply(request); }
    catch (error) {
      await this.journal.write({ ...record, lastObservation: { evidence: { errorClass: safeErrorClass(error) }, externalIdentity: {}, state: "indeterminate" }, state: "indeterminate" });
      throw new IndeterminateExternalEffectError(request.effectId);
    }
    validateObservation(applied);
    if (applied.state === "indeterminate") return this.finalizeOrPause(record, applied);
    if (applied.state === "not_applied") throw new Error(`External-effect handler returned not_applied after execution: ${handler.kind}`);
    return this.finalizeOrPause(record, applied);
  }

  private async finalizeOrPause(record: ExternalEffectIntentRecord, observation: ExternalEffectObservation): Promise<ExternalEffectExecution> {
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
    return { receipt, request: record, state: observation.state };
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
function validateObservation(value: ExternalEffectObservation): void {
  if (!["applied", "failed", "indeterminate", "not_applied"].includes(value.state)) throw new TypeError("External-effect observation state is invalid");
  toJsonValue(value.evidence); toJsonValue(value.externalIdentity);
}
function safeErrorClass(error: unknown): string { return error instanceof Error && error.name !== "" ? error.name.slice(0, 100) : "UnknownError"; }
