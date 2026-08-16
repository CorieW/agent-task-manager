/** Stores complete external-effect intents and receipts in provider Resources. */
import { canonicalize } from "../core/canonical-json.js";
import { randomUUID } from "node:crypto";
import { sha256 } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { ResourceRecord } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { ExternalEffectIntentRecord } from "./contracts.js";

/** Stores effect resource version used by the current operation. */
const EFFECT_RESOURCE_VERSION = "v2";

/** Implements provider effect journal and its boundary checks. */
export class ProviderEffectJournal {
  /** Creates provider effect journal with its required collaborators. */
  public constructor(
    /** Provides provider to provider effect journal. */ private readonly provider: AgentTaskProvider,
  ) {}

  /** Reads the durable intent record for an effect identity. */
  public async read(
    effectId: string,
  ): Promise<ExternalEffectIntentRecord | null> {
    /** Stores resource used by read. */
    const resource = await this.provider.getOptionalResource(
      effectResourceKey(effectId),
    );
    if (resource === null) return null;
    validateResource(resource, effectId);
    return parseIntent(resource.body);
  }

  /** Persists and verifies the durable provider effect journal record. */
  public async write(record: ExternalEffectIntentRecord): Promise<void> {
    validateIntent(record);
    /** Stores body used by write. */
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
    /** Reads the persisted record back to verify the provider write. */
    const verified = await this.read(record.effectId);
    if (verified === null || canonicalize(toJsonValue(verified)) !== body)
      throw new Error(
        `External-effect journal verification failed: ${record.effectId}`,
      );
  }

  /** Runs an operation under an exclusive provider lease for the effect ID. */
  public async withClaim<T>(
    effectId: string,
    claimExpiresAt: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    /** Uses a fresh owner identity so competing broker attempts cannot share a lease. */
    const ownerId = `external-effect:${randomUUID()}`;
    /** Records the provider's exclusive-lease decision. */
    const acquired = await this.provider.acquireLease({
      expiresAt: new Date(claimExpiresAt).toISOString(),
      idempotencyKey: `external-effect-claim:${effectId}:${ownerId}`,
      ownerId,
      scope: "task_assignment",
      subAgentId: "system/external-effect-broker",
      taskId: `system/external-effect/${effectId}`,
    });
    if (!acquired.acquired || acquired.leaseId === null)
      throw new Error(`External effect is already claimed: ${effectId}`);
    /** Prevents early release when cancellation may have left execution running. */
    let retainUntilExpiry = false;
    try {
      return await operation();
    } catch (error) {
      retainUntilExpiry = hasRetainedClaim(error);
      throw error;
    } finally {
      if (!retainUntilExpiry)
        await this.provider.releaseLease({
          expectedVersion: null,
          leaseId: acquired.leaseId,
          ownerId,
        });
    }
  }
}

/** Builds the deterministic provider key for this durable record. */
export function effectResourceKey(effectId: string): string {
  return `external-effect-intent/${effectId}`;
}

/** Rejects invalid resource before it crosses the boundary. */
function validateResource(resource: ResourceRecord, effectId: string): void {
  if (
    resource.key !== effectResourceKey(effectId) ||
    resource.kind !== "system/external-effect-intent" ||
    resource.state !== "active" ||
    resource.version !== EFFECT_RESOURCE_VERSION ||
    resource.digest !== sha256(resource.body)
  ) {
    throw new Error(`External-effect Resource is invalid: ${effectId}`);
  }
}

/** Parses and validates intent. */
function parseIntent(body: string): ExternalEffectIntentRecord {
  /** Contains the parsed durable intent value. */
  const value = JSON.parse(body) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("External-effect intent must be an object");
  validateIntent(value as ExternalEffectIntentRecord);
  return structuredClone(value as ExternalEffectIntentRecord);
}

/** Rejects invalid intent before it crosses the boundary. */
function validateIntent(value: ExternalEffectIntentRecord): void {
  if (
    value.schema !== "external-effect-intent-v2" ||
    typeof value.automaticReplayBlocked !== "boolean" ||
    !isSha256Digest(value.effectId) ||
    !isSha256Digest(value.payloadDigest)
  )
    throw new TypeError("External-effect intent identity is invalid");
  if (
    value.handlerId === "" ||
    value.handlerVersion === "" ||
    value.kind === ""
  )
    throw new TypeError("External-effect handler identity is invalid");
  if (
    !["applied", "failed", "indeterminate", "not_applied", "pending"].includes(
      value.state,
    )
  )
    throw new TypeError("External-effect intent state is invalid");
  if (
    value.source.runId === "" ||
    !isSha256Digest(value.source.contextDigest) ||
    !isSha256Digest(value.source.definitionDigest) ||
    !isSha256Digest(value.source.resultDigest) ||
    !Number.isSafeInteger(value.source.intentIndex) ||
    value.source.intentIndex < 0
  )
    throw new TypeError("External-effect source is invalid");
  if (
    value.receipt !== null &&
    (value.receipt.schema !== "external-effect-receipt-v1" ||
      value.receipt.effectId !== value.effectId ||
      value.receipt.handlerId !== value.handlerId ||
      value.receipt.handlerVersion !== value.handlerVersion ||
      value.receipt.state !== value.state)
  )
    throw new TypeError("External-effect receipt is invalid");
  if (
    value.receipt === null &&
    (value.state === "applied" ||
      value.state === "failed" ||
      value.state === "not_applied")
  )
    throw new TypeError("Terminal external-effect intent requires a receipt");
  toJsonValue(value.payload);
}

/** Returns whether a value is a lowercase SHA-256 digest. */
function isSha256Digest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
/** Returns whether an error requests retained effect ownership. */
function hasRetainedClaim(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "retainClaimUntilExpiry" in error &&
    (
      error as {
        /** Provides retain claim until expiry to has retained claim. */ readonly retainClaimUntilExpiry?: unknown;
      }
    ).retainClaimUntilExpiry === true
  );
}
