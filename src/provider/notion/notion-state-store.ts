/** Persists intents and leases in the Operations table for restart-safe reconciliation. */
import { randomUUID } from "node:crypto";

import { canonicalize } from "../../core/canonical-json.js";
import { digestJson, sha256 } from "../../core/digest.js";
import {
  toJsonValue,
  type JsonObject,
  type JsonValue,
} from "../../domain/json.js";
import type {
  LeaseRelease,
  LeaseRenewal,
  LeaseRequest,
  LeaseResult,
  LeaseSnapshot,
} from "../../domain/records.js";
import type {
  ProviderOperationIntent,
  ReconciliationResult,
} from "../../domain/provider.js";
import type { WriteReceipt } from "../../domain/provider.js";
import type { NotionPageStore } from "./notion-page-store.js";
import type { SingleHostMutex } from "./single-host-mutex.js";
import { parseWriteReceipt } from "../write-receipt-codec.js";

/** Canonical intent record. */
interface IntentRecord {
  /** Identifies one exact operation for payload-bound replay. */
  readonly idempotencyKey: string;
  /** Logical operation represented by this record. */
  readonly operation: string;
  /** Binds intent record to canonical payload content. */
  readonly payloadDigest: string;
  /** Retains the canonical payload needed to resume a prepared operation. */
  readonly payload: JsonValue;
  /** Lifecycle state for reconciliation. */
  readonly reconciliationState: "applied" | "not_applied" | null;
  /** Validated operation result. */
  readonly result: JsonValue;
  /** Wire-schema discriminator; always `agent-task-manager-intent-v1`. */
  readonly schema: "agent-task-manager-intent-v1";
  /** Lifecycle state used for workflow decisions. */
  readonly state: "applied" | "pending";
}

/** Canonical lease record. */
interface LeaseRecord {
  /** Provider-neutral when the lease expires contract. */
  readonly expiresAt: string;
  /** Stable identifier for lease id. */
  readonly leaseId: string;
  /** Stable identifier for owner id. */
  readonly ownerId: string;
  /** When the lease was released, if applicable. */
  readonly releasedAt: string | null;
  /** Wire-schema discriminator; always `agent-task-manager-lease-v1`. */
  readonly schema: "agent-task-manager-lease-v1";
  /** Lease scope controlling conflict semantics. */
  readonly scope: LeaseRequest["scope"];
  /** Stable identifier for agent id. */
  readonly agentId: string;
  /** Stable identifier for task id. */
  readonly taskId: string | null;
}

/** Represents a indeterminate provider intent failure. */
export class IndeterminateProviderIntentError extends Error {}

/** Implements Notion state store. */
export class NotionStateStore {
  /** Initializes Notion state store. */
  public constructor(
    /** Pages callback invoked by Notion state store. */ private readonly pages: NotionPageStore,
    /** Mutex callback invoked by Notion state store. */ private readonly mutex: SingleHostMutex,
    /** Now callback invoked by Notion state store. */ private readonly now: () => Date = () =>
      new Date(),
  ) {}

  /** Begins intent. */
  public async beginIntent(
    idempotencyKey: string,
    operation: string,
    payload: unknown,
    beforeCreate?: () => Promise<void>,
  ): Promise<JsonValue | undefined> {
    /** Holds the `payloadDigest` intermediate used by `beginIntent`. */
    const payloadDigest = digestJson(toJsonValue(payload));
    /** Holds the `key` intermediate used by `beginIntent`. */
    const key = intentKey(idempotencyKey);
    /** Holds the `existing` intermediate used by `beginIntent`. */
    const existing = await this.readRecord(key);
    if (existing !== null) {
      /** Holds the `intent` intermediate used by `beginIntent`. */
      const intent = parseIntent(existing);
      if (
        intent.idempotencyKey !== idempotencyKey ||
        intent.operation !== operation ||
        intent.payloadDigest !== payloadDigest
      ) {
        throw new Error(
          `Idempotency key ${idempotencyKey} was reused with a different operation or payload`,
        );
      }
      if (intent.state === "applied") return intent.result;
      throw new IndeterminateProviderIntentError(
        `Intent ${idempotencyKey} has an unresolved pending outcome`,
      );
    }
    await beforeCreate?.();
    await this.writeRecord(
      key,
      {
        idempotencyKey,
        operation,
        payload: toJsonValue(payload),
        payloadDigest,
        result: null,
        reconciliationState: null,
        schema: "agent-task-manager-intent-v1",
        state: "pending",
      },
      `intent-begin:${idempotencyKey}`,
    );
    return undefined;
  }

