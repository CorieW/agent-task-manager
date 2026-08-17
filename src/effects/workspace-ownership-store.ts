/** Persists workspace ownership in provider Operations for crash recovery. */
import { canonicalize } from "../core/canonical-json.js";
import { randomUUID } from "node:crypto";
import { isSha256Digest, sha256 } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { WorkspaceProvisionPayload } from "./typed-effect-handlers.js";

/** Persisted state for workspace ownership. */
export interface WorkspaceOwnershipRecord {
  /** Selected operating mode. */
  readonly mode: WorkspaceProvisionPayload["mode"];
  /** Stable identifier for provision effect id. */
  readonly provisionEffectId: string;
  /** Stable identifier for release effect id. */
  readonly releaseEffectId: string | null;
  /** Stable identifier for repository id. */
  readonly repositoryId: string;
  /** Version tag for the workspace ownership record representation. */
  readonly schema: "workspace-ownership-v1";
  /** Lifecycle state used for workflow decisions. */
  readonly state: "active" | "released";
  /** Stable key of the target workspace. */
  readonly workspaceKey: string;
}

/** Workspace ownership store boundary. */
export interface WorkspaceOwnershipStore {
  /** Claims exclusive workspace ownership when no conflicting live owner exists. */
  claim(input: {
    /** Selected operating mode. */
    readonly mode: WorkspaceProvisionPayload["mode"];
    /** Stable identifier for provision effect id. */
    readonly provisionEffectId: string;
    /** Stable identifier for repository id. */
    readonly repositoryId: string;
    /** Identifies workspace. */
    readonly workspaceKey: string;
  }): Promise<WorkspaceOwnershipRecord>;
  /** Returns the ownership record for an exact workspace path. */
  get(workspaceKey: string): Promise<WorkspaceOwnershipRecord | null>;
  /** Releases workspace ownership held by the matching owner. */
  release(input: {
    /** Stable identifier for release effect id. */
    readonly releaseEffectId: string;
    /** Stable identifier for repository id. */
    readonly repositoryId: string;
    /** Identifies workspace. */
    readonly workspaceKey: string;
  }): Promise<WorkspaceOwnershipRecord>;
}

/** Implements provider workspace ownership store and its boundary checks. */
export class ProviderWorkspaceOwnershipStore implements WorkspaceOwnershipStore {
  /** Creates provider workspace ownership store with its required collaborators. */
  public constructor(
    /** Provider boundary used for durable state reads and writes. */ private readonly provider: AgentTaskProvider,
    /** Claim in milliseconds. */ private readonly claimMilliseconds = 60_000,
  ) {}
  /** Returns the provider-backed ownership record for an exact workspace path. */
  public async get(
    workspaceKey: string,
  ): Promise<WorkspaceOwnershipRecord | null> {
    /** Durable ownership operation for the workspace identity. */
    const operation = await this.provider.getOptionalOperation(
      key(workspaceKey),
    );
    if (operation === null) return null;
    if (
      operation.kind !== "workspace/ownership" ||
      operation.state !== "active" ||
      operation.version !== "v1" ||
      operation.digest !== sha256(operation.body)
    )
      throw new Error(
        `Workspace ownership Operation is invalid: ${workspaceKey}`,
      );
    return parse(JSON.parse(operation.body) as unknown, workspaceKey);
  }
  /** Claims exclusive workspace ownership when no conflicting live owner exists. */
  public async claim(input: {
    /** Selected operating mode. */
    readonly mode: WorkspaceProvisionPayload["mode"];
    /** Stable identifier for provision effect id. */
    readonly provisionEffectId: string;
    /** Stable identifier for repository id. */
    readonly repositoryId: string;
    /** Identifies workspace. */
    readonly workspaceKey: string;
  }): Promise<WorkspaceOwnershipRecord> {
    return this.withLock(input.workspaceKey, async () => {
      /** Stores current used by claim. */
      const current = await this.get(input.workspaceKey);
      if (current !== null && current.state === "active") {
        if (
          current.provisionEffectId !== input.provisionEffectId ||
          current.repositoryId !== input.repositoryId ||
          current.mode !== input.mode
        )
          throw new Error("Workspace is owned by another effect");
        return current;
      }
      /** Durable child-node record processed by claim. */
      const record: WorkspaceOwnershipRecord = {
        ...input,
        releaseEffectId: null,
        schema: "workspace-ownership-v1",
        state: "active",
      };
      await this.write(record);
      return record;
    });
  }
  /** Releases workspace ownership held by the matching owner. */
  public async release(input: {
    /** Stable identifier for release effect id. */
    readonly releaseEffectId: string;
    /** Stable identifier for repository id. */
    readonly repositoryId: string;
    /** Identifies workspace. */
    readonly workspaceKey: string;
  }): Promise<WorkspaceOwnershipRecord> {
    return this.withLock(input.workspaceKey, async () => {
      /** Stores current used by release. */
      const current = await this.get(input.workspaceKey);
      if (current === null || current.repositoryId !== input.repositoryId)
        throw new Error("Workspace ownership cannot be released");
      if (current.state === "released") {
        if (current.releaseEffectId !== input.releaseEffectId)
          throw new Error("Workspace was released by another effect");
        return current;
      }
      /** Durable child-node record processed by release. */
      const record: WorkspaceOwnershipRecord = {
        ...current,
        releaseEffectId: input.releaseEffectId,
        state: "released",
      };
      await this.write(record);
      return record;
    });
  }
  /** Persists and verifies the durable provider workspace ownership store record. */
  private async write(record: WorkspaceOwnershipRecord): Promise<void> {
    /** Stores body used by write. */
    const body = canonicalize(toJsonValue(record));
    await this.provider.putOperation({
      body,
      dependencies: [],
      digest: sha256(body),
      idempotencyKey: `workspace-owner:${sha256(body)}`,
      key: key(record.workspaceKey),
      kind: "workspace/ownership",
      state: "active",
      version: "v1",
    });
    /** Stores verified used by write. */
    const verified = await this.get(record.workspaceKey);
    if (verified === null || canonicalize(toJsonValue(verified)) !== body)
      throw new Error("Workspace ownership write did not verify");
  }
  /** Serializes work under the corresponding in-process identity lock. */
  private async withLock<T>(
    workspaceKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    /** Unique owner for this workspace-ownership critical section. */
    const ownerId = `workspace-ownership:${randomUUID()}`;
    /** Lease result that grants or denies the critical section. */
    const acquired = await this.provider.acquireLease({
      expiresAt: new Date(Date.now() + this.claimMilliseconds).toISOString(),
      idempotencyKey: `workspace-ownership-claim:${sha256(workspaceKey)}:${ownerId}`,
      ownerId,
      scope: "task_assignment",
      agentId: "manager/workspace-ownership",
      taskId: `manager/workspace/${sha256(workspaceKey)}`,
    });
    if (!acquired.acquired || acquired.leaseId === null)
      throw new Error(
        `Workspace ownership is already being changed: ${workspaceKey}`,
      );
    try {
      return await operation();
    } finally {
      await this.provider.releaseLease({
        expectedVersion: null,
        leaseId: acquired.leaseId,
        ownerId,
      });
    }
  }
}

