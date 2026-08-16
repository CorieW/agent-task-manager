/** Materializes immutable, digest-pinned Agent contexts for trusted child-wave execution. */
import { canonicalize } from "../core/canonical-json.js";
import { digestJson, sha256 } from "../core/digest.js";
import type { ActivatedDefinition } from "../core/definition-activation.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ResourceRecord, TaskSnapshot } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";

/** Catalog entry supplied to a parent Agent before it proposes a child wave. */
export interface AgentContextCatalogEntry {
  /** Digest of the immutable context body. */
  readonly contextDigest: string;
  /** Provider Resource key containing the context. */
  readonly contextResource: string;
  /** Resource version pinned by the child-wave request. */
  readonly contextVersion: string;
  /** Child Agent definition represented by the context. */
  readonly definitionId: string;
}

/** Canonical body persisted for one child Agent context. */
export interface AgentContextBody {
  /** Parent Agent activation authorizing delegation. */
  readonly parentActivationDigest: string;
  /** Wire schema for this context. */
  readonly schema: "agent-context-v1";
  /** Immutable Task snapshot delegated to the child. */
  readonly task: JsonObject;
  /** Child activation selected for this context. */
  readonly targetActivationDigest: string;
  /** Child definition digest selected for this context. */
  readonly targetDefinitionDigest: string;
  /** Exact child Resource pins validated during activation. */
  readonly targetResourcePins: readonly JsonObject[];
}

/** Persists and verifies one context per eligible child definition. */
export async function materializeAgentContexts(input: {
  /** Parent Agent that may propose the child wave. */
  readonly parent: ActivatedDefinition;
  /** Provider used for managed Resource persistence. */
  readonly provider: AgentTaskProvider;
  /** Child definitions made available to the parent. */
  readonly targets: readonly ActivatedDefinition[];
  /** Task snapshot delegated through every generated context. */
  readonly task: TaskSnapshot;
}): Promise<readonly AgentContextCatalogEntry[]> {
  const uniqueTargets = new Set(
    input.targets.map((target) => target.resolved.definition.id),
  );
  if (uniqueTargets.size !== input.targets.length)
    throw new Error("Agent context targets contain duplicate definition IDs");
  const catalog: AgentContextCatalogEntry[] = [];
  for (const target of [...input.targets].sort((left, right) =>
    left.resolved.definition.id.localeCompare(right.resolved.definition.id),
  )) {
    if (!target.resolved.definition.enabled)
      throw new Error(
        `Agent context target is disabled: ${target.resolved.definition.id}`,
      );
    const bodyObject: AgentContextBody = {
      parentActivationDigest: input.parent.digest,
      schema: "agent-context-v1",
      task: toJsonValue(input.task) as JsonObject,
      targetActivationDigest: target.digest,
      targetDefinitionDigest: target.resolved.digest,
      targetResourcePins: target.resolved.resources.map(
        ({ digest, key, version }) => ({ digest, key, version }),
      ),
    };
    const body = canonicalize(toJsonValue(bodyObject));
    const digest = sha256(body);
    const key = `agent-context/${digestJson(
      toJsonValue({
        bodyDigest: digest,
        parentId: input.parent.resolved.definition.id,
        targetId: target.resolved.definition.id,
        taskId: input.task.id,
        taskVersion: input.task.version,
      }),
    )}`;
    await input.provider.putResource({
      body,
      dependencies: target.resolved.resources.map(
        ({ digest, key, version }) => ({ digest, key, version }),
      ),
      digest,
      idempotencyKey: `materialize:${key}:${digest}`,
      key,
      kind: "agent/context",
      state: "active",
      version: "v1",
    });
    const verified = await input.provider.getOptionalResource(key);
    assertContextRecord(verified, key, body, digest);
    catalog.push({
      contextDigest: digest,
      contextResource: key,
      contextVersion: "v1",
      definitionId: target.resolved.definition.id,
    });
  }
  return catalog;
}

/** Verifies the stored body and representation before exposing its pins. */
function assertContextRecord(
  record: ResourceRecord | null,
  key: string,
  body: string,
  digest: string,
): void {
  if (
    record === null ||
    record.key !== key ||
    record.kind !== "agent/context" ||
    record.state !== "active" ||
    record.version !== "v1" ||
    record.body !== body ||
    record.digest !== digest
  )
    throw new Error(`Agent context Resource did not verify: ${key}`);
}