  /** Completes intent. */
  public async completeIntent(
    idempotencyKey: string,
    operation: string,
    payload: unknown,
    result: unknown,
    reconciliationState: "applied" | "not_applied" = "applied",
  ): Promise<void> {
    /** Holds the `payloadDigest` intermediate used by `completeIntent`. */
    const payloadDigest = digestJson(toJsonValue(payload));
    /** Holds the `key` intermediate used by `completeIntent`. */
    const key = intentKey(idempotencyKey);
    /** Holds the `existing` intermediate used by `completeIntent`. */
    const existing = await this.readRecord(key);
    if (existing === null)
      throw new Error(`Intent ${idempotencyKey} was not begun`);
    /** Holds the `intent` intermediate used by `completeIntent`. */
    const intent = parseIntent(existing);
    if (
      intent.operation !== operation ||
      intent.payloadDigest !== payloadDigest
    )
      throw new Error(`Intent ${idempotencyKey} changed before completion`);
    await this.writeRecord(
      key,
      {
        ...intent,
        reconciliationState,
        result: toJsonValue(result),
        state: "applied",
      },
      `intent-complete:${idempotencyKey}`,
    );
  }

  /** Reconciles intent against provider state. */
  public async reconcileIntent(
    idempotencyKey: string,
  ): Promise<ReconciliationResult> {
    /** Holds the `value` intermediate used by `reconcileIntent`. */
    const value = await this.readRecord(intentKey(idempotencyKey));
    if (value === null) return { evidence: {}, state: "not_applied" };
    /** Holds the `intent` intermediate used by `reconcileIntent`. */
    const intent = parseIntent(value);
    return {
      evidence: {
        operation: intent.operation,
        payloadDigest: intent.payloadDigest,
        result: intent.result,
      },
      state:
        intent.state === "applied"
          ? (intent.reconciliationState ?? "indeterminate")
          : "indeterminate",
    };
  }

  /** Returns a public snapshot of one persisted logical-operation intent. */
  public async operationIntent(
    idempotencyKey: string,
  ): Promise<ProviderOperationIntent | null> {
    /** Persisted intent payload, or null when the key is unknown. */
    const value = await this.readRecord(intentKey(idempotencyKey));
    if (value === null) return null;
    /** Validated internal intent projected into the provider-neutral shape. */
    const intent = parseIntent(value);
    return {
      idempotencyKey: intent.idempotencyKey,
      operation: intent.operation,
      payload: intent.payload,
      result: intent.result,
      state: intent.state,
    };
  }

