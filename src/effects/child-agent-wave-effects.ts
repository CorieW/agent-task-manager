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

/** Inputs accepted by child agent node. */
export interface ChildAgentNodeInput {
  /** Ordered control accepted by child agent node input. */
  readonly control: ExternalEffectControl;
  /** Ordered context accepted by child agent node input. */
  readonly context: ResourceRecord;
  /** Ordered the dependency receipts used by this contract. */
  readonly dependencyReceipts: readonly ChildAgentNodeReceipt[];
  /** Child-node specification executed by the wave. */
  readonly node: ChildAgentNode;
  /** Stable identifier for node effect id. */
  readonly nodeEffectId: string;
  /** Stable identifier for wave effect id. */
  readonly waveEffectId: string;
}

/** Child agent node driver boundary. */
export interface ChildAgentNodeDriver {
  /** Runs child agent node driver within its configured limits. */
  run(input: ChildAgentNodeInput): Promise<ExternalEffectObservation>;
  /** Reconciles previously observed child-node execution state. */
  reconcile(input: ChildAgentNodeInput): Promise<ExternalEffectObservation>;
}

/** Durable receipt returned by child agent node. */
export interface ChildAgentNodeReceipt {
  /** Canonical evidence used to verify the observed effect. */
  readonly evidence: JsonObject;
  /** Provider identity used to correlate the external effect. */
  readonly externalIdentity: JsonObject;
  /** Stable identifier for node effect id. */
  readonly nodeEffectId: string;
  /** Stable key of the child node. */
  readonly nodeKey: string;
  /** Lifecycle state used for workflow decisions. */
  readonly state: "applied" | "failed";
}

/** Persisted state for child agent node. */
interface ChildAgentNodeRecord {
  /** SHA-256 digest of canonical context. */
  readonly contextDigest: string;
  /** Resource key of the node's immutable context. */
  readonly contextKey: string;
  /** Opaque version token for context. */
  readonly contextVersion: string;
  /** Stable identifier for definition id. */
  readonly definitionId: string;
  /** Ordered the dependency node keys used by this contract. */
  readonly dependencyNodeKeys: readonly string[];
  /** Most recent durable observation, or null before reconciliation. */
  readonly lastObservation: ExternalEffectObservation | null;
  /** Stable identifier for node effect id. */
  readonly nodeEffectId: string;
  /** Stable key of the child node. */
  readonly nodeKey: string;
  /** Applied-effect receipt, or null until mutation succeeds. */
  readonly receipt: ChildAgentNodeReceipt | null;
  /** Version tag for the child agent node record representation. */
  readonly schema: "child-agent-node-intent-v1";
  /** Lifecycle state used for workflow decisions. */
  readonly state: "applied" | "failed" | "indeterminate" | "pending";
  /** Stable identifier for wave effect id. */
  readonly waveEffectId: string;
}

/** Implements provider child agent wave effects and its boundary checks. */
export class ProviderChildAgentWaveEffects implements ReconcilableEffectAdapter<ChildAgentWavePayload> {
  /** Stable identifier for provider child agent wave effects. */
  public readonly id = "provider-child-agent-wave";
  /** Opaque version token used for compatibility checks. */
  public readonly version = "1";
  /** Creates provider child agent wave effects with its required collaborators. */
  public constructor(
    /** Provider boundary used for durable state reads and writes. */ private readonly provider: AgentTaskProvider,
    /** Driver used to control the underlying runtime. */ private readonly driver: ChildAgentNodeDriver,
  ) {}