/** Validates and returns a bounded provider key. */
function key(workspaceKey: string): string {
  return `workspace/ownership/${sha256(workspaceKey)}`;
}

/** Exact persisted field set for a workspace ownership record. */
const OWNERSHIP_KEYS = [
  "mode",
  "provisionEffectId",
  "releaseEffectId",
  "repositoryId",
  "schema",
  "state",
  "workspaceKey",
] as const;

/** Parses and validates a durable workspace ownership record. */
function parse(value: unknown, workspaceKey: string): WorkspaceOwnershipRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Workspace ownership must be an object");
  /** Parsed candidate awaiting parse validation. */
  const found = value as Record<string, unknown>;
  requireClosedKeys(found);
  /** Stores mode used by parse. */
  const mode = requireMode(found.mode);
  /** Mutable state shared across parse. */
  const state = requireState(found.state);
  /** Stores provision effect id used by parse. */
  const provisionEffectId = requireDigest(
    found.provisionEffectId,
    "provisionEffectId",
  );
  /** Stores release effect id used by parse. */
  const releaseEffectId =
    found.releaseEffectId === null
      ? null
      : requireDigest(found.releaseEffectId, "releaseEffectId");
  if (
    found.schema !== "workspace-ownership-v1" ||
    typeof found.repositoryId !== "string" ||
    found.repositoryId === "" ||
    found.workspaceKey !== workspaceKey
  )
    throw new TypeError("Workspace ownership identity is malformed");
  if (
    (state === "active" && releaseEffectId !== null) ||
    (state === "released" && releaseEffectId === null)
  )
    throw new TypeError("Workspace ownership lifecycle is malformed");
  return {
    mode,
    provisionEffectId,
    releaseEffectId,
    repositoryId: found.repositoryId,
    schema: "workspace-ownership-v1",
    state,
    workspaceKey,
  };
}

/** Returns closed keys or throws when invalid or absent. */
function requireClosedKeys(value: Record<string, unknown>): void {
  if (
    Object.keys(value).sort().join("\0") !==
    [...OWNERSHIP_KEYS].sort().join("\0")
  )
    throw new TypeError("Workspace ownership fields are malformed");
}

/** Returns digest or throws when invalid or absent. */
function requireDigest(value: unknown, field: string): string {
  if (!isSha256Digest(value))
    throw new TypeError(`Workspace ownership ${field} is malformed`);
  return value;
}

/** Returns mode or throws when invalid or absent. */
function requireMode(value: unknown): WorkspaceOwnershipRecord["mode"] {
  if (value !== "mirror" && value !== "worktree")
    throw new TypeError("Workspace ownership mode is malformed");
  return value;
}

/** Returns state or throws when invalid or absent. */
function requireState(value: unknown): WorkspaceOwnershipRecord["state"] {
  if (value !== "active" && value !== "released")
    throw new TypeError("Workspace ownership state is malformed");
  return value;
}