  /** Acquires lease. */
  public async acquireLease(request: LeaseRequest): Promise<LeaseResult> {
    return this.mutex.run(async () => {
      /** Holds the `prior` intermediate used by `acquireLease`. */
      const prior = await this.beginIntent(
        request.idempotencyKey,
        "lease_acquire",
        request,
      );
      if (prior !== undefined) return parseLeaseResult(prior);
      validateLeaseRequest(request, this.now());
      /** Holds the `key` intermediate used by `acquireLease`. */
      const key = leaseKey(
        request.scope,
        request.scope === "agent_run"
          ? `${request.agentId}\0${request.ownerId}`
          : requiredTaskId(request),
      );
      /** Holds the `currentValue` intermediate used by `acquireLease`. */
      const currentValue = await this.readRecord(key);
      /** Holds the `current` intermediate used by `acquireLease`. */
      const current = currentValue === null ? null : parseLease(currentValue);
      /** Captures `result` returned by `acquireLease`. */
      let result: LeaseResult;
      if (
        current !== null &&
        current.releasedAt === null &&
        Date.parse(current.expiresAt) > this.now().getTime()
      ) {
        result = {
          acquired: false,
          conflictingLeaseId: current.leaseId,
          leaseId: null,
        };
      } else {
        /** Holds the `lease` intermediate used by `acquireLease`. */
        const lease: LeaseRecord = {
          expiresAt: request.expiresAt,
          leaseId: randomUUID(),
          ownerId: request.ownerId,
          releasedAt: null,
          schema: "agent-task-manager-lease-v1",
          scope: request.scope,
          agentId: request.agentId,
          taskId: request.taskId,
        };
        await this.writeRecord(
          key,
          lease,
          `lease-acquire:${request.idempotencyKey}`,
        );
        result = {
          acquired: true,
          conflictingLeaseId: null,
          leaseId: lease.leaseId,
        };
      }
      await this.completeIntent(
        request.idempotencyKey,
        "lease_acquire",
        request,
        result,
        result.acquired ? "applied" : "not_applied",
      );
      return result;
    });
  }

  /** Renews lease. */
  public async renewLease(request: LeaseRenewal): Promise<LeaseResult> {
    return this.mutex.run(async () => {
      /** Holds the `prior` intermediate used by `renewLease`. */
      const prior = await this.beginIntent(
        request.idempotencyKey,
        "lease_renew",
        request,
      );
      if (prior !== undefined) return parseLeaseResult(prior);
      /** Holds the `located` intermediate used by `renewLease`. */
      const located = await this.findLeaseById(request.leaseId);
      /** Captures `result` returned by `renewLease`. */
      let result: LeaseResult;
      if (
        located === null ||
        located.record.ownerId !== request.ownerId ||
        located.record.expiresAt !== request.expectedExpiresAt ||
        located.record.releasedAt !== null ||
        Date.parse(located.record.expiresAt) <= this.now().getTime() ||
        !isLater(request.nextExpiresAt, request.expectedExpiresAt) ||
        Date.parse(request.nextExpiresAt) <= this.now().getTime()
      ) {
        result = {
          acquired: false,
          conflictingLeaseId: request.leaseId,
          leaseId: null,
        };
      } else {
        await this.writeRecord(
          located.key,
          { ...located.record, expiresAt: request.nextExpiresAt },
          `lease-renew:${request.idempotencyKey}`,
        );
        result = {
          acquired: true,
          conflictingLeaseId: null,
          leaseId: request.leaseId,
        };
      }
      await this.completeIntent(
        request.idempotencyKey,
        "lease_renew",
        request,
        result,
        result.acquired ? "applied" : "not_applied",
      );
      return result;
    });
  }

  /** Releases lease. */
  public async releaseLease(request: LeaseRelease): Promise<WriteReceipt> {
    return this.mutex.run(async () => {
      /** Idempotency key bound to the exact lease-release authority. */
      const idempotencyKey = `lease-release:${request.leaseId}:${request.ownerId}:${request.expectedVersion ?? "unversioned"}`;
      /** Existing closed receipt or pending intent for this release. */
      const prior = await this.beginIntent(
        idempotencyKey,
        "lease_release",
        request,
        async () => {
          /** Holds the `located` intermediate used by `releaseLease`. */
          const located = await this.findLeaseById(request.leaseId);
          if (
            located === null ||
            located.record.ownerId !== request.ownerId ||
            located.record.releasedAt !== null ||
            (request.expectedVersion !== null &&
              request.expectedVersion !==
                digestJson(toJsonValue(located.record)))
          ) {
            throw new Error("Lease release conflict");
          }
        },
      );
      if (prior !== undefined) return parseReleaseResult(prior);
      /** Holds the `located` intermediate used by `releaseLease`. */
      const located = await this.findLeaseById(request.leaseId);
      if (
        located === null ||
        located.record.ownerId !== request.ownerId ||
        located.record.releasedAt !== null ||
        (request.expectedVersion !== null &&
          request.expectedVersion !== digestJson(toJsonValue(located.record)))
      )
        throw new IndeterminateProviderIntentError(
          "Lease changed after its release intent was stored",
        );
      /** Captures `receipt` returned by `releaseLease`. */
      const receipt = await this.writeRecord(
        located.key,
        { ...located.record, releasedAt: this.now().toISOString() },
        idempotencyKey,
      );
      await this.completeIntent(
        idempotencyKey,
        "lease_release",
        request,
        receipt,
      );
      return receipt;
    });
  }

