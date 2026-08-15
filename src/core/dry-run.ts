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

export interface FoundationDryRunReport {
  readonly digest: string;
  readonly environmentValid: boolean;
  readonly migrationPlan: WorkspaceMigrationPlan | null;
  readonly scheduledSubAgentIds: readonly string[];
  readonly workspaceState: WorkspaceState;
}

export async function runFoundationDryRun(input: {
  readonly environment: ProviderEnvironment;
  readonly environmentId: string;
  readonly activeRuns: Readonly<Record<string, number>>;
  readonly dueScheduledDefinitionIds: readonly string[];
  readonly provider: AgentTaskProvider;
  readonly invocationSource: "event" | "manual" | "scheduled";
  readonly scheduleLimit: number;
  readonly target: WorkspaceSchemaDescriptor;
}): Promise<FoundationDryRunReport> {
  const environmentReport = await input.provider.validateEnvironment(input.environment);
  const tableReport = await input.provider.validateTables();
  if (tableReport.target.digest !== input.target.digest) {
    throw new Error("Provider validation target does not match the dry-run target");
  }
  const migrationPlan =
    tableReport.state === "needs_bootstrap" || tableReport.state === "needs_additive_migration"
      ? await input.provider.planWorkspaceChanges({
          environmentId: input.environmentId,
          mode: tableReport.state === "needs_bootstrap" ? "bootstrap" : "migration",
          observed: tableReport.observed,
          target: input.target,
        })
      : null;
  const definitions = await input.provider.listSubAgentDefinitions();
  const scheduled = scheduleInvocations({
    activeRuns: input.activeRuns,
    definitions,
    dueScheduledDefinitionIds: input.dueScheduledDefinitionIds,
    limit: input.scheduleLimit,
    source: input.invocationSource,
  });
  const core = {
    environmentValid: environmentReport.valid,
    migrationPlan,
    scheduledSubAgentIds: scheduled.map((definition) => definition.id),
    workspaceState: tableReport.state,
  };
  return { ...core, digest: digestJson(toJsonValue(core)) };
}
