/** Materializes immutable, digest-pinned Agent contexts for trusted child-wave execution. */
import { canonicalize } from "../core/canonical-json.js";
import {
  AGENT_CONTEXT_SCHEMA,
  type AgentContextBody,
  type AgentContextCatalogEntry,
} from "../core/agent-context-codec.js";
import { digestJson, sha256 } from "../core/digest.js";
import type { ActivatedDefinition } from "../core/definition-activation.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { ResourceRecord, TaskSnapshot } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";

export type {
  AgentContextBody,
  AgentContextCatalogEntry,
} from "../core/agent-context-codec.js";

/** Persists and verifies one context per eligible child definition. */
export async function materializeAgentContexts(input: {
  /** Depth of the parent assignment that is delegating these contexts. */
  readonly assignmentDepth: number;
  /** Parent Agent that may propose the child wave. */
  readonly parent: ActivatedDefinition;
  /** Stable parent run identity bound into every child context. */
  readonly parentRunId: string;
  /** Provider used for managed Resource persistence. */
  readonly provider: AgentTaskProvider;
  /** Child definitions made available to the parent. */
  readonly targets: readonly ActivatedDefinition[];
  /** Task snapshot delegated through every generated context. */
  readonly task: TaskSnapshot;
}): Promise<readonly AgentContextCatalogEntry[]> {
  /** Distinct child definition IDs required for an unambiguous catalog. */
  const targetDefinitionIds = new Set(
    input.targets.map((target) => target.resolved.definition.id),
  );
  if (targetDefinitionIds.size !== input.targets.length)
    throw new Error("Agent context targets contain duplicate definition IDs");

  /** Digest-pinned contexts exposed to the parent in target-ID order. */
  const catalog: AgentContextCatalogEntry[] = [];
  for (const target of [...input.targets].sort((left, right) =>
    left.resolved.definition.id.localeCompare(right.resolved.definition.id),
  )) {
    if (!target.resolved.definition.enabled)
      throw new Error(
        `Agent context target is disabled: ${target.resolved.definition.id}`,
      );
    if (
      !target.resolved.definition.selection.acceptsAssignmentsFrom.includes(
        "coordinator",
      ) ||
      input.assignmentDepth + 1 > target.resolved.definition.maxAssignmentDepth
    )
      throw new Error(
        `Agent context target cannot accept this delegation: ${target.resolved.definition.id}`,
      );

    /** Immutable target Resource pins shared by the body and dependency envelope. */
    const targetResourcePins = target.resolved.resources.map(
      ({ digest, key, version }) => ({ digest, key, version }),
    );
    /** Closed authority record delegated to this exact child activation. */
    const contextBody: AgentContextBody = {
      assignmentDepth: input.assignmentDepth + 1,
      parentActivationDigest: input.parent.digest,
      parentDefinitionDigest: input.parent.resolved.digest,
      parentDefinitionId: input.parent.resolved.definition.id,
      parentRunId: input.parentRunId,
      schema: AGENT_CONTEXT_SCHEMA,
      task: toJsonValue(input.task) as JsonObject,
      taskId: input.task.id,
      taskVersion: input.task.version,
      targetActivationDigest: target.digest,
      targetDefinitionDigest: target.resolved.digest,
      targetDefinitionId: target.resolved.definition.id,
      targetResourcePins,
    };
    /** Canonical persisted representation of the immutable context. */
    const serializedContext = canonicalize(toJsonValue(contextBody));
    /** Digest binding the catalog entry to the persisted context bytes. */
    const contextDigest = sha256(serializedContext);
    /** Deterministic Resource address for this delegation snapshot. */
    const contextKey = `agent-context/${digestJson(
      toJsonValue({
        bodyDigest: contextDigest,
        parentId: input.parent.resolved.definition.id,
        targetId: target.resolved.definition.id,
        taskId: input.task.id,
        taskVersion: input.task.version,
      }),
    )}`;
    await input.provider.putResource({
      body: serializedContext,
      dependencies: targetResourcePins,
      digest: contextDigest,
      idempotencyKey: `materialize:${contextKey}:${contextDigest}`,
      key: contextKey,
      kind: "agent/context",
      state: "active",
      version: "v1",
    });

    /** Stored context read back before its pins enter the parent catalog. */
    const storedContext = await input.provider.getOptionalResource(contextKey);
    assertContextRecord(
      storedContext,
      contextKey,
      serializedContext,
      contextDigest,
    );
    catalog.push({
      contextDigest,
      contextResource: contextKey,
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
