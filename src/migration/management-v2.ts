/** Drift-checked, one-time migration model for the Management v2 workspace. */
import { digestJson } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import {
  agentDefinitionSection,
  parseAgentDefinition,
  parseAgentTransitions,
  validateAgentTransitions,
  type AgentTransitions,
} from "../domain/records.js";
import { normalizeNotionId } from "../provider/notion/notion-id.js";
import { notionTable } from "../provider/notion/notion-schema.js";

/** Exact Notion page that owns the legacy Management v2 databases. */
export const MANAGEMENT_V2_PARENT = "3bf9a6efcd5880eeaf0edef3125a1534";
/** Exact legacy data-source IDs authorized for the one-time migration. */
export const MANAGEMENT_V2_DATABASES = {
  agents: "ad39a6ef-cd58-8303-8ac4-876b007e359f",
  errors: "ed29a6ef-cd58-8219-9623-0787fdee9b22",
  operations: "6759a6ef-cd58-8314-9c7c-0707b7f90e0f",
  resources: "7919a6ef-cd58-8311-b121-87e8e2d7db5b",
  tasks: "d9e9a6ef-cd58-82d3-a726-87a4691ba9bf",
} as const;
/** Database page IDs needed for destructive database-level operations. */
export const MANAGEMENT_V2_DATABASE_PAGES = {
  operations: "9d79a6efcd5882bba58981afbbeb4012",
} as const;

/** Exact Agent titles required by the expected legacy baseline. */
export const EXPECTED_AGENT_NAMES = [
  "Code Reviewer",
  "Code Tester",
  "Coder",
  "Issue Reviewer",
  "Project Manager",
  "Researcher",
  "Task Master",
  "Task Planner",
] as const;
/** Prompt and Policy Resource keys retained by the migration. */
export const RETAINED_RESOURCE_KEYS = [
  "policy/delivery-coordination",
  "policy/documentation",
  "policy/git-delivery",
  "policy/project-governance",
  "policy/repository-structure",
  "policy/review/code-cleanliness",
  "policy/review/code-human-readability",
  "policy/review/multi-agent-branch-audit",
  "policy/security-operations",
  "policy/verification",
  "prompt/code-reviewer",
  "prompt/code-tester",
  "prompt/coder",
  "prompt/issue-reviewer",
  "prompt/project-manager",
  "prompt/researcher",
  "prompt/task-master",
  "prompt/task-planner",
] as const;
/** Legacy Resource keys archived by the migration. */
export const ARCHIVED_RESOURCE_KEYS = [
  "policy/perfect-project",
  "query/human-ready",
  "query/in-progress",
  "query/in-review",
  "query/planned",
  "query/project-manager",
  "schedule/project-manager",
  "schema/child-agent-wave-intent-v1",
  "schema/role-result-v1",
  "schema/task-selection-result-v1",
] as const;
/** Exact legacy Error keys archived by the migration. */
export const EXPECTED_ERROR_KEYS = [
  "code-reviewer-fresh-agent-capacity-exhausted",
  "code-reviewer-harness-context-handoff-truncated",
  "code-reviewer-immutable-context-missing-procedures-and-wave-contract",
  "orbit-001-product-decisions",
  "stale-agent-activity:code-reviewer",
] as const;

/** Legacy property names removed after body conversion and verification. */
export const LEGACY_PROPERTIES_BY_TABLE: Readonly<
  Record<"agents" | "errors" | "resources" | "tasks", readonly string[]>
> = {
  agents: [
    "Agent Key",
    "Called By",
    "Enabled",
    "Model",
    "Notes",
    "Reasoning",
    "Resources",
    "Revision",
    "Status",
    "Transitions",
    "Working On",
    "Last Run",
  ],
  errors: ["Run ID"],
  resources: ["Version", "Digest", "Dependencies"],
  tasks: [
    "Being Worked On By",
    "Manager Mutation",
    "Remediation Source",
    "Review Finding Keys",
    "Review Findings Digest",
    "Review Repeat Count",
    "Review Round",
    "Test Failure Keys",
    "Test Failures Digest",
    "Test Repeat Count",
    "Test Round",
  ],
};

