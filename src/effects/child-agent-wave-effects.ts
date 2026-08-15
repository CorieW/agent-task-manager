// Supervises independent child-agent DAG nodes with provider-backed node receipts.
import { canonicalize } from "../core/canonical-json.js";
import { digestJson, sha256 } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ResourceRecord, ResourceRef } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { ExternalEffectObservation } from "./contracts.js";
import type { ChildAgentNode, ChildAgentWavePayload, ReconcilableEffectAdapter } from "./typed-effect-handlers.js";

export interface ChildAgentNodeInput {
  readonly context: ResourceRecord;
  readonly dependencyReceipts: readonly ChildAgentNodeReceipt[];
  readonly node: ChildAgentNode;
  readonly nodeEffectId: string;
  readonly waveEffectId: string;
}
export interface ChildAgentNodeDriver {
  run(input: ChildAgentNodeInput): Promise<ExternalEffectObservation>;
  reconcile(input: ChildAgentNodeInput): Promise<ExternalEffectObservation>;
}
export interface ChildAgentNodeReceipt {
  readonly evidence: JsonObject;
  readonly externalIdentity: JsonObject;
  readonly nodeEffectId: string;
  readonly nodeKey: string;
  readonly state: "applied" | "failed";
}
interface ChildAgentNodeRecord {
  readonly contextDigest: string;
  readonly contextKey: string;
  readonly definitionId: string;
  readonly dependencyNodeKeys: readonly string[];
  readonly lastObservation: ExternalEffectObservation | null;
  readonly nodeEffectId: string;
  readonly nodeKey: string;
  readonly receipt: ChildAgentNodeReceipt | null;
  readonly schema: "child-agent-node-intent-v1";
  readonly state: "applied" | "failed" | "indeterminate" | "pending";
  readonly waveEffectId: string;
}

export class ProviderChildAgentWaveEffects implements ReconcilableEffectAdapter<ChildAgentWavePayload> {
  public readonly id = "provider-child-agent-wave";
  public readonly version = "1";
  public constructor(private readonly provider: AgentTaskProvider, private readonly driver: ChildAgentNodeDriver) {}

  public async reconcile({ effectId, payload }: { readonly effectId: string; readonly payload: ChildAgentWavePayload }): Promise<ExternalEffectObservation> {
    const receipts = new Map<string, ChildAgentNodeReceipt>(); let missing = false;
    for (const node of payload.nodes) {
      const record = await this.readNode(effectId, node);
      if (record === null) { missing = true; continue; }
      if (record.receipt !== null) { receipts.set(node.nodeKey, record.receipt); continue; }
      const dependencies = node.dependsOn.map((key) => receipts.get(key)).filter((receipt): receipt is ChildAgentNodeReceipt => receipt !== undefined);
      if (dependencies.length !== node.dependsOn.length) { missing = true; continue; }
      const context = await this.context(node.contextResource);
      const observation = await this.driver.reconcile({ context, dependencyReceipts: dependencies, node, nodeEffectId: record.nodeEffectId, waveEffectId: effectId });
      const finalized = await this.updateFromObservation(record, observation);
      if (finalized.receipt !== null) receipts.set(node.nodeKey, finalized.receipt); else missing = true;
    }
    if ([...receipts.values()].some((receipt) => receipt.state === "failed")) return failedWave(receipts);
    if (receipts.size === payload.nodes.length) return appliedWave(effectId, receipts);
    return missing ? notApplied({ completedNodes: receipts.size, totalNodes: payload.nodes.length }) : indeterminate({ completedNodes: receipts.size });
  }

  public async apply({ effectId, payload }: { readonly effectId: string; readonly payload: ChildAgentWavePayload }): Promise<ExternalEffectObservation> {
    const receipts = new Map<string, ChildAgentNodeReceipt>();
    while (receipts.size < payload.nodes.length) {
      const ready = payload.nodes.filter((node) => !receipts.has(node.nodeKey) && node.dependsOn.every((key) => receipts.get(key)?.state === "applied"));
      if (ready.length === 0) return failedWave(receipts, "dependency_failed_or_unresolved");
      const batch = ready.slice(0, payload.maxConcurrency);
      const settled = await Promise.allSettled(batch.map(async (node) => this.executeNode(effectId, node, node.dependsOn.map((key) => requiredReceipt(receipts, key)))));
      const errors: unknown[] = [];
      settled.forEach((result, index) => { if (result.status === "fulfilled") receipts.set(batch[index]?.nodeKey ?? "", result.value); else errors.push(result.reason); });
      if (errors.length > 0) throw new AggregateError(errors, "One or more child-agent nodes became indeterminate");
      if ([...receipts.values()].some((receipt) => receipt.state === "failed")) return failedWave(receipts);
    }
    return appliedWave(effectId, receipts);
  }

  private async executeNode(waveEffectId: string, node: ChildAgentNode, dependencies: readonly ChildAgentNodeReceipt[]): Promise<ChildAgentNodeReceipt> {
    const context = await this.context(node.contextResource);
    let record = await this.readNode(waveEffectId, node);
    if (record === null) {
      record = {
        contextDigest: context.digest, contextKey: context.key, definitionId: node.definitionId, dependencyNodeKeys: [...node.dependsOn], lastObservation: null,
        nodeEffectId: nodeEffectId(waveEffectId, node), nodeKey: node.nodeKey, receipt: null, schema: "child-agent-node-intent-v1", state: "pending", waveEffectId,
      };
      await this.writeNode(record, context);
    }
    if (record.receipt !== null) return record.receipt;
    const input = { context, dependencyReceipts: dependencies, node, nodeEffectId: record.nodeEffectId, waveEffectId };
    const prior = await this.driver.reconcile(input);
    let observation = prior;
    if (prior.state === "not_applied") {
      try { observation = await this.driver.run(input); }
      catch (error) { await this.writeNode({ ...record, lastObservation: { evidence: { errorClass: error instanceof Error ? error.name : "UnknownError" }, externalIdentity: {}, state: "indeterminate" }, state: "indeterminate" }, context); throw error; }
    }
    const finalized = await this.updateFromObservation(record, observation, context);
    if (finalized.receipt === null) throw new Error(`Child-agent node is indeterminate: ${node.nodeKey}`);
    return finalized.receipt;
  }