  /** Builds snapshot. */
  public async leaseSnapshot(leaseId: string): Promise<LeaseSnapshot | null> {
    /** Holds the `located` intermediate used by `leaseSnapshot`. */
    const located = await this.findLeaseById(leaseId);
    if (located === null) return null;
    /** Holds the `record` intermediate used by `leaseSnapshot`. */
    const record = located.record;
    return {
      expiresAt: record.expiresAt,
      leaseId: record.leaseId,
      ownerId: record.ownerId,
      released: record.releasedAt !== null,
      scope: record.scope,
      agentId: record.agentId,
      taskId: record.taskId,
      version: digestJson(toJsonValue(record)),
    };
  }

  /** Returns IDs for all currently active leases. */
  public async activeLeaseIds(
    scope: LeaseRequest["scope"],
    agentId: string,
  ): Promise<readonly string[]> {
    /** Holds the `projection` intermediate used by `activeLeaseIds`. */
    const projection = await this.activeProjection(agentId);
    return scope === "agent_run"
      ? projection.runLeaseIds
      : projection.taskLeaseIds;
  }

  /** Returns Task IDs held by currently active assignment leases. */
  public async activeTaskIds(agentId: string): Promise<readonly string[]> {
    return (await this.activeProjection(agentId)).taskIds;
  }

  /** Builds the active run and Task lease projection for one Agent. */
  public async activeProjection(agentId: string): Promise<{
    /** Ordered run lease IDs for active projection. */
    readonly runLeaseIds: readonly string[];
    /** Ordered task IDs for active projection. */
    readonly taskIds: readonly string[];
    /** Ordered task lease IDs for active projection. */
    readonly taskLeaseIds: readonly string[];
  }> {
    /** Holds the `leases` intermediate used by `activeProjection`. */
    const leases = await this.loadLeases();
    /** Holds the `now` intermediate used by `activeProjection`. */
    const now = this.now().getTime();
    /** Holds the `active` intermediate used by `activeProjection`. */
    const active = leases.filter(
      (record) =>
        record.agentId === agentId &&
        record.releasedAt === null &&
        Date.parse(record.expiresAt) > now,
    );
    return {
      runLeaseIds: active
        .filter((record) => record.scope === "agent_run")
        .map((record) => record.leaseId)
        .sort(),
      taskIds: [
        ...new Set(
          active
            .filter((record) => record.scope === "task_assignment")
            .map((record) => requiredTaskId(record)),
        ),
      ].sort(),
      taskLeaseIds: active
        .filter((record) => record.scope === "task_assignment")
        .map((record) => record.leaseId)
        .sort(),
    };
  }

  /** Loads and validates every persisted lease record. */
  private async loadLeases(): Promise<readonly LeaseRecord[]> {
    /** Operations whose rich-text Kind identifies lease records. */
    const pages = await this.pages.listByRichText(
      "operations",
      "Kind",
      "lease",
    );
    /** Mutable leases collection accumulated during `loadLeases`. */
    const leases: LeaseRecord[] = [];
    for (const page of pages) {
      leases.push(
        parseLease(
          toJsonValue(
            JSON.parse(await this.pages.managedText(page.id, "Operation body")),
          ),
        ),
      );
    }
    return leases;
  }

