// Persists intents and leases as canonical Resource rows for restart-safe reconciliation.
import { randomUUID } from "node:crypto";

import { canonicalize } from "../../core/canonical-json.js";
import { digestJson, sha256 } from "../../core/digest.js";
import { toJsonValue, type JsonObject, type JsonValue } from "../../domain/json.js";
import type { LeaseRelease, LeaseRenewal, LeaseRequest, LeaseResult } from "../../domain/records.js";
import type { ReconciliationResult } from "../../domain/provider.js";
import type { WriteReceipt } from "../../domain/provider.js";
import { NotionPageStore } from "./notion-page-store.js";
import { SingleHostMutex } from "./single-host-mutex.js";

interface IntentRecord {
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly payloadDigest: string;
  readonly result: JsonValue;
  readonly schema: "agent-task-manager-intent-v1";
  readonly state: "applied" | "pending";
}

interface LeaseRecord {
  readonly expiresAt: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly releasedAt: string | null;
  readonly schema: "agent-task-manager-lease-v1";
  readonly scope: LeaseRequest["scope"];
  readonly subAgentId: string;
  readonly taskId: string | null;
}

export class IndeterminateProviderIntentError extends Error {}

export class NotionStateStore {
  public constructor(
    private readonly pages: NotionPageStore,
    private readonly mutex: SingleHostMutex,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async beginIntent(idempotencyKey: string, operation: string, payload: unknown): Promise<JsonValue | undefined> {
    const payloadDigest = digestJson(toJsonValue(payload));
    const key = intentKey(idempotencyKey);
    const existing = await this.readRecord(key);
    if (existing !== null) {
      const intent = parseIntent(existing);
      if (intent.idempotencyKey !== idempotencyKey || intent.operation !== operation || intent.payloadDigest !== payloadDigest) {
        throw new Error(`Idempotency key ${idempotencyKey} was reused with a different operation or payload`);
      }
      if (intent.state === "applied") return intent.result;
      throw new IndeterminateProviderIntentError(`Intent ${idempotencyKey} has an unresolved pending outcome`);
    }
    await this.writeRecord(key, {
      idempotencyKey,
      operation,
      payloadDigest,
      result: null,
      schema: "agent-task-manager-intent-v1",
      state: "pending",
    }, `intent-begin:${idempotencyKey}`);
    return undefined;
  }

  public async completeIntent(idempotencyKey: string, operation: string, payload: unknown, result: unknown): Promise<void> {
    const payloadDigest = digestJson(toJsonValue(payload));
    const key = intentKey(idempotencyKey);
    const existing = await this.readRecord(key);
    if (existing === null) throw new Error(`Intent ${idempotencyKey} was not begun`);
    const intent = parseIntent(existing);
    if (intent.operation !== operation || intent.payloadDigest !== payloadDigest) throw new Error(`Intent ${idempotencyKey} changed before completion`);
    await this.writeRecord(key, { ...intent, result: toJsonValue(result), state: "applied" }, `intent-complete:${idempotencyKey}`);
  }

  public async reconcileIntent(idempotencyKey: string): Promise<ReconciliationResult> {
    const value = await this.readRecord(intentKey(idempotencyKey));
    if (value === null) return { evidence: {}, state: "not_applied" };
    const intent = parseIntent(value);
    return {
      evidence: { operation: intent.operation, payloadDigest: intent.payloadDigest, result: intent.result },
      state: intent.state === "applied" ? "applied" : "indeterminate",
    };
  }

  public async acquireLease(request: LeaseRequest): Promise<LeaseResult> {
    return this.mutex.run(async () => {
      const prior = await this.beginIntent(request.idempotencyKey, "lease_acquire", request);
      if (prior !== undefined) return parseLeaseResult(prior);
      validateLeaseRequest(request, this.now());
      const key = leaseKey(request.scope, request.scope === "agent_run" ? request.subAgentId : requiredTaskId(request));
      const currentValue = await this.readRecord(key);
      const current = currentValue === null ? null : parseLease(currentValue);
      let result: LeaseResult;
      if (current !== null && current.releasedAt === null && Date.parse(current.expiresAt) > this.now().getTime()) {
        result = { acquired: false, conflictingLeaseId: current.leaseId, leaseId: null };
      } else {
        const lease: LeaseRecord = {
          expiresAt: request.expiresAt,
          leaseId: randomUUID(),
          ownerId: request.ownerId,
          releasedAt: null,
          schema: "agent-task-manager-lease-v1",
          scope: request.scope,
          subAgentId: request.subAgentId,
          taskId: request.taskId,
        };
        await this.writeRecord(key, lease, `lease-acquire:${request.idempotencyKey}`);
        result = { acquired: true, conflictingLeaseId: null, leaseId: lease.leaseId };
      }
      await this.completeIntent(request.idempotencyKey, "lease_acquire", request, result);
      return result;
    });
  }

  public async renewLease(request: LeaseRenewal): Promise<LeaseResult> {
    return this.mutex.run(async () => {
      const prior = await this.beginIntent(request.idempotencyKey, "lease_renew", request);
      if (prior !== undefined) return parseLeaseResult(prior);
      const located = await this.findLeaseById(request.leaseId);
      let result: LeaseResult;
      if (
        located === null || located.record.ownerId !== request.ownerId ||
        located.record.expiresAt !== request.expectedExpiresAt || located.record.releasedAt !== null ||
        !isLater(request.nextExpiresAt, request.expectedExpiresAt) || Date.parse(request.nextExpiresAt) <= this.now().getTime()
      ) {
        result = { acquired: false, conflictingLeaseId: request.leaseId, leaseId: null };
      } else {
        await this.writeRecord(located.key, { ...located.record, expiresAt: request.nextExpiresAt }, `lease-renew:${request.idempotencyKey}`);
        result = { acquired: true, conflictingLeaseId: null, leaseId: request.leaseId };
      }
      await this.completeIntent(request.idempotencyKey, "lease_renew", request, result);
      return result;
    });
  }

  public async releaseLease(request: LeaseRelease): Promise<WriteReceipt> {
    return this.mutex.run(async () => {
      const idempotencyKey = `lease-release:${request.leaseId}:${request.ownerId}`;
      const prior = await this.beginIntent(idempotencyKey, "lease_release", request);
      if (prior !== undefined) return parseReleaseResult(prior);
      const located = await this.findLeaseById(request.leaseId);
      if (located === null || located.record.ownerId !== request.ownerId || located.record.releasedAt !== null) {
        throw new Error("Lease release conflict");
      }
      const receipt = await this.writeRecord(
        located.key,
        { ...located.record, releasedAt: this.now().toISOString() },
        idempotencyKey,
      );
      await this.completeIntent(idempotencyKey, "lease_release", request, receipt);
      return receipt;
    });
  }

  public async activeLeaseIds(scope: LeaseRequest["scope"], subAgentId: string): Promise<readonly string[]> {
    const pages = await this.pages.listBySelect("resources", "Kind", "system/lease");
    const now = this.now().getTime();
    const ids: string[] = [];
    for (const page of pages) {
      const record = parseLease(JSON.parse(await this.pages.managedText(page.id, "Resource body")) as JsonValue);
      if (record.scope === scope && record.subAgentId === subAgentId && record.releasedAt === null && Date.parse(record.expiresAt) > now) ids.push(record.leaseId);
    }
    return ids.sort();
  }

  public async activeTaskIds(subAgentId: string): Promise<readonly string[]> {
    const pages = await this.pages.listBySelect("resources", "Kind", "system/lease");
    const now = this.now().getTime();
    const ids: string[] = [];
    for (const page of pages) {
      const record = parseLease(toJsonValue(JSON.parse(await this.pages.managedText(page.id, "Resource body"))));
      if (record.scope === "task_assignment" && record.subAgentId === subAgentId && record.taskId !== null && record.releasedAt === null && Date.parse(record.expiresAt) > now) ids.push(record.taskId);
    }
    return [...new Set(ids)].sort();
  }

  public async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutex.run(operation);
  }

