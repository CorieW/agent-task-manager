// Resolves the immutable Resource graph needed by one provider-defined role.
import { digestJson } from "./digest.js";
import { toJsonValue } from "../domain/json.js";
import type { ResourceRecord, ResourceRef, SubAgentDefinition } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { parseTaskQueryContract, type TaskQueryContract } from "./task-query-contract.js";

export interface ResolvedDefinition {
  readonly definition: SubAgentDefinition;
  readonly digest: string;
  readonly resources: readonly ResourceRecord[];
  readonly taskQuery: TaskQueryContract | null;
}

export async function resolveDefinition(
  provider: AgentTaskProvider,
  definitionId: string,
): Promise<ResolvedDefinition> {
  const definition = await provider.getSubAgentDefinition(definitionId);
  if (!definition.enabled) throw new Error(`Sub-agent definition is disabled: ${definitionId}`);
  const roots = definitionResourceKeys(definition).map(resourceRef);
  const resources = await resolveResourceGraph(provider, roots);
  const byKey = new Map(resources.map((resource) => [resource.key, resource]));
  const queryKey = definition.selection.taskQueryResource;
  const taskQuery = queryKey === null ? null : parseTaskQueryContract(requiredResource(byKey, queryKey).body);
  assertClosedJsonSchema(requiredResource(byKey, definition.selection.resultSchemaResource));
  assertClosedJsonSchema(requiredResource(byKey, definition.workResultSchemaResource));
  const promptBytes = definition.promptResources.reduce((total, key) => total + Buffer.byteLength(requiredResource(byKey, key).body, "utf8"), 0);
  if (promptBytes > definition.contextBudgetBytes) throw new Error("Prompt Resources exceed the definition context budget");
  const digest = digestJson(toJsonValue({
    definition,
    resourcePins: resources.map(({ digest: resourceDigest, key, version }) => ({ digest: resourceDigest, key, version })),
  }));
  return { definition, digest, resources, taskQuery };
}

async function resolveResourceGraph(
  provider: AgentTaskProvider,
  roots: readonly ResourceRef[],
): Promise<readonly ResourceRecord[]> {
  const resolved = new Map<string, ResourceRecord>();
  const visiting = new Set<string>();
  const visit = async (ref: ResourceRef): Promise<void> => {
    const prior = resolved.get(ref.key);
    if (prior !== undefined) {
      if (ref.version !== null && ref.version !== prior.version || ref.digest !== null && ref.digest !== prior.digest) throw new Error(`Conflicting Resource pin: ${ref.key}`);
      return;
    }
    if (visiting.has(ref.key)) throw new Error(`Resource dependency cycle: ${ref.key}`);
    visiting.add(ref.key);
    const [record] = await provider.getResources([ref]);
    if (record === undefined || record.state !== "active") throw new Error(`Resource is not uniquely active: ${ref.key}`);
    for (const dependency of record.dependencies) await visit(dependency);
    visiting.delete(ref.key);
    resolved.set(record.key, record);
  };
  for (const root of roots) await visit(root);
  return [...resolved.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function definitionResourceKeys(definition: SubAgentDefinition): readonly string[] {
  return [...new Set([
    ...definition.promptResources,
    ...definition.inputResourceSelectors,
    definition.invocation.scheduleResource,
    definition.selection.resultSchemaResource,
    definition.selection.taskQueryResource,
    definition.workResultSchemaResource,
  ].filter((key): key is string => key !== null))];
}
function resourceRef(key: string): ResourceRef { return { digest: null, key, version: null }; }
function requiredResource(values: ReadonlyMap<string, ResourceRecord>, key: string): ResourceRecord {
  const resource = values.get(key);
  if (resource === undefined) throw new Error(`Definition Resource is missing: ${key}`);
  return resource;
}
function assertClosedJsonSchema(resource: ResourceRecord): void {
  const parsed: unknown = JSON.parse(resource.body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError(`Schema Resource is not an object: ${resource.key}`);
  const schema = parsed as Record<string, unknown>;
  if (schema.type !== "object" || schema.additionalProperties !== false || typeof schema.properties !== "object" || schema.properties === null) {
    throw new TypeError(`Schema Resource is not a closed object schema: ${resource.key}`);
  }
}
