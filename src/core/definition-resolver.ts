/** Resolves the immutable Resource graph needed by one provider-defined role. */
import { digestJson } from "./digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type {
  ResourceRecord,
  ResourceRef,
  AgentDefinition,
} from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import {
  parseTaskQueryContract,
  type TaskQueryContract,
} from "./task-query-contract.js";
import { assertSupportedJsonSchema } from "./json-schema.js";

/** Canonical fields for resolved definition. */
export interface ResolvedDefinition {
  /** Definition for resolved definition. */
  readonly definition: AgentDefinition;
  /** SHA-256 digest of the definition and pinned Resource graph. */
  readonly digest: string;
  /** Resources included in resolved definition. */
  readonly resources: readonly ResourceRecord[];
  /** Task query for resolved definition. */
  readonly taskQuery: TaskQueryContract | null;
}

/** Canonical fields for invocation schedule contract. */
export interface InvocationScheduleContract {
  /** Interval duration in seconds. */
  readonly intervalSeconds: number;
  /** Offset duration in seconds. */
  readonly offsetSeconds: number;
  /** Schema discriminator for the serialized representation. */
  readonly schema: "invocation-schedule-v1";
}

/** Loads an agent definition and resolves its complete Resource graph. */
export async function resolveDefinition(
  provider: AgentTaskProvider,
  definitionId: string,
): Promise<ResolvedDefinition> {
  /** Definition loaded during resolve definition. */
  const definition = await provider.getAgentDefinition(definitionId);
  return resolveLoadedDefinition(provider, definition);
}

/** Validates a loaded definition's Resources, schemas, and context budget. */
export async function resolveLoadedDefinition(
  provider: AgentTaskProvider,
  definition: AgentDefinition,
): Promise<ResolvedDefinition> {
  if (!definition.enabled)
    throw new Error(`Agent definition is disabled: ${definition.id}`);
  /** Roots used during resolve loaded definition. */
  const roots = definitionResourceKeys(definition).map(resourceRef);
  /** Resources loaded during resolve loaded definition. */
  const resources = await resolveResourceGraph(provider, roots);
  /** By key indexed for lookup during resolve loaded definition. */
  const byKey = new Map(resources.map((resource) => [resource.key, resource]));
  /** Query key used during resolve loaded definition. */
  const queryKey = definition.selection.taskQueryResource;
  /** Task query used during resolve loaded definition. */
  const taskQuery =
    queryKey === null
      ? null
      : parseTaskQueryContract(requiredResource(byKey, queryKey).body);
  assertResourceKind(
    requiredResource(byKey, definition.selection.resultSchema),
    "json-schema",
  );
  assertResourceKind(
    requiredResource(byKey, definition.outputSchema),
    "json-schema",
  );
  assertClosedJsonSchema(
    requiredResource(byKey, definition.selection.resultSchema),
  );
  assertClosedJsonSchema(requiredResource(byKey, definition.outputSchema));
  if (queryKey !== null)
    assertResourceKind(requiredResource(byKey, queryKey), "task-query");
  if (definition.invocation.scheduleResource !== null) {
    /** Schedule used during resolve loaded definition. */
    const schedule = requiredResource(
      byKey,
      definition.invocation.scheduleResource,
    );
    assertResourceKind(schedule, "invocation-schedule");
    parseInvocationScheduleContract(schedule.body);
  }
  /** Context bytes used during resolve loaded definition. */
  const contextBytes = resources.reduce(
    (total, resource) => total + Buffer.byteLength(resource.body, "utf8"),
    0,
  );
  if (contextBytes > definition.contextBudgetBytes)
    throw new Error("Resolved Resources exceed the definition context budget");
  /** Digest binding the definition to the ordered, versioned resource pins. */
  const digest = digestJson(
    toJsonValue({
      definition,
      resourcePins: resources.map(
        ({ digest: resourceDigest, key, version }) => ({
          digest: resourceDigest,
          key,
          version,
        }),
      ),
    }),
  );
  return { definition, digest, resources, taskQuery };
}