/** Captured page body, identity, properties, and title used for planning. */
export interface MigrationRow {
  /** Authoritative Markdown body of the provider record. */
  readonly body: string;
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Provider-specific properties retained at the domain boundary. */
  readonly properties: JsonObject;
  /** Human-readable title of the record or command. */
  readonly title: string;
}
/** Captured data-source schema and rows used for planning. */
export interface MigrationTable {
  /** Notion data-source ID, not its containing database page ID. */
  readonly id: string;
  /** Provider-specific properties retained at the domain boundary. */
  readonly properties: Readonly<Record<string, string>>;
  /** Rows read from the table in provider order. */
  readonly rows: readonly MigrationRow[];
}
/** Complete authorized snapshot of the legacy Management v2 workspace. */
export interface ManagementInventory {
  /** Initial Active Agent records for the in-memory provider. */
  readonly activeAgents: MigrationTable | null;
  /** Initial Agent records for the in-memory provider. */
  readonly agents: MigrationTable;
  /** Initial Error records for the in-memory provider. */
  readonly errors: MigrationTable;
  /** Optional legacy Operations table. */
  readonly operations: MigrationTable | null;
  /** Stable parent ID. */
  readonly parentId: string;
  /** Ordered Resources supplied as immutable Agent context. */
  readonly resources: MigrationTable;
  /** Initial Task records for the in-memory provider. */
  readonly tasks: MigrationTable;
}
/** Supported ordered operation kinds in a Management v2 migration. */
export type MigrationActionKind =
  | "add_schema"
  | "archive_error"
  | "archive_operations"
  | "archive_resource"
  | "convert_agent"
  | "create_active_agents"
  | "drop_legacy_schema"
  | "rewrite_resource"
  | "verify";
/** One deterministic migration operation and its exact target. */
export interface MigrationAction {
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Domain or protocol classification of the record. */
  readonly kind: MigrationActionKind;
  /** Provider record or data-source ID targeted by the migration action. */
  readonly targetId: string;
}
/** Digest-bound migration plan derived from one inventory snapshot. */
export interface ManagementMigrationPlan {
  /** Ordered mutations authorized by this plan. */
  readonly actions: readonly MigrationAction[];
  /** Digest of the plan core, including actions and inventory authorization. */
  readonly digest: string;
  /** Digest of the complete normalized inventory snapshot. */
  readonly inventoryDigest: string;
  /** Stable parent ID. */
  readonly parentId: string;
  /** Versioned schema identifier for the serialized object. */
  readonly schema: "management-v2-migration-plan-v1";
}

