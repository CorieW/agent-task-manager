// Builds a provider-neutral execution preview using read-only provider operations.
import { digestJson } from "./digest.js";
import { scheduleInvocations } from "./invocation-scheduler.js";
import type { JsonValue } from "../domain/json.js";
import type { ProviderEnvironment } from "../domain/provider.js";
import type { WorkspaceMigrationPlan, WorkspaceSchemaDescriptor } from "../domain/schema.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";

export interface FoundationDryRunReport {
  readonly digest: string;
  readonly environmentValid: boolean;
  readonly migrationPlan: WorkspaceMigrationPlan;
  readonly scheduledSubAgentIds: readonly string[];
  readonly workspaceState: string;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export async function runFoundationDryRun(input: {
  readonly environment: ProviderEnvironment;
  readonly environmentId: string;
  readonly provider: AgentTaskProvider;
  readonly scheduleLimit: number;
  readonly target: WorkspaceSchemaDescriptor;
}): Promise<FoundationDryRunReport> {
  const environmentReport = await input.provider.validateEnvironment(input.environment);
  const observed = await input.provider.inspectWorkspaceSchema();
  const tableReport = await input.provider.validateTables();
  const migrationPlan = await input.provider.planWorkspaceChanges({
    environmentId: input.environmentId,
    mode: tableReport.state === "needs_bootstrap" ? "bootstrap" : "migration",
    observed,
    target: input.target,
  });
  const definitions = await input.provider.listSubAgentDefinitions();
  const scheduled = scheduleInvocations({ activeRuns: {}, definitions, limit: input.scheduleLimit });
  const core = {
    environmentValid: environmentReport.valid,
    migrationPlan,
    scheduledSubAgentIds: scheduled.map((definition) => definition.id),
    workspaceState: tableReport.state,
  };
  return { ...core, digest: digestJson(asJson(core)) };
}