  /** Reconciles a durable child-agent wave before running new nodes. */
  public async reconcile({
    control,
    effectId,
    payload,
  }: {
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Validated effect payload. */
    readonly payload: ChildAgentWavePayload;
  }): Promise<ExternalEffectObservation> {
    /** Indexes receipts for deterministic lookup by reconcile. */
    const receipts = new Map<string, ChildAgentNodeReceipt>();
    for (const node of payload.nodes) {
      /** Durable child-node record processed by reconcile. */
      const record = await this.readNode(effectId, node);
      if (record === null) continue;
      /** Result of `this.context`, retained for the reconcile operation. */
      const context = await this.context(node);
      if (record.receipt !== null) {
        receipts.set(node.nodeKey, record.receipt);
        continue;
      }
      /** Derived dependencies value for the reconcile operation. */
      const dependencies = node.dependsOn
        .map((key) => receipts.get(key))
        .filter(
          (receipt): receipt is ChildAgentNodeReceipt => receipt !== undefined,
        );
      if (dependencies.length !== node.dependsOn.length) continue;
      /** Result of `this.driver.reconcile`, retained for the reconcile operation. */
      const observation = await this.driver.reconcile({
        context,
        control,
        dependencyReceipts: dependencies,
        node,
        nodeEffectId: record.nodeEffectId,
        waveEffectId: effectId,
      });
      /** Result of `this.updateFromObservation`, retained for the reconcile operation. */
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

  /** Applies one bounded child-agent wave. */
  public async apply({
    control,
    effectId,
    payload,
  }: {
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Validated effect payload. */
    readonly payload: ChildAgentWavePayload;
  }): Promise<ExternalEffectObservation> {
    /** Indexes receipts for deterministic lookup by apply. */
    const receipts = new Map<string, ChildAgentNodeReceipt>();
    while (receipts.size < payload.nodes.length) {
      /** Result of `payload.nodes.filter`, retained for the apply operation. */
      const ready = payload.nodes.filter(
        (node) =>
          !receipts.has(node.nodeKey) &&
          node.dependsOn.every((key) => receipts.get(key)?.state === "applied"),
      );
      if (ready.length === 0)
        return failedWave(receipts, "dependency_failed_or_unresolved");
      /** Result of `ready.slice`, retained for the apply operation. */
      const batch = ready.slice(0, payload.maxConcurrency);
      if (control.signal.aborted || control.deadlineAt <= Date.now())
        throw new Error("Child-agent wave was cancelled");
      /** Result of `Promise.allSettled`, retained for the apply operation. */
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
      /** Collects errors discovered by apply. */
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

  /** Executes one ready child-agent node and persists its terminal receipt. */
  private async executeNode(
    control: ExternalEffectControl,
    waveEffectId: string,
    node: ChildAgentNode,
    dependencies: readonly ChildAgentNodeReceipt[],
  ): Promise<ChildAgentNodeReceipt> {
    /** Result of `this.context`, retained for the execute node operation. */
    const context = await this.context(node);
    /** Durable child-node record processed by execute node. */
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
    /** Input snapshot used consistently during the execute node operation. */
    const input = {
      context,
      control,
      dependencyReceipts: dependencies,
      node,
      nodeEffectId: record.nodeEffectId,
      waveEffectId,
    };
    /** Result of `this.driver.reconcile`, retained for the execute node operation. */
    const prior = await this.driver.reconcile(input);
    /** Result of `this.driver.run`, retained for the execute node operation. */
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
    /** Result of `this.updateFromObservation`, retained for the execute node operation. */
    const finalized = await this.updateFromObservation(
      record,
      observation,
      context,
    );
    if (finalized.receipt === null)
      throw new Error(`Child-agent node is indeterminate: ${node.nodeKey}`);
    return finalized.receipt;
  }

  /** Validates an observation and persists the resulting node state and receipt. */
  private async updateFromObservation(
    record: ChildAgentNodeRecord,
    observation: ExternalEffectObservation,
    knownContext?: ResourceRecord,
  ): Promise<ChildAgentNodeRecord> {
    validateEffectObservation(observation);
    /** Context snapshot used consistently during the update from observation operation. */
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
      /** Next snapshot used consistently during the update from observation operation. */
      const next = {
        ...record,
        lastObservation: observation,
        state: "indeterminate" as const,
      };
      await this.writeNode(next, context);
      return next;
    }
    /** Receipt produced by update from observation. */
    const receipt: ChildAgentNodeReceipt = {
      evidence: observation.evidence,
      externalIdentity: observation.externalIdentity,
      nodeEffectId: record.nodeEffectId,
      nodeKey: record.nodeKey,
      state: observation.state,
    };
    /** Next snapshot used consistently during the update from observation operation. */
    const next = {
      ...record,
      lastObservation: observation,
      receipt,
      state: observation.state,
    };
    await this.writeNode(next, context);
    return next;
  }

  /** Loads and verifies the immutable context Resource for a child node. */
  private async context(node: ChildAgentNode): Promise<ResourceRecord> {
    /** Result of `this.provider.getOptionalResource`, retained for the context operation. */
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
  /** Reads node without mutating external state. */
  private async readNode(
    waveEffectId: string,
    node: ChildAgentNode,
  ): Promise<ChildAgentNodeRecord | null> {
    /** Result of `this.provider.getOptionalResource`, retained for the read node operation. */
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
    /** Durable child-node record processed by read node. */
    const record = parseNodeRecord(
      JSON.parse(resource.body) as unknown,
      waveEffectId,
      node,
    );
    /** Dependency snapshot used consistently during the read node operation. */
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
  /** Persists and post-verifies a child-node intent record. */
  private async writeNode(
    record: ChildAgentNodeRecord,
    context: ResourceRecord,
  ): Promise<void> {
    /** Result of `canonicalize`, retained for the write node operation. */
    const body = canonicalize(toJsonValue(record));
    /** Dependency snapshot used consistently during the write node operation. */
    const dependency: ResourceRef = {
      digest: context.digest,
      key: context.key,
      version: context.version,
    };
    await this.provider.putSystemResource({
      body,
      dependencies: [dependency],
      digest: sha256(body),
      idempotencyKey: `child-node:${record.nodeEffectId}:${sha256(body)}`,
      key: nodeResourceKey(record.waveEffectId, record.nodeKey),
      kind: "system/child-agent-node-intent",
      state: "active",
      version: "v1",
    });
    /** Result of `this.provider.getOptionalResource`, retained for the write node operation. */
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

/** Builds the deterministic provider key for this durable record. */
function nodeEffectId(waveEffectId: string, node: ChildAgentNode): string {
  return digestJson(toJsonValue({ node, waveEffectId }));
}

/** Builds the deterministic provider key for this durable record. */
function nodeResourceKey(waveEffectId: string, nodeKey: string): string {
  return `child-agent-node/${waveEffectId}/${sha256(nodeKey)}`;
}

/** Returns d receipt or throws when invalid or absent. */
function requiredReceipt(
  receipts: ReadonlyMap<string, ChildAgentNodeReceipt>,
  key: string,
): ChildAgentNodeReceipt {
  /** Parsed candidate awaiting required receipt validation. */
  const found = receipts.get(key);
  if (found === undefined)
    throw new Error(`Child-agent dependency receipt is missing: ${key}`);
  return found;
}

/** Parses and validates node record. */
function parseNodeRecord(
  value: unknown,
  waveEffectId: string,
  node: ChildAgentNode,
): ChildAgentNodeRecord {
  /** Durable child-node record processed by parse node record. */
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
  /** Mutable state shared across parse node record. */
  const state = record.state;
  if (
    record.schema !== "child-agent-node-intent-v1" ||
    !["applied", "failed", "indeterminate", "pending"].includes(String(state))
  )
    throw new TypeError("Child-agent node record schema or state is invalid");
  /** Parsed snapshot used consistently during the parse node record operation. */
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

/** Parses and validates the persisted external-effect value. */
function receipt(value: unknown): ChildAgentNodeReceipt {
  /** Parsed candidate awaiting receipt validation. */
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

/** Parses and validates the persisted external-effect value. */
function observation(value: unknown): ExternalEffectObservation {
  /** Parsed candidate awaiting observation validation. */
  const found = object(value, "Child-agent observation");
  exact(found, ["evidence", "externalIdentity", "state"]);
  /** Parsed snapshot used consistently during the observation operation. */
  const parsed = {
    evidence: json(found.evidence, "observation evidence"),
    externalIdentity: json(found.externalIdentity, "observation identity"),
    state: found.state as ExternalEffectObservation["state"],
  };
  validateEffectObservation(parsed);
  return parsed;
}

/** Validates and returns the required object representation. */
function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as JsonObject;
}

/** Validates and returns the required object representation. */
function json(value: unknown, label: string): JsonObject {
  /** Result of `toJsonValue`, retained for the json operation. */
  const converted = toJsonValue(value);
  if (
    converted === null ||
    typeof converted !== "object" ||
    Array.isArray(converted)
  )
    throw new TypeError(`${label} must be an object`);
  return converted;
}

/** Rejects objects whose keys differ from the expected closed shape. */
function exact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new TypeError("Child-agent record has unexpected or missing fields");
}

/** Validates and returns a non-empty string. */
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/** Validates and returns a lowercase SHA-256 digest. */
function digest(value: unknown, label: string): string {
  /** Validated result returned by digest. */
  const result = string(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result))
    throw new TypeError(`${label} must be a digest`);
  return result;
}

/** Validates and returns unique non-empty strings. */
function strings(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry === "") ||
    new Set(value).size !== value.length
  )
    throw new TypeError(`${label} must contain unique strings`);
  return [...value] as string[];
}

/** Builds a terminal wave observation from ordered child receipts. */
function appliedWave(
  effectId: string,
  receipts: ReadonlyMap<string, ChildAgentNodeReceipt>,
): ExternalEffectObservation {
  /** Derived ordered value for the applied wave operation. */
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

/** Builds a terminal wave observation from ordered child receipts. */
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

/** Creates the corresponding canonical external-effect observation. */
function notApplied(evidence: JsonObject): ExternalEffectObservation {
  return createEffectObservation("not_applied", evidence);
}