  private async findLeaseById(leaseId: string): Promise<{ readonly key: string; readonly record: LeaseRecord } | null> {
    const pages = await this.pages.listBySelect("resources", "Kind", "system/lease");
    const matches: Array<{ key: string; record: LeaseRecord }> = [];
    for (const page of pages) {
      const record = parseLease(JSON.parse(await this.pages.managedText(page.id, "Resource body")) as JsonValue);
      if (record.leaseId === leaseId) matches.push({ key: leaseKey(record.scope, record.scope === "agent_run" ? record.subAgentId : requiredTaskId(record)), record });
    }
    if (matches.length > 1) throw new Error(`Lease ${leaseId} is duplicated`);
    return matches[0] ?? null;
  }

  private async readRecord(key: string): Promise<JsonValue | null> {
    const located = await this.pages.findUniqueByTitle("resources", "Resource", key);
    if (located === null) return null;
    return toJsonValue(JSON.parse(await this.pages.managedText(located.id, "Resource body")));
  }

  private async writeRecord(key: string, value: unknown, idempotencyKey: string) {
    const body = canonicalize(toJsonValue(value));
    return this.pages.createResource({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey,
      key,
      kind: key.startsWith("system/lease/") ? "system/lease" : "system/intent",
      state: "active",
      version: "v1",
    });
  }
}