  /** Runs one state operation under the same-host mutex. */
  public async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutex.run(operation);
  }

  /** Finds lease by ID. */
  private async findLeaseById(leaseId: string): Promise<{
    /** Stable key used by find lease by ID. */ readonly key: string;
    /** Decoded lease record stored under the matching key. */ readonly record: LeaseRecord;
  } | null> {
    /** Holds the `leases` intermediate used by `findLeaseById`. */
    const leases = await this.loadLeases();
    /** Mutable matches collection accumulated during `findLeaseById`. */
    const matches: Array<{
      /** Ordered record used by find lease by ID. */ key: string;
      /** Ordered record used by find lease by ID. */ record: LeaseRecord;
    }> = [];
    for (const record of leases) {
      if (record.leaseId === leaseId)
        matches.push({
          key: leaseKey(
            record.scope,
            record.scope === "agent_run"
              ? `${record.agentId}\0${record.ownerId}`
              : requiredTaskId(record),
          ),
          record,
        });
    }
    if (matches.length > 1) throw new Error(`Lease ${leaseId} is duplicated`);
    return matches[0] ?? null;
  }

  /** Reads record. */
  private async readRecord(key: string): Promise<JsonValue | null> {
    /** Holds the `located` intermediate used by `readRecord`. */
    const located = await this.pages.findUniqueByTitle(
      "operations",
      "Operation",
      key,
    );
    if (located === null) return null;
    return toJsonValue(
      JSON.parse(await this.pages.managedText(located.id, "Operation body")),
    );
  }

  /** Persists record. */
  private async writeRecord(
    key: string,
    value: unknown,
    idempotencyKey: string,
  ) {
    /** Holds the `body` intermediate used by `writeRecord`. */
    const body = canonicalize(toJsonValue(value));
    return this.pages.createOperation({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey,
      key,
      kind: key.startsWith("lease/") ? "lease" : "intent",
      state: "active",
      version: "v1",
    });
  }
}

/** Builds key. */
function intentKey(idempotencyKey: string): string {
  return `intent/${sha256(idempotencyKey)}`;
}

/** Builds key. */
function leaseKey(scope: LeaseRequest["scope"], owner: string): string {
  return `lease/${scope}/${sha256(owner)}`;
}

/** Parses and validates intent. */
function parseIntent(value: JsonValue): IntentRecord {
  /** Holds the `object` intermediate used by `parseIntent`. */
  const object = exactObject(
    value,
    [
      "idempotencyKey",
      "operation",
      "payload",
      "payloadDigest",
      "reconciliationState",
      "result",
      "schema",
      "state",
    ],
    "Intent",
  );
  if (
    object.schema !== "agent-task-manager-intent-v1" ||
    (object.state !== "applied" && object.state !== "pending")
  )
    throw new TypeError("Intent schema or state is invalid");
  if (
    object.reconciliationState !== null &&
    object.reconciliationState !== "applied" &&
    object.reconciliationState !== "not_applied"
  )
    throw new TypeError("Intent reconciliationState is invalid");
  return {
    idempotencyKey: stringValue(object.idempotencyKey, "Intent idempotencyKey"),
    operation: stringValue(object.operation, "Intent operation"),
    payload: object.payload ?? null,
    payloadDigest: stringValue(object.payloadDigest, "Intent payloadDigest"),
    reconciliationState: object.reconciliationState,
    result: object.result ?? null,
    schema: object.schema,
    state: object.state,
  };
}

