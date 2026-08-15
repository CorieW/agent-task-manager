/** Stores complete external-effect intents and receipts in provider Resources. */
import { canonicalize } from "../core/canonical-json.js";
import { randomUUID } from "node:crypto";
import { sha256 } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ResourceRecord } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { ExternalEffectIntentRecord } from "./contracts.js";

const EFFECT_RESOURCE_VERSION = "v2";

export class ProviderEffectJournal {
  public constructor(private readonly provider: AgentTaskProvider) {}

  public async read(effectId: string): Promise<ExternalEffectIntentRecord | null> {
    const resource = await this.provider.getOptionalResource(effectResourceKey(effectId));
    if (resource === null) return null;
    validateResource(resource, effectId);
    return parseIntent(resource.body);
  }

  public async write(record: ExternalEffectIntentRecord): Promise<void> {
    validateIntent(record);
    const body = canonicalize(toJsonValue(record));
    await this.provider.putResource({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: `external-effect:${record.effectId}:${sha256(body)}`,
      key: effectResourceKey(record.effectId),
      kind: "system/external-effect-intent",
      state: "active",
      version: EFFECT_RESOURCE_VERSION,
    });
    const verified = await this.read(record.effectId);
    if (verified === null || canonicalize(toJsonValue(verified)) !== body) throw new Error(`External-effect journal verification failed: ${record.effectId}`);
  }

  public async withClaim<T>(effectId: string, claimExpiresAt: number, operation: () => Promise<T>): Promise<T> {
    const ownerId = `external-effect:${randomUUID()}`;
    const acquired = await this.provider.acquireLease({ expiresAt: new Date(claimExpiresAt).toISOString(), idempotencyKey: `external-effect-claim:${effectId}:${ownerId}`, ownerId, scope: "task_assignment", subAgentId: "system/external-effect-broker", taskId: `system/external-effect/${effectId}` });
    if (!acquired.acquired || acquired.leaseId === null) throw new Error(`External effect is already claimed: ${effectId}`);
    let retainUntilExpiry = false;
    try { return await operation(); }
    catch (error) { retainUntilExpiry = hasRetainedClaim(error); throw error; }
    finally { if (!retainUntilExpiry) await this.provider.releaseLease({ expectedVersion: null, leaseId: acquired.leaseId, ownerId }); }
  }
}

export function effectResourceKey(effectId: string): string { return `external-effect-intent/${effectId}`; }

function validateResource(resource: ResourceRecord, effectId: string): void {
  if (resource.key !== effectResourceKey(effectId) || resource.kind !== "system/external-effect-intent" || resource.state !== "active" || resource.version !== EFFECT_RESOURCE_VERSION || resource.digest !== sha256(resource.body)) {
    throw new Error(`External-effect Resource is invalid: ${effectId}`);
  }
}

function parseIntent(body: string): ExternalEffectIntentRecord {
  const value = JSON.parse(body) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("External-effect intent must be an object");
  validateIntent(value as ExternalEffectIntentRecord);
  return structuredClone(value as ExternalEffectIntentRecord);
}

function validateIntent(value: ExternalEffectIntentRecord): void {
  if (value.schema !== "external-effect-intent-v2" || typeof value.automaticReplayBlocked !== "boolean" || !digest(value.effectId) || !digest(value.payloadDigest)) throw new TypeError("External-effect intent identity is invalid");
  if (value.handlerId === "" || value.handlerVersion === "" || value.kind === "") throw new TypeError("External-effect handler identity is invalid");
  if (!["applied", "failed", "indeterminate", "not_applied", "pending"].includes(value.state)) throw new TypeError("External-effect intent state is invalid");
  if (value.source.runId === "" || !digest(value.source.contextDigest) || !digest(value.source.definitionDigest) || !digest(value.source.resultDigest) || !Number.isSafeInteger(value.source.intentIndex) || value.source.intentIndex < 0) throw new TypeError("External-effect source is invalid");
  if (value.receipt !== null && (value.receipt.schema !== "external-effect-receipt-v1" || value.receipt.effectId !== value.effectId || value.receipt.handlerId !== value.handlerId || value.receipt.handlerVersion !== value.handlerVersion || value.receipt.state !== value.state)) throw new TypeError("External-effect receipt is invalid");
  if (value.receipt === null && (value.state === "applied" || value.state === "failed" || value.state === "not_applied")) throw new TypeError("Terminal external-effect intent requires a receipt");
  toJsonValue(value.payload);
}

function digest(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function hasRetainedClaim(error: unknown): boolean { return error !== null && typeof error === "object" && "retainClaimUntilExpiry" in error && (error as { readonly retainClaimUntilExpiry?: unknown }).retainClaimUntilExpiry === true; }
