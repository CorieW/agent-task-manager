/** Builds a provider-neutral execution preview using read-only provider operations. */
import { digestJson } from "./digest.js";
import { scheduleInvocations } from "./invocation-scheduler.js";
import { toJsonValue } from "../domain/json.js";
import type { ProviderEnvironment } from "../domain/provider.js";
import type {
  WorkspaceMigrationPlan,
  WorkspaceSchemaDescriptor,
  WorkspaceState,
} from "../domain/schema.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";

/** Validation report for foundation dry run. */
export interface FoundationDryRunReport {
  /** SHA-256 digest of the complete dry-run report. */
  readonly digest: string;
  /** Whether provider environment validation succeeded. */
  readonly environmentValid: boolean;
  /** Migration plan for foundation dry run report. */
  readonly migrationPlan: WorkspaceMigrationPlan | null;
  /** Scheduled sub-agent IDs. */
  readonly scheduledSubAgentIds: readonly string[];
  /** Workspace state for foundation dry run report. */
  readonly workspaceState: WorkspaceState;
}

/** Builds a read-only preview of validation, migration, and scheduled definitions. */
export async function runFoundationDryRun(input: {
  /** Environment for run foundation dry run input. */
  readonly environment: ProviderEnvironment;
  /** Stable identifier for environment. */
  readonly environmentId: string;
  /** Active run count indexed by sub-agent definition ID. */
  readonly activeRuns: Readonly<Record<string, number>>;
  /** Due scheduled definition IDs. */
  readonly dueScheduledDefinitionIds: readonly string[];
  /** Provider for run foundation dry run input. */
  readonly provider: AgentTaskProvider;
  /** Invocation source for run foundation dry run input. */
  readonly invocationSource: "event" | "manual" | "scheduled";
  /** Schedule limit for run foundation dry run input. */
  readonly scheduleLimit: number;
  /** Target for run foundation dry run input. */
  readonly target: WorkspaceSchemaDescriptor;
}): Promise<FoundationDryRunReport> {
  /** Environment report loaded during run foundation dry run. */
  const environmentReport = await input.provider.validateEnvironment(
    input.environment,
  );
  /** Table report loaded during run foundation dry run. */
  const tableReport = await input.provider.validateTables();
  if (tableReport.target.digest !== input.target.digest) {
    throw new Error(
      "Provider validation target does not match the dry-run target",
    );
  }
  /** Migration plan loaded during run foundation dry run. */
  const migrationPlan =
    tableReport.state === "needs_bootstrap" ||
    tableReport.state === "needs_additive_migration"
      ? await input.provider.planWorkspaceChanges({
          environmentId: input.environmentId,
          mode:
            tableReport.state === "needs_bootstrap" ? "bootstrap" : "migration",
          observed: tableReport.observed,
          target: input.target,
        })
      : null;
  /** Definitions loaded during run foundation dry run. */
  const definitions = await input.provider.listSubAgentDefinitions();
  /** Scheduled used during run foundation dry run. */
  const scheduled = scheduleInvocations({
    activeRuns: input.activeRuns,
    definitions,
    dueScheduledDefinitionIds: input.dueScheduledDefinitionIds,
    limit: input.scheduleLimit,
    source: input.invocationSource,
  });
  /** Core used during run foundation dry run. */
  const core = {
    environmentValid: environmentReport.valid,
    migrationPlan,
    scheduledSubAgentIds: scheduled.map((definition) => definition.id),
    workspaceState: tableReport.state,
  };
  return { ...core, digest: digestJson(toJsonValue(core)) };
}
