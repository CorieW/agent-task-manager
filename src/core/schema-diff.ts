/** Classifies observed provider schema drift as ready, additive, bootstrap-required, or incompatible. */
import type {
  SchemaDifference,
  TableValidationReport,
  WorkspaceSchemaDescriptor,
  WorkspaceSchemaSnapshot,
  WorkspaceState,
} from "../domain/schema.js";

/** Classifies schema differences into a workspace readiness state. */
function workspaceState(
  differences: readonly SchemaDifference[],
): WorkspaceState {
  if (
    differences.some(
      (difference) =>
        difference.kind === "incompatible" || difference.kind === "destructive",
    )
  ) {
    return "blocked_incompatible";
  }
  if (differences.some((difference) => difference.kind === "missing_table")) {
    return "needs_bootstrap";
  }
  if (differences.some((difference) => difference.kind === "additive")) {
    return "needs_additive_migration";
  }
  return "ready";
}

/** Compares observed provider tables with the canonical target schema. */
export function compareWorkspaceSchema(
  observed: WorkspaceSchemaSnapshot,
  target: WorkspaceSchemaDescriptor,
): TableValidationReport {
  /** Differences used during compare workspace schema. */
  const differences: SchemaDifference[] = [];

  for (const expectedTable of target.tables) {
    /** Candidates satisfying the current constraints. */
    const candidates = observed.tables.filter(
      (table) => table.kind === expectedTable.kind,
    );
    if (candidates.length === 0) {
      differences.push({
        code: "missing_table",
        kind: "missing_table",
        message: `Missing ${expectedTable.kind} table`,
        path: `tables.${expectedTable.kind}`,
      });
      continue;
    }
    if (candidates.length > 1) {
      differences.push({
        code: "duplicate_table",
        kind: "incompatible",
        message: `Multiple tables map to ${expectedTable.kind}`,
        path: `tables.${expectedTable.kind}`,
      });
      continue;
    }

    /** Observed table used for comparison. */
    const observedTable = candidates[0];
    if (observedTable === undefined) continue;
    for (const expectedProperty of expectedTable.properties) {
      /** Property used during compare workspace schema. */
      const property = observedTable.properties.find(
        (candidate) => candidate.name === expectedProperty.physicalName,
      );
      /** Path used during compare workspace schema. */
      const path = `tables.${expectedTable.kind}.properties.${expectedProperty.physicalName}`;
      if (property === undefined) {
        if (expectedProperty.required) {
          differences.push({
            code: "missing_property",
            kind: "additive",
            message: `Missing required property ${expectedProperty.physicalName}`,
            path,
          });
        }
        continue;
      }
      if (
        property.type !== expectedProperty.type ||
        property.writable !== expectedProperty.writable ||
        (expectedProperty.targetTable === null
          ? property.targetTableId !== null
          : observed.tables.find(
              (table) => table.kind === expectedProperty.targetTable,
            )?.id !== property.targetTableId)
      ) {
        differences.push({
          code: "incompatible_property",
          kind: "incompatible",
          message: `Property ${expectedProperty.physicalName} has incompatible semantics`,
          path,
        });
      }
    }

    for (const managedRange of expectedTable.managedRanges) {
      if (!observedTable.managedRanges.includes(managedRange)) {
        differences.push({
          code: "missing_managed_range",
          kind: "additive",
          message: `Missing managed range ${managedRange}`,
          path: `tables.${expectedTable.kind}.managedRanges.${managedRange}`,
        });
      }
    }
  }

  return {
    differences,
    issues: [],
    observed,
    state: workspaceState(differences),
    target,
  };
}