/** Parses and validates lease. */
function parseLease(value: JsonValue): LeaseRecord {
  /** Holds the `object` intermediate used by `parseLease`. */
  const object = exactObject(
    value,
    [
      "expiresAt",
      "leaseId",
      "ownerId",
      "releasedAt",
      "schema",
      "scope",
      "agentId",
      "taskId",
    ],
    "Lease",
  );
  if (
    object.schema !== "agent-task-manager-lease-v1" ||
    (object.scope !== "agent_run" && object.scope !== "task_assignment")
  )
    throw new TypeError("Lease schema or scope is invalid");
  /** Holds the `expiresAt` intermediate used by `parseLease`. */
  const expiresAt = canonicalTimestamp(object.expiresAt, "Lease expiresAt");
  /** Optional release timestamp decoded from persisted lease state. */
  const releasedAt =
    object.releasedAt === null
      ? null
      : canonicalTimestamp(object.releasedAt, "Lease releasedAt");
  /** Task association whose nullability must agree with the lease scope. */
  const taskId = nullableString(object.taskId, "Lease taskId");
  if ((object.scope === "agent_run") !== (taskId === null))
    throw new TypeError("Lease scope and taskId are inconsistent");
  return {
    expiresAt,
    leaseId: stringValue(object.leaseId, "Lease leaseId"),
    ownerId: stringValue(object.ownerId, "Lease ownerId"),
    releasedAt,
    schema: object.schema,
    scope: object.scope,
    agentId: stringValue(object.agentId, "Lease agentId"),
    taskId,
  };
}

/** Parses and validates lease result. */
function parseLeaseResult(value: JsonValue): LeaseResult {
  /** Holds the `object` intermediate used by `parseLeaseResult`. */
  const object = exactObject(
    value,
    ["acquired", "conflictingLeaseId", "leaseId"],
    "Lease result",
  );
  if (typeof object.acquired !== "boolean")
    throw new TypeError("Lease result acquired must be boolean");
  return {
    acquired: object.acquired,
    conflictingLeaseId: nullableString(
      object.conflictingLeaseId,
      "conflictingLeaseId",
    ),
    leaseId: nullableString(object.leaseId, "leaseId"),
  };
}

/** Parses and validates release result. */
function parseReleaseResult(value: JsonValue): WriteReceipt {
  /** Captures `receipt` returned by `parseReleaseResult`. */
  const receipt = parseWriteReceipt(value);
  if (receipt.providerRecord.table !== "operations")
    throw new TypeError("Lease release receipt must reference Operations");
  return receipt;
}

/** Validates lease request. */
function validateLeaseRequest(request: LeaseRequest, now: Date): void {
  if ((request.scope === "agent_run") !== (request.taskId === null))
    throw new TypeError("Lease scope and task identity do not match");
  if (
    !Number.isFinite(Date.parse(request.expiresAt)) ||
    Date.parse(request.expiresAt) <= now.getTime()
  )
    throw new TypeError("Lease expiry must be in the future");
}

/** Returns a lease's Task ID or rejects a non-Task lease. */
function requiredTaskId(value: {
  /** Stable identifier for task id. */ readonly taskId: string | null;
}): string {
  if (value.taskId === null)
    throw new TypeError("Task-assignment lease requires taskId");
  return value.taskId;
}

/** Reports whether one timestamp is valid and later than another. */
function isLater(next: string, previous: string): boolean {
  return (
    Number.isFinite(Date.parse(next)) && Date.parse(next) > Date.parse(previous)
  );
}

/** Returns an object after enforcing its exact field set. */
function exactObject(
  value: JsonValue,
  keys: readonly string[],
  label: string,
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new TypeError(`${label} has unexpected or missing fields`);
  return value;
}

/** Validates value. */
function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Validates string. */
function nullableString(
  value: JsonValue | undefined,
  label: string,
): string | null {
  return value === null ? null : stringValue(value, label);
}

/** Canonicalizes timestamp. */
function canonicalTimestamp(
  value: JsonValue | undefined,
  label: string,
): string {
  /** Holds the `timestamp` intermediate used by `canonicalTimestamp`. */
  const timestamp = stringValue(value, label);
  /** Holds the `milliseconds` intermediate used by `canonicalTimestamp`. */
  const milliseconds = Date.parse(timestamp);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== timestamp
  )
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  return timestamp;
}
