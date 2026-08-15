/** Supervises independent child-agent DAG nodes with provider-backed node receipts. */
import { canonicalize } from "../core/canonical-json.js";
import { digestJson, sha256 } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ResourceRecord, ResourceRef } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type {
  ExternalEffectControl,
  ExternalEffectObservation,
} from "./contracts.js";
import {
  createEffectObservation,
  validateEffectObservation,
} from "./observations.js";
import type {
  ChildAgentNode,
  ChildAgentWavePayload,
  ReconcilableEffectAdapter,
} from "./typed-effect-handlers.js";

export interface ChildAgentNodeInput {
  readonly control: ExternalEffectControl;
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
  readonly contextVersion: string;
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
  public constructor(
    private readonly provider: AgentTaskProvider,
    private readonly driver: ChildAgentNodeDriver,
  ) {}

  public async reconcile({
    control,
    effectId,
    payload,
  }: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly payload: ChildAgentWavePayload;
  }): Promise<ExternalEffectObservation> {
    const receipts = new Map<string, ChildAgentNodeReceipt>();
    for (const node of payload.nodes) {
      const record = await this.readNode(effectId, node);
      if (record === null) continue;
      const context = await this.context(node);
      if (record.receipt !== null) {
        receipts.set(node.nodeKey, record.receipt);
        continue;
      }
      const dependencies = node.dependsOn
        .map((key) => receipts.get(key))
        .filter(
          (receipt): receipt is ChildAgentNodeReceipt => receipt !== undefined,
        );
      if (dependencies.length !== node.dependsOn.length) continue;
      const observation = await this.driver.reconcile({
        context,
        control,
        dependencyReceipts: dependencies,
        node,
        nodeEffectId: record.nodeEffectId,
        waveEffectId: effectId,
      });
      const finalized = await this.updateFromObservation(record, observation);
      if (finalized.receipt !== null)
        receipts.set(node.nodeKey, finalized.receipt);
    }
    if ([...receipts.values()].some((receipt) => receipt.state === "failed"))
      return failedWave(receipts);
    if (receipts.size === payload.nodes.length)
      return appliedWave(effectId, receipts);
    return notApplied({
      completedNodes: receipts.size,
      totalNodes: payload.nodes.length,
    });
  }

  public async apply({
    control,
    effectId,
    payload,
  }: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly payload: ChildAgentWavePayload;
  }): Promise<ExternalEffectObservation> {
    const receipts = new Map<string, ChildAgentNodeReceipt>();
    while (receipts.size < payload.nodes.length) {
      const ready = payload.nodes.filter(
        (node) =>
          !receipts.has(node.nodeKey) &&
          node.dependsOn.every((key) => receipts.get(key)?.state === "applied"),
      );
      if (ready.length === 0)
        return failedWave(receipts, "dependency_failed_or_unresolved");
      const batch = ready.slice(0, payload.maxConcurrency);
      if (control.signal.aborted || control.deadlineAt <= Date.now())
        throw new Error("Child-agent wave was cancelled");
      const settled = await Promise.allSettled(
        batch.map(async (node) =>
          this.executeNode(
            control,
            effectId,
            node,
            node.dependsOn.map((key) => requiredReceipt(receipts, key)),
          ),
        ),
      );
      const errors: unknown[] = [];
      settled.forEach((result, index) => {
        if (result.status === "fulfilled")
          receipts.set(batch[index]?.nodeKey ?? "", result.value);
        else errors.push(result.reason);
      });
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          "One or more child-agent nodes became indeterminate",
        );
      if ([...receipts.values()].some((receipt) => receipt.state === "failed"))
        return failedWave(receipts);
    }
    return appliedWave(effectId, receipts);
  }

  private async executeNode(
    control: ExternalEffectControl,
    waveEffectId: string,
    node: ChildAgentNode,
    dependencies: readonly ChildAgentNodeReceipt[],
  ): Promise<ChildAgentNodeReceipt> {
    const context = await this.context(node);
    let record = await this.readNode(waveEffectId, node);
    if (record === null) {
      record = {
        contextDigest: context.digest,
        contextKey: context.key,
        contextVersion: context.version,
        definitionId: node.definitionId,
        dependencyNodeKeys: [...node.dependsOn],
        lastObservation: null,
        nodeEffectId: nodeEffectId(waveEffectId, node),
        nodeKey: node.nodeKey,
        receipt: null,
        schema: "child-agent-node-intent-v1",
        state: "pending",
        waveEffectId,
      };
      await this.writeNode(record, context);
    }
    if (record.contextDigest !== context.digest)
      throw new Error(
        `Child-agent context changed after node creation: ${node.nodeKey}`,
      );
    if (record.receipt !== null) return record.receipt;
    const input = {
      context,
      control,
      dependencyReceipts: dependencies,
      node,
      nodeEffectId: record.nodeEffectId,
      waveEffectId,
    };
    const prior = await this.driver.reconcile(input);
    let observation = prior;
    if (prior.state === "not_applied") {
      try {
        observation = await this.driver.run(input);
      } catch (error) {
        await this.writeNode(
          {
            ...record,
            lastObservation: {
              evidence: {
                errorClass:
                  error instanceof Error ? error.name : "UnknownError",
              },
              externalIdentity: {},
              state: "indeterminate",
            },
            state: "indeterminate",
          },
          context,
        );
        throw error;
      }
    }
    const finalized = await this.updateFromObservation(
      record,
      observation,
      context,
    );
    if (finalized.receipt === null)
      throw new Error(`Child-agent node is indeterminate: ${node.nodeKey}`);
    return finalized.receipt;
  }

  private async updateFromObservation(
    record: ChildAgentNodeRecord,
    observation: ExternalEffectObservation,
    knownContext?: ResourceRecord,
  ): Promise<ChildAgentNodeRecord> {
    validateEffectObservation(observation);
    const context =
      knownContext ??
      (await this.context({
        contextDigest: record.contextDigest,
        contextResource: record.contextKey,
        contextVersion: record.contextVersion,
        definitionId: record.definitionId,
        dependsOn: record.dependencyNodeKeys,
        nodeKey: record.nodeKey,
      }));
    if (observation.state === "not_applied") return record;
    if (observation.state === "indeterminate") {
      const next = {
        ...record,
        lastObservation: observation,
        state: "indeterminate" as const,
      };
      await this.writeNode(next, context);
      return next;
    }
    const receipt: ChildAgentNodeReceipt = {
      evidence: observation.evidence,
      externalIdentity: observation.externalIdentity,
      nodeEffectId: record.nodeEffectId,
      nodeKey: record.nodeKey,
      state: observation.state,
    };
    const next = {
      ...record,
      lastObservation: observation,
      receipt,
      state: observation.state,
    };
    await this.writeNode(next, context);
    return next;
  }

  private async context(node: ChildAgentNode): Promise<ResourceRecord> {
    const resource = await this.provider.getOptionalResource(
      node.contextResource,
    );
    if (
      resource === null ||
      resource.state !== "active" ||
      resource.kind !== "agent/context" ||
      resource.digest !== sha256(resource.body) ||
      resource.digest !== node.contextDigest ||
      resource.version !== node.contextVersion
    )
      throw new Error(
        `Child-agent context Resource is invalid: ${node.contextResource}`,
      );
    return resource;
  }
  private async readNode(
    waveEffectId: string,
    node: ChildAgentNode,
  ): Promise<ChildAgentNodeRecord | null> {
    const resource = await this.provider.getOptionalResource(
      nodeResourceKey(waveEffectId, node.nodeKey),
    );
    if (resource === null) return null;
    if (
      resource.kind !== "system/child-agent-node-intent" ||
      resource.state !== "active" ||
      resource.version !== "v1" ||
      resource.digest !== sha256(resource.body)
    )
      throw new Error(`Child-agent node Resource is invalid: ${node.nodeKey}`);
    const record = parseNodeRecord(
      JSON.parse(resource.body) as unknown,
      waveEffectId,
      node,
    );
    const dependency = resource.dependencies[0];
    if (
      resource.dependencies.length !== 1 ||
      dependency?.key !== record.contextKey ||
      dependency.digest !== record.contextDigest ||
      dependency.version === null
    )
      throw new Error(
        `Child-agent node context pin is invalid: ${node.nodeKey}`,
      );
    return record;
  }
  private async writeNode(
    record: ChildAgentNodeRecord,
    context: ResourceRecord,
  ): Promise<void> {
    const body = canonicalize(toJsonValue(record));
    const dependency: ResourceRef = {
      digest: context.digest,
      key: context.key,
      version: context.version,
    };
    await this.provider.putResource({
      body,
      dependencies: [dependency],
      digest: sha256(body),
      idempotencyKey: `child-node:${record.nodeEffectId}:${sha256(body)}`,
      key: nodeResourceKey(record.waveEffectId, record.nodeKey),
      kind: "system/child-agent-node-intent",
      state: "active",
      version: "v1",
    });
    const verified = await this.provider.getOptionalResource(
      nodeResourceKey(record.waveEffectId, record.nodeKey),
    );
    if (
      verified === null ||
      verified.digest !== sha256(body) ||
      verified.body !== body
    )
      throw new Error(
        `Child-agent node write did not verify: ${record.nodeKey}`,
      );
  }
}