/** Parses and validates a bounded interval-based invocation schedule. */
export function parseInvocationScheduleContract(
  body: string,
): InvocationScheduleContract {
  /** JSON-decoded input before structural validation. */
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Invocation schedule must be an object");
  /** Object currently undergoing field-level validation. */
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).sort().join("\0") !==
    ["intervalSeconds", "offsetSeconds", "schema"].sort().join("\0")
  ) {
    throw new TypeError("Invocation schedule has unexpected or missing fields");
  }
  if (value.schema !== "invocation-schedule-v1")
    throw new TypeError("Invocation schedule schema is invalid");
  if (
    !Number.isSafeInteger(value.intervalSeconds) ||
    (value.intervalSeconds as number) < 60 ||
    (value.intervalSeconds as number) > 31_536_000
  ) {
    throw new TypeError("Invocation schedule intervalSeconds is invalid");
  }
  if (
    !Number.isSafeInteger(value.offsetSeconds) ||
    (value.offsetSeconds as number) < 0 ||
    (value.offsetSeconds as number) >= (value.intervalSeconds as number)
  ) {
    throw new TypeError("Invocation schedule offsetSeconds is invalid");
  }
  return value as unknown as InvocationScheduleContract;
}

/** Loads a pinned Resource dependency graph in deterministic order. */
async function resolveResourceGraph(
  provider: AgentTaskProvider,
  roots: readonly ResourceRef[],
): Promise<readonly ResourceRecord[]> {
  /** Resolved indexed for lookup during resolve resource graph. */
  const resolved = new Map<string, ResourceRecord>();
  /** Distinct visiting tracked during resolve resource graph. */
  const visiting = new Set<string>();
  /** Visit loaded during resolve resource graph. */
  const visit = async (ref: ResourceRef): Promise<void> => {
    /** Prior used during resolve resource graph. */
    const prior = resolved.get(ref.key);
    if (prior !== undefined) {
      if (
        (ref.version !== null && ref.version !== prior.version) ||
        (ref.digest !== null && ref.digest !== prior.digest)
      )
        throw new Error(`Conflicting Resource pin: ${ref.key}`);
      return;
    }
    if (visiting.has(ref.key))
      throw new Error(`Resource dependency cycle: ${ref.key}`);
    visiting.add(ref.key);
    /** Record loaded during resolve resource graph. */
    const [record] = await provider.getResources([ref]);
    if (record === undefined || record.state !== "active")
      throw new Error(`Resource is not uniquely active: ${ref.key}`);
    for (const dependency of record.dependencies) await visit(dependency);
    visiting.delete(ref.key);
    resolved.set(record.key, record);
  };
  for (const root of roots) await visit(root);
  return [...resolved.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

/** Collects the distinct Resource keys referenced by an agent definition. */
function definitionResourceKeys(
  definition: AgentDefinition,
): readonly string[] {
  return [
    ...new Set(
      [
        ...definition.promptResources,
        ...definition.inputResourceSelectors,
        definition.invocation.scheduleResource,
        definition.selection.resultSchema,
        definition.selection.taskQueryResource,
        definition.outputSchema,
      ].filter((key): key is string => key !== null),
    ),
  ];
}

/** Creates an unpinned reference for a required Resource key. */
function resourceRef(key: string): ResourceRef {
  return { digest: null, key, version: null };
}

/** Returns a required resolved Resource or throws when absent. */
function requiredResource(
  values: ReadonlyMap<string, ResourceRecord>,
  key: string,
): ResourceRecord {
  /** Resource used during required resource. */
  const resource = values.get(key);
  if (resource === undefined)
    throw new Error(`Definition Resource is missing: ${key}`);
  return resource;
}

/** Rejects a Resource that does not contain a supported closed JSON Schema. */
function assertClosedJsonSchema(resource: ResourceRecord): void {
  /** JSON-decoded input before structural validation. */
  const parsed: unknown = JSON.parse(resource.body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError(`Schema Resource is not an object: ${resource.key}`);
  /** Schema used during assert closed JSON schema. */
  const schema = parsed as Record<string, unknown>;
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    typeof schema.properties !== "object" ||
    schema.properties === null
  ) {
    throw new TypeError(
      `Schema Resource is not a closed object schema: ${resource.key}`,
    );
  }
  assertSupportedJsonSchema(
    schema as JsonObject,
    `Schema Resource ${resource.key}`,
  );
}

/** Rejects a Resource whose kind differs from the expected kind. */
function assertResourceKind(resource: ResourceRecord, expected: string): void {
  if (resource.kind !== expected)
    throw new TypeError(`Resource ${resource.key} must have kind ${expected}`);
}