function intentKey(idempotencyKey: string): string { return `system/intent/${sha256(idempotencyKey)}`; }
function leaseKey(scope: LeaseRequest["scope"], owner: string): string { return `system/lease/${scope}/${sha256(owner)}`; }

function parseIntent(value: JsonValue): IntentRecord {
  const object = exactObject(value, ["idempotencyKey", "operation", "payloadDigest", "result", "schema", "state"], "Intent");
  if (object.schema !== "agent-task-manager-intent-v1" || (object.state !== "applied" && object.state !== "pending")) throw new TypeError("Intent schema or state is invalid");
  return {
    idempotencyKey: stringValue(object.idempotencyKey, "Intent idempotencyKey"),
    operation: stringValue(object.operation, "Intent operation"),
    payloadDigest: stringValue(object.payloadDigest, "Intent payloadDigest"),
    result: object.result ?? null,
    schema: object.schema,
    state: object.state,
  };
}

function parseLease(value: JsonValue): LeaseRecord {
  const object = exactObject(value, ["expiresAt", "leaseId", "ownerId", "releasedAt", "schema", "scope", "subAgentId", "taskId"], "Lease");
  if (object.schema !== "agent-task-manager-lease-v1" || (object.scope !== "agent_run" && object.scope !== "task_assignment")) throw new TypeError("Lease schema or scope is invalid");
  return {
    expiresAt: stringValue(object.expiresAt, "Lease expiresAt"),
    leaseId: stringValue(object.leaseId, "Lease leaseId"),
    ownerId: stringValue(object.ownerId, "Lease ownerId"),
    releasedAt: nullableString(object.releasedAt, "Lease releasedAt"),
    schema: object.schema,
    scope: object.scope,
    subAgentId: stringValue(object.subAgentId, "Lease subAgentId"),
    taskId: nullableString(object.taskId, "Lease taskId"),
  };
}

function parseLeaseResult(value: JsonValue): LeaseResult {
  const object = exactObject(value, ["acquired", "conflictingLeaseId", "leaseId"], "Lease result");
  if (typeof object.acquired !== "boolean") throw new TypeError("Lease result acquired must be boolean");
  return { acquired: object.acquired, conflictingLeaseId: nullableString(object.conflictingLeaseId, "conflictingLeaseId"), leaseId: nullableString(object.leaseId, "leaseId") };
}

function parseReleaseResult(value: JsonValue): WriteReceipt {
  const object = exactObject(value, ["idempotencyKey", "observedVersion", "providerRecord", "writtenAt"], "Lease release result");
  const providerRecord = exactObject(object.providerRecord ?? null, ["id", "table"], "Lease release provider record");
  if (providerRecord.table !== "resources") throw new TypeError("Lease release receipt must reference Resources");
  return {
    idempotencyKey: stringValue(object.idempotencyKey, "idempotencyKey"),
    observedVersion: stringValue(object.observedVersion, "observedVersion"),
    providerRecord: { id: stringValue(providerRecord.id, "providerRecord.id"), table: "resources" },
    writtenAt: stringValue(object.writtenAt, "writtenAt"),
  };
}

function validateLeaseRequest(request: LeaseRequest, now: Date): void {
  if ((request.scope === "agent_run") !== (request.taskId === null)) throw new TypeError("Lease scope and task identity do not match");
  if (!Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) <= now.getTime()) throw new TypeError("Lease expiry must be in the future");
}

function requiredTaskId(value: { readonly taskId: string | null }): string {
  if (value.taskId === null) throw new TypeError("Task-assignment lease requires taskId");
  return value.taskId;
}

function isLater(next: string, previous: string): boolean { return Number.isFinite(Date.parse(next)) && Date.parse(next) > Date.parse(previous); }

function exactObject(value: JsonValue, keys: readonly string[], label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new TypeError(`${label} has unexpected or missing fields`);
  return value;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function nullableString(value: JsonValue | undefined, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}
