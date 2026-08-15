// Persists workspace ownership exclusively in provider Resources for crash recovery.
import { canonicalize } from "../core/canonical-json.js";
import { randomUUID } from "node:crypto";
import { sha256 } from "../core/digest.js";
import { toJsonValue } from "../domain/json.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { WorkspaceProvisionPayload } from "./typed-effect-handlers.js";

export interface WorkspaceOwnershipRecord {
  readonly mode: WorkspaceProvisionPayload["mode"];
  readonly provisionEffectId: string;
  readonly releaseEffectId: string | null;
  readonly repositoryId: string;
  readonly schema: "workspace-ownership-v1";
  readonly state: "active" | "released";
  readonly workspaceKey: string;
}
export interface WorkspaceOwnershipStore {
  claim(input: { readonly mode: WorkspaceProvisionPayload["mode"]; readonly provisionEffectId: string; readonly repositoryId: string; readonly workspaceKey: string }): Promise<WorkspaceOwnershipRecord>;
  get(workspaceKey: string): Promise<WorkspaceOwnershipRecord | null>;
  release(input: { readonly releaseEffectId: string; readonly repositoryId: string; readonly workspaceKey: string }): Promise<WorkspaceOwnershipRecord>;
}

export class ProviderWorkspaceOwnershipStore implements WorkspaceOwnershipStore {
  public constructor(private readonly provider: AgentTaskProvider, private readonly claimMilliseconds = 60_000) {}
  public async get(workspaceKey: string): Promise<WorkspaceOwnershipRecord | null> {
    const resource = await this.provider.getOptionalResource(key(workspaceKey)); if (resource === null) return null;
    if (resource.kind !== "system/workspace-ownership" || resource.state !== "active" || resource.version !== "v1" || resource.digest !== sha256(resource.body)) throw new Error(`Workspace ownership Resource is invalid: ${workspaceKey}`);
    return parse(JSON.parse(resource.body) as unknown, workspaceKey);
  }
  public async claim(input: { readonly mode: WorkspaceProvisionPayload["mode"]; readonly provisionEffectId: string; readonly repositoryId: string; readonly workspaceKey: string }): Promise<WorkspaceOwnershipRecord> {
    return this.withLock(input.workspaceKey, async () => {
      const current = await this.get(input.workspaceKey);
      if (current !== null && current.state === "active") {
        if (current.provisionEffectId !== input.provisionEffectId || current.repositoryId !== input.repositoryId || current.mode !== input.mode) throw new Error("Workspace is owned by another effect");
        return current;
      }
      const record: WorkspaceOwnershipRecord = { ...input, releaseEffectId: null, schema: "workspace-ownership-v1", state: "active" };
      await this.write(record); return record;
    });
  }
  public async release(input: { readonly releaseEffectId: string; readonly repositoryId: string; readonly workspaceKey: string }): Promise<WorkspaceOwnershipRecord> {
    return this.withLock(input.workspaceKey, async () => {
      const current = await this.get(input.workspaceKey); if (current === null || current.repositoryId !== input.repositoryId) throw new Error("Workspace ownership cannot be released");
      if (current.state === "released") { if (current.releaseEffectId !== input.releaseEffectId) throw new Error("Workspace was released by another effect"); return current; }
      const record: WorkspaceOwnershipRecord = { ...current, releaseEffectId: input.releaseEffectId, state: "released" }; await this.write(record); return record;
    });
  }
  private async write(record: WorkspaceOwnershipRecord): Promise<void> { const body = canonicalize(toJsonValue(record)); await this.provider.putResource({ body, dependencies: [], digest: sha256(body), idempotencyKey: `workspace-owner:${sha256(body)}`, key: key(record.workspaceKey), kind: "system/workspace-ownership", state: "active", version: "v1" }); const verified = await this.get(record.workspaceKey); if (verified === null || canonicalize(toJsonValue(verified)) !== body) throw new Error("Workspace ownership write did not verify"); }
  private async withLock<T>(workspaceKey: string, operation: () => Promise<T>): Promise<T> {
    const ownerId = `workspace-ownership:${randomUUID()}`;
    const acquired = await this.provider.acquireLease({ expiresAt: new Date(Date.now() + this.claimMilliseconds).toISOString(), idempotencyKey: `workspace-ownership-claim:${sha256(workspaceKey)}:${ownerId}`, ownerId, scope: "task_assignment", subAgentId: "system/workspace-ownership", taskId: `system/workspace/${sha256(workspaceKey)}` });
    if (!acquired.acquired || acquired.leaseId === null) throw new Error(`Workspace ownership is already being changed: ${workspaceKey}`);
    try { return await operation(); } finally { await this.provider.releaseLease({ leaseId: acquired.leaseId, ownerId }); }
  }
}
function key(workspaceKey: string): string { return `workspace-ownership/${sha256(workspaceKey)}`; }
function parse(value: unknown, workspaceKey: string): WorkspaceOwnershipRecord { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Workspace ownership must be an object"); const found = value as Record<string, unknown>; if (Object.keys(found).sort().join("\0") !== ["mode", "provisionEffectId", "releaseEffectId", "repositoryId", "schema", "state", "workspaceKey"].sort().join("\0") || found.schema !== "workspace-ownership-v1" || (found.mode !== "mirror" && found.mode !== "worktree") || (found.state !== "active" && found.state !== "released") || typeof found.provisionEffectId !== "string" || !/^[a-f0-9]{64}$/u.test(found.provisionEffectId) || (found.releaseEffectId !== null && (typeof found.releaseEffectId !== "string" || !/^[a-f0-9]{64}$/u.test(found.releaseEffectId))) || typeof found.repositoryId !== "string" || found.repositoryId === "" || found.workspaceKey !== workspaceKey) throw new TypeError("Workspace ownership is malformed"); return structuredClone(found) as unknown as WorkspaceOwnershipRecord; }