/** Validates and converts an inventory into a deterministic migration plan. */
export function planManagementV2Migration(
  inventory: ManagementInventory,
): ManagementMigrationPlan {
  inventory = orderedInventory(inventory);
  assertManagementV2Inventory(inventory);
  /** Ordered actions used by plan management v2 migration. */
  const actions: MigrationAction[] = [];
  /** Whether the inventory still requires additive schema convergence. */
  const needsAdditive =
    inventory.activeAgents === null || !hasTargetProperties(inventory);
  if (needsAdditive)
    actions.push({
      id: "schema:add-v1",
      kind: "add_schema",
      targetId: inventory.parentId,
    });
  if (inventory.activeAgents === null)
    actions.push({
      id: "database:create-active-agents",
      kind: "create_active_agents",
      targetId: inventory.parentId,
    });
  /** Resources resolved in the Agent definition's declared order. */
  const resources = new Map(
    inventory.resources.rows.map((row) => [row.title, row]),
  );
  for (const key of RETAINED_RESOURCE_KEYS) {
    /** Migration inventory row currently planned or validated. */
    const row = resources.get(key)!;
    if (!row.body.includes("## Simplified coordination contract"))
      actions.push({
        id: `resource:rewrite:${key}`,
        kind: "rewrite_resource",
        targetId: row.id,
      });
  }
  for (const key of ARCHIVED_RESOURCE_KEYS) {
    /** Migration inventory row currently planned or validated. */
    const row = resources.get(key);
    if (row !== undefined)
      actions.push({
        id: `resource:archive:${key}`,
        kind: "archive_resource",
        targetId: row.id,
      });
  }
  for (const row of inventory.agents.rows) {
    if (!hasAgentDefinition(row.body))
      actions.push({
        id: `agent:convert:${row.title}`,
        kind: "convert_agent",
        targetId: row.id,
      });
  }
  for (const row of inventory.errors.rows)
    actions.push({
      id: `error:archive:${row.title}`,
      kind: "archive_error",
      targetId: row.id,
    });
  if (inventory.operations !== null)
    actions.push({
      id: "operations:archive",
      kind: "archive_operations",
      targetId: inventory.operations.id,
    });
  if (hasLegacyProperties(inventory))
    actions.push({
      id: "schema:drop-legacy",
      kind: "drop_legacy_schema",
      targetId: inventory.parentId,
    });
  actions.push({
    id: "migration:verify",
    kind: "verify",
    targetId: inventory.parentId,
  });
  /** Digest binding the exact pre-migration inventory. */
  const inventoryDigest = digestInventory(inventory);
  /** Serialized fields covered by the deterministic digest. */
  const core = {
    actions,
    inventoryDigest,
    parentId: inventory.parentId,
    schema: "management-v2-migration-plan-v1" as const,
  };
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

/** Returns a deterministically ordered copy of the migration inventory. */
function orderedInventory(inventory: ManagementInventory): ManagementInventory {
  /** Canonical managed-table descriptor for this operation. */
  const table = (value: MigrationTable): MigrationTable => ({
    ...value,
    rows: [...value.rows].sort((left, right) =>
      normalizeNotionId(left.id).localeCompare(normalizeNotionId(right.id)),
    ),
  });
  return {
    ...inventory,
    activeAgents:
      inventory.activeAgents === null ? null : table(inventory.activeAgents),
    agents: table(inventory.agents),
    errors: table(inventory.errors),
    operations:
      inventory.operations === null ? null : table(inventory.operations),
    resources: table(inventory.resources),
    tasks: table(inventory.tasks),
  };
}

/** Fails closed unless the inventory matches the expected legacy baseline. */
export function assertManagementV2Inventory(
  inventory: ManagementInventory,
): void {
  /** Ordered validation failures accumulated before rejection. */
  const failures: string[] = [];
  if (normalizeNotionId(inventory.parentId) !== MANAGEMENT_V2_PARENT)
    failures.push("parent is not the exact Management v2 page");
  for (const [kind, id] of Object.entries(MANAGEMENT_V2_DATABASES)) {
    /** Canonical managed-table descriptor for this operation. */
    const table =
      inventory[
        kind as keyof Pick<
          ManagementInventory,
          "agents" | "errors" | "operations" | "resources" | "tasks"
        >
      ];
    if (table !== null && normalizeNotionId(table.id) !== normalizeNotionId(id))
      failures.push(`${kind} data-source ID drifted`);
  }
  if (inventory.tasks.rows.length !== 0)
    failures.push("Tasks must contain 0 live rows");
  compareExact(
    "Agents",
    inventory.agents.rows.map((row) => row.title),
    EXPECTED_AGENT_NAMES,
    failures,
  );
  /** Resources resolved in the Agent definition's declared order. */
  const resources = new Set(inventory.resources.rows.map((row) => row.title));
  for (const key of resources) {
    /** Number of legacy rows matching the required key. */
    const count = inventory.resources.rows.filter(
      (row) => row.title === key,
    ).length;
    if (count > 1) failures.push(`duplicate Resource key: ${key}`);
  }
  for (const key of RETAINED_RESOURCE_KEYS)
    if (!resources.has(key))
      failures.push(`retained Resource is missing: ${key}`);
  for (const key of resources)
    if (
      ![...RETAINED_RESOURCE_KEYS, ...ARCHIVED_RESOURCE_KEYS].includes(
        key as never,
      )
    )
      failures.push(`unexpected Resource: ${key}`);
  assertAgentDefinitionParity(inventory, failures);
  /** Distinct values tracked by assert management v2 inventory. */
  const errors = new Set(
    inventory.errors.rows.map((row) =>
      String(row.properties["Error Key"] ?? row.title),
    ),
  );
  for (const key of errors)
    if (!EXPECTED_ERROR_KEYS.includes(key as never))
      failures.push(`unexpected Error: ${key}`);
  if (inventory.operations !== null) {
    if (inventory.operations.rows.length > 1)
      failures.push("Operations contains more than its one empty row");
    /** Migration inventory row currently planned or validated. */
    const row = inventory.operations.rows[0];
    if (
      row !== undefined &&
      Object.values(row.properties).some(
        (value) => value !== null && value !== "",
      )
    )
      failures.push("Operations row is not empty");
  }
  if (inventory.activeAgents !== null) {
    if (inventory.activeAgents.rows.length !== 0)
      failures.push("Active Agents must contain 0 live rows during migration");
    /** Observed Active Agent schema properties. */
    const activeProperties = Object.fromEntries(
      notionTable("activeAgents").properties.map((property) => [
        property.name,
        property.type,
      ]),
    );
    assertPropertyTypes(
      inventory.activeAgents,
      { "Run ID": "title" },
      failures,
    );
    assertOptionalPropertyTypes(
      inventory.activeAgents,
      activeProperties,
      failures,
    );
  }
  assertPropertyTypes(inventory.agents, { Name: "title" }, failures);
  assertOptionalPropertyTypes(
    inventory.agents,
    {
      "Agent Key": "rich_text",
      "Called By": "rich_text",
      Enabled: "checkbox",
      Model: "rich_text",
      Notes: "rich_text",
      Reasoning: "rich_text",
      Resources: "relation",
      Transitions: "rich_text",
    },
    failures,
  );
  assertPropertyTypes(
    inventory.resources,
    { Kind: "select", Resource: "title", State: "select" },
    failures,
  );
  assertOptionalPropertyTypes(
    inventory.errors,
    { "Active Agent": "relation", Source: "select" },
    failures,
  );
  assertPropertyTypes(
    inventory.errors,
    {
      Agent: "relation",
      Error: "title",
      "Error Key": "rich_text",
      Severity: "select",
      Status: "select",
      Task: "relation",
    },
    failures,
  );
  assertPropertyTypes(
    inventory.tasks,
    { Dependencies: "relation", Status: "select", Task: "title" },
    failures,
  );
  assertOptionalPropertyTypes(inventory.tasks, { Type: "select" }, failures);
  if (failures.length > 0)
    throw new Error(
      `Management v2 preflight drifted:\n- ${failures.join("\n- ")}`,
    );
}

/** Records Agent-definition mismatches between legacy rows and converted bodies. */
function assertAgentDefinitionParity(
  inventory: ManagementInventory,
  failures: string[],
): void {
  /** Lookup used by assert agent definition parity. */
  const resourceKeyById = new Map(
    inventory.resources.rows.map((row) => [
      normalizeNotionId(row.id),
      row.title,
    ]),
  );
  for (const row of inventory.agents.rows) {
    /** Strict Agent definition parsed from authoritative Markdown. */
    let definition;
    try {
      definition = parseAgentDefinition(row.body);
    } catch {
      continue;
    }
    /** Conflicting managed Agent definition found during parity validation. */
    const conflict = (field: string): void => {
      failures.push(`Agent ${row.title} body conflicts with legacy ${field}`);
    };
    /** Field comparator that appends deterministic parity failures. */
    const compareText = (
      property: string,
      actual: string,
      skipBlank = false,
    ): void => {
      if (!Object.hasOwn(row.properties, property)) return;
      /** Caller-supplied digest or value required to authorize the operation. */
      const expected = stringProperty(row.properties[property], property);
      if (skipBlank && expected === "") return;
      if (actual !== expected) conflict(property);
    };
    compareText("Agent Key", definition.id, true);
    compareText("Called By", definition.calledBy);
    compareText("Model", definition.model, true);
    compareText("Notes", definition.notes);
    compareText("Reasoning", definition.reasoning, true);
    if (
      Object.hasOwn(row.properties, "Enabled") &&
      definition.enabled !== booleanProperty(row.properties.Enabled, "Enabled")
    )
      conflict("Enabled");
    /** Mapping from Agent outcomes to destination Task statuses. */
    const transitions = row.properties.Transitions;
    if (typeof transitions === "string" && transitions !== "") {
      /** Legacy Agent manifest retained for parity conversion. */
      const legacy = parseAgentTransitions(transitions);
      if (
        digestJson(toJsonValue(legacy)) !==
        digestJson(toJsonValue(definition.transitions))
      )
        conflict("Transitions");
    }
    /** Managed table targeted by a Notion relation property. */
    const relation = row.properties.Resources;
    if (Array.isArray(relation) && relation.length > 0) {
      /** Allowlisted keys accepted by the current boundary. */
      const keys = relation.map((value) =>
        resourceKeyById.get(normalizeNotionId(String(value))),
      );
      if (keys.some((key) => key === undefined)) conflict("Resources");
      else {
        /** Managed Markdown content isolated from surrounding operator text. */
        const managed = keys
          .filter(
            (key): key is string =>
              key !== undefined &&
              (key.startsWith("prompt/") || key.startsWith("policy/")),
          )
          .sort();
        if (
          JSON.stringify(managed) !==
          JSON.stringify([...definition.resourceKeys].sort())
        )
          conflict("Resources");
      }
    }
  }
}

/** Legacy body fields retained while converting an Agent definition. */
export interface LegacyAgentManifest {
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Resource selectors declared by the legacy Agent manifest. */
  readonly inputResourceSelectors: readonly string[];
  /** Prompt Resources selected by the Agent definition. */
  readonly promptResources: readonly string[];
  /** Reasoning-effort setting requested by the Agent definition. */
  readonly reasoning: string;
  /** Mapping from Agent outcomes to destination Task statuses. */
  readonly transitions: AgentTransitions;
}
/** Parses the heading-scoped JSON manifest from a legacy Agent body. */
export function parseLegacyAgentManifest(
  markdown: string,
): LegacyAgentManifest {
  /** Managed Markdown section located by its exact heading. */
  const section = agentDefinitionSection(markdown);
  if (section === null)
    throw new Error("Agent page does not contain a legacy JSON manifest");
  /** Parsed legacy manifest before strict shape validation. */
  const value = JSON.parse(section.content) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Agent manifest must be an object");
  /** Strict legacy Agent manifest parsed from the managed section. */
  const manifest = value as Record<string, unknown>;
  return {
    id: requiredText(manifest.id, "Agent manifest id"),
    inputResourceSelectors: stringArray(
      manifest.inputResourceSelectors,
      "inputResourceSelectors",
    ),
    promptResources: stringArray(manifest.promptResources, "promptResources"),
    reasoning: requiredText(manifest.reasoning, "Agent manifest reasoning"),
    transitions: validateAgentTransitions(manifest.transitions),
  };
}
/** Returns sorted, unique manifest keys present in the retained baseline. */
export function retainedManifestResourceKeys(
  manifest: LegacyAgentManifest,
): readonly string[] {
  /** Distinct values tracked by retained manifest resource keys. */
  const retained = new Set<string>(RETAINED_RESOURCE_KEYS);
  return [
    ...new Set([
      ...manifest.promptResources,
      ...manifest.inputResourceSelectors,
    ]),
  ]
    .filter((key) => retained.has(key))
    .sort();
}

/** Moves legacy Agent property values into one authoritative body definition. */
export function agentDefinitionMarkdown(
  row: MigrationRow,
  relatedResourceKeys: readonly string[] = [],
): string {
  /** Managed Markdown section located by its exact heading. */
  const section = agentDefinitionSection(row.body);
  /** Legacy Agent manifest retained for parity conversion. */
  const legacy =
    section === null
      ? definitionFromProperties(row, relatedResourceKeys)
      : parseDefinitionObject(section.content);
  /** Harness identity allowed to invoke this Agent. */
  const calledBy = stringProperty(row.properties["Called By"], "Called By");
  /** Optional operator-facing Agent notes. */
  const notes = stringProperty(row.properties.Notes, "Notes");
  /** Strict Agent definition parsed from authoritative Markdown. */
  const definition = {
    ...legacy,
    schema: "agent-definition-v1",
    allowedStatuses: Array.isArray(legacy.allowedStatuses)
      ? legacy.allowedStatuses
      : [],
    allowedTaskTypes: Array.isArray(legacy.allowedTaskTypes)
      ? legacy.allowedTaskTypes
      : [],
    commands:
      legacy.commands === undefined ? { inclusion: [] } : legacy.commands,
    enabled:
      typeof legacy.enabled === "boolean"
        ? legacy.enabled
        : booleanProperty(row.properties.Enabled, "Enabled"),
    model:
      typeof legacy.model === "string" && legacy.model.trim() !== ""
        ? legacy.model
        : requiredText(row.properties.Model, "Model"),
    ...(legacy.calledBy === undefined && calledBy !== "" ? { calledBy } : {}),
    ...(legacy.notes === undefined && notes !== "" ? { notes } : {}),
  };
  /** Canonical Agent-definition section rendered for validation. */
  const definitionMarkdown = `## Agent definition\n\n\`\`\`json\n${JSON.stringify(definition, null, 2)}\n\`\`\`\n`;
  /** Canonical Markdown rendered for the provider page. */
  const markdown =
    section === null
      ? `${definitionMarkdown}\n${row.body}`
      : `${row.body.slice(0, section.start)}${definitionMarkdown}${row.body.slice(section.end)}`;
  parseAgentDefinition(markdown);
  return markdown;
}

/** Converts legacy Agent columns into a v1 definition object. */
function definitionFromProperties(
  row: MigrationRow,
  resourceKeys: readonly string[],
): Record<string, unknown> {
  /** Mapping from Agent outcomes to destination Task statuses. */
  const transitions = parseAgentTransitions(
    requiredText(row.properties.Transitions, "Transitions"),
  );
  return {
    id: requiredText(row.properties["Agent Key"], "Agent Key"),
    inputResourceSelectors: resourceKeys.filter((key) =>
      key.startsWith("policy/"),
    ),
    promptResources: resourceKeys.filter((key) => key.startsWith("prompt/")),
    reasoning: requiredText(row.properties.Reasoning, "Reasoning"),
    transitions,
  };
}

/** Parses and validates definition object. */
function parseDefinitionObject(value: string): Record<string, unknown> {
  /** Untyped serialized input after JSON or argument parsing. */
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Agent manifest must be an object");
  return parsed as Record<string, unknown>;
}

/** Renders managed Resource Markdown while preserving legacy guidance. */
export function renderManagedResourceMarkdown(
  key: string,
  legacy: string,
): string {
  return `## Simplified coordination contract\n\nThis Resource applies to **${key}**. Work from the current Task page and the current active Prompt and Policy Resources selected by the Agent definition.\n\nThe external harness owns conversation history, tool and command execution, browser and network access, Git and publication actions, repeat safety, and child-process spawning. Notion records only Tasks, Agent definitions, Resources, Active Agent metadata, and Errors.\n\nWhile running, refresh the Active Agent heartbeat at least once every five minutes. Finish with one outcome declared by the Agent definition's transitions object. Report detected problems in Errors. If a run fails or becomes stale, stop its descendants and restart that failed subtree from the beginning; do not reconstruct conversation state.\n\n## Preserved role and project guidance\n\n${legacy}`;
}
/** Reports forbidden legacy terms only within the managed contract section. */
export function auditManagedResourceContract(
  markdown: string,
): readonly string[] {
  /** Ordered forbidden used by audit managed resource contract. */
  const forbidden = [
    "operations database",
    "resource pin",
    "reconciliation",
    "manager-owned effect",
    "lease",
    "attestation",
  ];
  /** Managed Markdown boundary separating retained and governed content. */
  const boundary = markdown.indexOf(
    "\n## Preserved role and project guidance\n",
  );
  /** Managed Markdown content isolated from surrounding operator text. */
  const managed = boundary === -1 ? markdown : markdown.slice(0, boundary);
  return forbidden.filter((term) => managed.toLowerCase().includes(term));
}
/** Produces the deterministic digest of an ordered migration inventory. */
function digestInventory(inventory: ManagementInventory): string {
  /** Canonical managed-table descriptor for this operation. */
  const table = (value: MigrationTable | null) =>
    value === null
      ? null
      : {
          id: normalizeNotionId(value.id),
          properties: value.properties,
          rows: value.rows.map((row) => ({
            bodyDigest: digestJson(row.body),
            id: normalizeNotionId(row.id),
            properties: row.properties,
            title: row.title,
          })),
        };
  return digestJson(
    toJsonValue({
      activeAgents: table(inventory.activeAgents),
      agents: table(inventory.agents),
      errors: table(inventory.errors),
      operations: table(inventory.operations),
      parentId: normalizeNotionId(inventory.parentId),
      resources: table(inventory.resources),
      tasks: table(inventory.tasks),
    }),
  );
}
/** Reports whether target properties. */
function hasTargetProperties(inventory: ManagementInventory): boolean {
  return (
    inventory.agents.properties.Name === "title" &&
    inventory.tasks.properties.Type === "select" &&
    ["Source", "Active Agent"].every(
      (name) => inventory.errors.properties[name] !== undefined,
    )
  );
}
/** Reports whether legacy properties. */
function hasLegacyProperties(inventory: ManagementInventory): boolean {
  return Object.entries(LEGACY_PROPERTIES_BY_TABLE).some(([kind, names]) =>
    names.some(
      (name) =>
        inventory[kind as keyof typeof LEGACY_PROPERTIES_BY_TABLE].properties[
          name
        ] !== undefined,
    ),
  );
}
/** Records required property-type mismatches for a migration table. */
function assertPropertyTypes(
  table: MigrationTable,
  expected: Readonly<Record<string, string>>,
  failures: string[],
): void {
  for (const [name, type] of Object.entries(expected))
    if (table.properties[name] !== type)
      failures.push(
        `${table.id}.${name} expected ${type}, observed ${String(table.properties[name])}`,
      );
}
/** Records type mismatches for optional properties that are present. */
function assertOptionalPropertyTypes(
  table: MigrationTable,
  expected: Readonly<Record<string, string>>,
  failures: string[],
): void {
  for (const [name, type] of Object.entries(expected)) {
    /** Observed provider value compared with the canonical expectation. */
    const observed = table.properties[name];
    if (observed !== undefined && observed !== type)
      failures.push(
        `${table.id}.${name} expected ${type}, observed ${observed}`,
      );
  }
}
/** Appends a deterministic failure when two value sets differ. */
function compareExact(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
  failures: string[],
): void {
  if (
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
  )
    failures.push(`${label} inventory differs from the expected baseline`);
}
/** Requires a non-empty string from untrusted migration input. */
function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
/** Parses a normalized string array at an untyped boundary. */
function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new TypeError(`${label} must be a string array`);
  return value as string[];
}
/** Reads an optional legacy string property. */
function stringProperty(value: unknown, label: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  return value;
}
/** Requires a boolean migration property value. */
function booleanProperty(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${label} must be a boolean`);
  return value;
}
/** Reports whether agent definition. */
function hasAgentDefinition(markdown: string): boolean {
  /** Managed Markdown section located by its exact heading. */
  const section = agentDefinitionSection(markdown);
  if (section === null) return false;
  try {
    /** Strict Agent definition parsed from authoritative Markdown. */
    const definition = parseDefinitionObject(section.content);
    if (definition.schema !== "agent-definition-v1") return false;
    parseAgentDefinition(markdown);
    return true;
  } catch {
    return false;
  }
}
