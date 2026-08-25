/** Semantic validation for Notion Agent definitions and Resources. */
import type { JsonObject } from "../../../domain/json.js";
import type { TableKind, ValidationIssue } from "../../../domain/provider.js";
import {
  parseAgentDefinition,
  type AgentDefinition,
} from "../../../domain/records.js";
import {
  archived,
  notionPageId,
  pageProperties,
  selectValue,
  textValue,
  validationIssue,
} from "./values.js";

export interface AgentValidationGateway {
  markdown(pageId: string): Promise<string>;
  query(kind: TableKind, filter?: JsonObject): Promise<readonly JsonObject[]>;
}

/** Validates agent semantics. */
export async function validateAgentSemantics(
  gateway: AgentValidationGateway,
  tables: Readonly<Record<TableKind, string | null>>,
  issues: ValidationIssue[],
): Promise<void> {
  if (tables.agents === null || tables.resources === null) return;
  /** Agent pages whose definitions require semantic validation. */
  let agentPages: readonly JsonObject[];
  /** Resource pages indexed for Agent-definition validation. */
  let resourcePages: readonly JsonObject[];
  try {
    [agentPages, resourcePages] = await Promise.all([
      gateway.query("agents"),
      gateway.query("resources"),
    ]);
  } catch (error) {
    issues.push(
      validationIssue(
        "semantic_inventory",
        "Agents",
        `Could not inventory Agent configuration: ${String(error)}`,
      ),
    );
    return;
  }
  /** Resources resolved in the Agent definition's declared order. */
  const resources = resourcePages.map((page) => {
    /** Decoded Notion properties for the current page. */
    const props = pageProperties(page);
    return {
      archived: archived(page),
      id: notionPageId(page),
      key: textValue(props.Resource),
      kind: selectValue(props.Kind),
      state: selectValue(props.State),
    };
  });
  /** Resources grouped by stable key for duplicate and selector validation. */
  const resourcesByKey = new Map<string, typeof resources>();
  for (const resource of resources) {
    /** Configuration, validation, filesystem, or provider path for this value. */
    const path = `Resources.${resource.id}`;
    if (resource.key === "")
      issues.push(
        validationIssue("resource_key", path, "Resource key is empty"),
      );
    if (resource.kind === "")
      issues.push(
        validationIssue("resource_kind", path, "Resource Kind is empty"),
      );
    if (!["Active", "Draft", "Retired"].includes(resource.state))
      issues.push(
        validationIssue(
          "resource_state",
          path,
          `Unsupported State: ${resource.state}`,
        ),
      );
    /** All candidates matching the requested stable key. */
    const matches = resourcesByKey.get(resource.key) ?? [];
    matches.push(resource);
    resourcesByKey.set(resource.key, matches);
  }
  for (const [key, matches] of resourcesByKey)
    if (key !== "" && matches.length > 1)
      issues.push(
        validationIssue(
          "duplicate_resource_key",
          `Resources.${key}`,
          `Resource key appears ${matches.length} times`,
        ),
      );

  /** Ordered definitions used by validate agent semantics. */
  const definitions: Array<{
    /** Strict Agent definition parsed from authoritative Markdown. */
    definition: AgentDefinition;
    /** Stable page ID. */
    pageId: string;
  }> = [];
  for (const page of agentPages) {
    /** Normalized provider page ID used for uniqueness checks. */
    const pageId = notionPageId(page);
    try {
      definitions.push({
        definition: parseAgentDefinition(await gateway.markdown(pageId)),
        pageId,
      });
    } catch (error) {
      issues.push(
        validationIssue(
          "agent_definition",
          `Agents.${pageId}`,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  /** Agent definitions grouped by stable ID for uniqueness validation. */
  const definitionsById = new Map<string, typeof definitions>();
  for (const entry of definitions) {
    /** All candidates matching the requested stable key. */
    const matches = definitionsById.get(entry.definition.id) ?? [];
    matches.push(entry);
    definitionsById.set(entry.definition.id, matches);
  }
  for (const [definitionId, matches] of definitionsById)
    if (matches.length > 1)
      issues.push(
        validationIssue(
          "duplicate_agent_id",
          `Agents.${definitionId}`,
          `Agent definition id appears ${matches.length} times`,
        ),
      );
  for (const { definition, pageId } of definitions)
    for (const key of definition.resourceKeys) {
      /** All candidates matching the requested stable key. */
      const matches = resourcesByKey.get(key) ?? [];
      /** Configuration, validation, filesystem, or provider path for this value. */
      const path = `Agents.${pageId}.resources.${key}`;
      if (matches.length === 0) {
        issues.push(
          validationIssue(
            "missing_resource",
            path,
            "Referenced Resource is missing",
          ),
        );
        continue;
      }
      if (matches.length > 1) continue;
      /** Resource currently resolved or validated for Agent context. */
      const resource = matches[0]!;
      if (resource.archived || resource.state !== "Active")
        issues.push(
          validationIssue(
            "unavailable_resource",
            path,
            "Referenced Resource must be active",
          ),
        );
      if (key.startsWith("prompt/") && resource.kind !== "Prompt")
        issues.push(
          validationIssue(
            "resource_kind_mismatch",
            path,
            `Expected Prompt, received ${resource.kind}`,
          ),
        );
    }
}