  private async updateFromObservation(record: ChildAgentNodeRecord, observation: ExternalEffectObservation, knownContext?: ResourceRecord): Promise<ChildAgentNodeRecord> {
    validateObservation(observation);
    const context = knownContext ?? await this.context(record.contextKey);
    if (observation.state === "not_applied") return record;
    if (observation.state === "indeterminate") { const next = { ...record, lastObservation: observation, state: "indeterminate" as const }; await this.writeNode(next, context); return next; }
    const receipt: ChildAgentNodeReceipt = { evidence: observation.evidence, externalIdentity: observation.externalIdentity, nodeEffectId: record.nodeEffectId, nodeKey: record.nodeKey, state: observation.state };
    const next = { ...record, lastObservation: observation, receipt, state: observation.state };
    await this.writeNode(next, context); return next;
  }

  private async context(key: string): Promise<ResourceRecord> {
    const resource = await this.provider.getOptionalResource(key);
    if (resource === null || resource.state !== "active" || resource.digest !== sha256(resource.body)) throw new Error(`Child-agent context Resource is invalid: ${key}`);
    return resource;
  }
  private async readNode(waveEffectId: string, node: ChildAgentNode): Promise<ChildAgentNodeRecord | null> {
    const resource = await this.provider.getOptionalResource(nodeResourceKey(waveEffectId, node.nodeKey)); if (resource === null) return null;
    if (resource.kind !== "system/child-agent-node-intent" || resource.state !== "active" || resource.version !== "v1" || resource.digest !== sha256(resource.body)) throw new Error(`Child-agent node Resource is invalid: ${node.nodeKey}`);
    const record = JSON.parse(resource.body) as ChildAgentNodeRecord; validateNodeRecord(record, waveEffectId, node); return record;
  }
  private async writeNode(record: ChildAgentNodeRecord, context: ResourceRecord): Promise<void> {
    const body = canonicalize(toJsonValue(record));
    const dependency: ResourceRef = { digest: context.digest, key: context.key, version: context.version };
    await this.provider.putResource({ body, dependencies: [dependency], digest: sha256(body), idempotencyKey: `child-node:${record.nodeEffectId}:${sha256(body)}`, key: nodeResourceKey(record.waveEffectId, record.nodeKey), kind: "system/child-agent-node-intent", state: "active", version: "v1" });
    const verified = await this.provider.getOptionalResource(nodeResourceKey(record.waveEffectId, record.nodeKey)); if (verified === null || verified.digest !== sha256(body) || verified.body !== body) throw new Error(`Child-agent node write did not verify: ${record.nodeKey}`);
  }
}

function nodeEffectId(waveEffectId: string, node: ChildAgentNode): string { return digestJson(toJsonValue({ node, waveEffectId })); }
function nodeResourceKey(waveEffectId: string, nodeKey: string): string { return `child-agent-node/${waveEffectId}/${sha256(nodeKey)}`; }
function requiredReceipt(receipts: ReadonlyMap<string, ChildAgentNodeReceipt>, key: string): ChildAgentNodeReceipt { const found = receipts.get(key); if (found === undefined) throw new Error(`Child-agent dependency receipt is missing: ${key}`); return found; }
function validateNodeRecord(record: ChildAgentNodeRecord, waveEffectId: string, node: ChildAgentNode): void { if (record.schema !== "child-agent-node-intent-v1" || record.waveEffectId !== waveEffectId || record.nodeKey !== node.nodeKey || record.nodeEffectId !== nodeEffectId(waveEffectId, node) || record.contextKey !== node.contextResource || record.definitionId !== node.definitionId || record.dependencyNodeKeys.join("\0") !== node.dependsOn.join("\0")) throw new Error(`Child-agent node identity conflicts: ${node.nodeKey}`); }
function validateObservation(observation: ExternalEffectObservation): void { if (!["applied", "failed", "indeterminate", "not_applied"].includes(observation.state)) throw new TypeError("Child-agent observation state is invalid"); toJsonValue(observation.evidence); toJsonValue(observation.externalIdentity); }
function appliedWave(effectId: string, receipts: ReadonlyMap<string, ChildAgentNodeReceipt>): ExternalEffectObservation { const ordered = [...receipts.values()].sort((left, right) => left.nodeKey.localeCompare(right.nodeKey)); return { evidence: { nodeReceiptRoot: digestJson(toJsonValue(ordered)), nodeCount: ordered.length }, externalIdentity: { waveEffectId: effectId }, state: "applied" }; }
function failedWave(receipts: ReadonlyMap<string, ChildAgentNodeReceipt>, reason = "node_failed"): ExternalEffectObservation { return { evidence: { completedNodes: receipts.size, failedNodes: [...receipts.values()].filter((receipt) => receipt.state === "failed").map((receipt) => receipt.nodeKey).sort(), reason }, externalIdentity: {}, state: "failed" }; }
function notApplied(evidence: JsonObject): ExternalEffectObservation { return { evidence, externalIdentity: {}, state: "not_applied" }; }
function indeterminate(evidence: JsonObject): ExternalEffectObservation { return { evidence, externalIdentity: {}, state: "indeterminate" }; }