function nodeEffectId(waveEffectId: string, node: ChildAgentNode): string {
  return digestJson(toJsonValue({ node, waveEffectId }));
}
function nodeResourceKey(waveEffectId: string, nodeKey: string): string {
  return `child-agent-node/${waveEffectId}/${sha256(nodeKey)}`;
}
function requiredReceipt(
  receipts: ReadonlyMap<string, ChildAgentNodeReceipt>,
  key: string,
): ChildAgentNodeReceipt {
  const found = receipts.get(key);
  if (found === undefined)
    throw new Error(`Child-agent dependency receipt is missing: ${key}`);
  return found;
}
function parseNodeRecord(
  value: unknown,
  waveEffectId: string,
  node: ChildAgentNode,
): ChildAgentNodeRecord {
  const record = object(value, "Child-agent node record");
  exact(record, [
    "contextDigest",
    "contextKey",
    "contextVersion",
    "definitionId",
    "dependencyNodeKeys",
    "lastObservation",
    "nodeEffectId",
    "nodeKey",
    "receipt",
    "schema",
    "state",
    "waveEffectId",
  ]);
  const state = record.state;
  if (
    record.schema !== "child-agent-node-intent-v1" ||
    !["applied", "failed", "indeterminate", "pending"].includes(String(state))
  )
    throw new TypeError("Child-agent node record schema or state is invalid");
  const parsed: ChildAgentNodeRecord = {
    contextDigest: digest(record.contextDigest, "contextDigest"),
    contextKey: string(record.contextKey, "contextKey"),
    contextVersion: string(record.contextVersion, "contextVersion"),
    definitionId: string(record.definitionId, "definitionId"),
    dependencyNodeKeys: strings(
      record.dependencyNodeKeys,
      "dependencyNodeKeys",
    ),
    lastObservation:
      record.lastObservation === null
        ? null
        : observation(record.lastObservation),
    nodeEffectId: digest(record.nodeEffectId, "nodeEffectId"),
    nodeKey: string(record.nodeKey, "nodeKey"),
    receipt: record.receipt === null ? null : receipt(record.receipt),
    schema: "child-agent-node-intent-v1",
    state: state as ChildAgentNodeRecord["state"],
    waveEffectId: digest(record.waveEffectId, "waveEffectId"),
  };
  if (
    parsed.waveEffectId !== waveEffectId ||
    parsed.nodeKey !== node.nodeKey ||
    parsed.nodeEffectId !== nodeEffectId(waveEffectId, node) ||
    parsed.contextKey !== node.contextResource ||
    parsed.contextDigest !== node.contextDigest ||
    parsed.contextVersion !== node.contextVersion ||
    parsed.definitionId !== node.definitionId ||
    parsed.dependencyNodeKeys.join("\0") !== node.dependsOn.join("\0")
  )
    throw new Error(`Child-agent node identity conflicts: ${node.nodeKey}`);
  if (
    (parsed.state === "pending" &&
      (parsed.lastObservation !== null || parsed.receipt !== null)) ||
    (parsed.state === "indeterminate" &&
      (parsed.lastObservation?.state !== "indeterminate" ||
        parsed.receipt !== null)) ||
    ((parsed.state === "applied" || parsed.state === "failed") &&
      (parsed.lastObservation?.state !== parsed.state ||
        parsed.receipt?.state !== parsed.state))
  )
    throw new TypeError("Child-agent node lifecycle is invalid");
  if (
    parsed.receipt !== null &&
    (parsed.receipt.nodeEffectId !== parsed.nodeEffectId ||
      parsed.receipt.nodeKey !== parsed.nodeKey)
  )
    throw new TypeError("Child-agent node receipt identity is invalid");
  return structuredClone(parsed);
}
function receipt(value: unknown): ChildAgentNodeReceipt {
  const found = object(value, "Child-agent node receipt");
  exact(found, [
    "evidence",
    "externalIdentity",
    "nodeEffectId",
    "nodeKey",
    "state",
  ]);
  if (found.state !== "applied" && found.state !== "failed")
    throw new TypeError("Child-agent node receipt state is invalid");
  return {
    evidence: json(found.evidence, "receipt evidence"),
    externalIdentity: json(found.externalIdentity, "receipt identity"),
    nodeEffectId: digest(found.nodeEffectId, "receipt nodeEffectId"),
    nodeKey: string(found.nodeKey, "receipt nodeKey"),
    state: found.state,
  };
}
function observation(value: unknown): ExternalEffectObservation {
  const found = object(value, "Child-agent observation");
  exact(found, ["evidence", "externalIdentity", "state"]);
  const parsed = {
    evidence: json(found.evidence, "observation evidence"),
    externalIdentity: json(found.externalIdentity, "observation identity"),
    state: found.state as ExternalEffectObservation["state"],
  };
  validateEffectObservation(parsed);
  return parsed;
}
function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as JsonObject;
}
function json(value: unknown, label: string): JsonObject {
  const converted = toJsonValue(value);
  if (
    converted === null ||
    typeof converted !== "object" ||
    Array.isArray(converted)
  )
    throw new TypeError(`${label} must be an object`);
  return converted;
}
function exact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new TypeError("Child-agent record has unexpected or missing fields");
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result))
    throw new TypeError(`${label} must be a digest`);
  return result;
}
function strings(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry === "") ||
    new Set(value).size !== value.length
  )
    throw new TypeError(`${label} must contain unique strings`);
  return [...value] as string[];
}
function appliedWave(
  effectId: string,
  receipts: ReadonlyMap<string, ChildAgentNodeReceipt>,
): ExternalEffectObservation {
  const ordered = [...receipts.values()].sort((left, right) =>
    left.nodeKey.localeCompare(right.nodeKey),
  );
  return createEffectObservation(
    "applied",
    {
      nodeReceiptRoot: digestJson(toJsonValue(ordered)),
      nodeCount: ordered.length,
    },
    { waveEffectId: effectId },
  );
}
function failedWave(
  receipts: ReadonlyMap<string, ChildAgentNodeReceipt>,
  reason = "node_failed",
): ExternalEffectObservation {
  return createEffectObservation("failed", {
    completedNodes: receipts.size,
    failedNodes: [...receipts.values()]
      .filter((receipt) => receipt.state === "failed")
      .map((receipt) => receipt.nodeKey)
      .sort(),
    reason,
  });
}
function notApplied(evidence: JsonObject): ExternalEffectObservation {
  return createEffectObservation("not_applied", evidence);
}
