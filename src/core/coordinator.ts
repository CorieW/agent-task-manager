/** Coordinates owned Agent runs, hierarchy, completion, failure, and retries. */
import type {
  ActiveAgentContext,
  ActiveAgentRecord,
  AgentRecord,
  ReportErrorInput,
  RestartActiveAgentInput,
  StartActiveAgentInput,
} from "../domain/records.js";
import type { AgentCommandPolicy } from "../domain/commands.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { commandProxySystemPrompt } from "./agent-system-prompt.js";

/** Maximum time a running Agent may go without a heartbeat. */
export const STALE_AFTER_MILLISECONDS = 5 * 60 * 1000;
/** Maximum attempts in one retry chain before human resolution is required. */
export const MAX_ATTEMPTS = 3;

/** Result of terminating one stale root and its running descendants. */
export interface SweepResult {
  /** Whether the terminated run remains below the automatic retry limit. */
  readonly retryBudgetRemaining: boolean;
  readonly run: ActiveAgentRecord;
}

/** One stale root and every running run its termination may mutate. */
export interface SweepPlan {
  readonly rootRunId: string;
  readonly runIds: readonly string[];
}

/** Enforces provider-neutral lifecycle, ownership, and hierarchy invariants. */
export class AgentCoordinator {
  /** Creates a coordinator with an injectable clock for deterministic hosts/tests. */
  public constructor(
    private readonly provider: AgentTaskProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Starts a run or idempotently replays an identical existing Run ID. */
  public async start(
    input: StartActiveAgentInput,
  ): Promise<ActiveAgentContext> {
    const replay = await this.provider.getActiveAgent(input.runId);
    if (replay !== null) {
      const agent = await this.requiredAgent(input.agentKey);
      if (
        replay.agentId !== agent.id ||
        !this.agentVersionMatches(replay.agentVersion, agent) ||
        replay.taskId !== input.taskId ||
        replay.parentRunId !== input.parentRunId ||
        replay.harnessId !== input.harnessId
      )
        throw new Error(
          "Run ID reuse conflicts with the existing Active Agent",
        );
      return this.context(replay, agent);
    }
    const agent = await this.requiredAgent(input.agentKey);
    const task = await this.provider.getTask(input.taskId);
    if (task === null || task.archived)
      throw new Error(`Task is unavailable: ${input.taskId}`);
    const live = (await this.provider.listActiveAgents()).filter(
      (entry) => entry.status === "running",
    );
    if (input.parentRunId === null) {
      if (
        live.some(
          (entry) =>
            entry.parentRunId === null && entry.taskId === input.taskId,
        )
      )
        throw new Error("Task already has a running root Active Agent");
    } else {
      const parent = live.find((entry) => entry.runId === input.parentRunId);
      if (parent === undefined)
        throw new Error("Parent Active Agent is not running");
      if (parent.taskId !== input.taskId)
        throw new Error("Child Active Agent must use its parent Task");
    }
    const resources = await this.resourcesFor(agent);
    const startedAt = this.now().toISOString();
    const run = await this.provider.createActiveAgent({
      agentId: agent.id,
      agentVersion: agent.version,
      attempt: 1,
      harnessId: input.harnessId,
      parentRunId: input.parentRunId,
      restartOfRunId: null,
      retryKey: input.runId,
      runId: input.runId,
      startedAt,
      taskId: input.taskId,
    });
    return {
      agent,
      resources,
      run,
      systemPrompt: commandProxySystemPrompt(),
      task,
    };
  }

  /** Records a heartbeat after verifying the run is running and harness-owned. */
  public async heartbeat(
    runId: string,
    harnessId: string,
  ): Promise<ActiveAgentRecord> {
    const run = await this.runningOwned(runId, harnessId);
    return this.provider.updateActiveAgent(run.runId, {
      lastHeartbeat: this.now().toISOString(),
    });
  }

  /** Applies a declared outcome, completes the run, and archives its record. */
  public async complete(
    runId: string,
    harnessId: string,
    outcome: string,
  ): Promise<ActiveAgentRecord> {
    const run = await this.runningOwned(runId, harnessId);
    const descendants = this.descendants(
      run.runId,
      await this.provider.listActiveAgents(),
    );
    if (descendants.some((entry) => entry.status === "running"))
      throw new Error(
        "Active Agent cannot complete while descendants are running",
      );
    const agent = await this.agentById(run.agentId);
    this.assertAgentVersion(run, agent);
    if (!Object.hasOwn(agent.transitions, outcome))
      throw new Error(`Agent does not declare outcome: ${outcome}`);
    const target = agent.transitions[outcome]!;
    if (target !== "$current")
      await this.provider.setTaskStatus(run.taskId, target);
    const completed = await this.provider.updateActiveAgent(runId, {
      finishedAt: this.now().toISOString(),
      outcome,
      status: "completed",
    });
    await this.provider.archiveActiveAgent(runId);
    return completed;
  }

  /** Fails a harness-owned run and stops each running descendant. */
  public async fail(
    runId: string,
    harnessId: string,
    summary: string,
  ): Promise<ActiveAgentRecord> {
    const run = await this.runningOwned(runId, harnessId);
    return this.terminate(run, "failed", summary);
  }

  /** Plans independently leaseable stale subtrees from one provider snapshot. */
  public async planSweep(): Promise<readonly SweepPlan[]> {
    const { live, roots } = await this.sweepState();
    return roots.map((root) => ({
      rootRunId: root.runId,
      runIds: [root, ...this.descendants(root.runId, live)]
        .map((run) => run.runId)
        .sort(),
    }));
  }

  /** Terminates stale roots, optionally restricted to an already leased plan. */
  public async sweep(
    rootRunIds?: readonly string[],
  ): Promise<readonly SweepResult[]> {
    const { roots } = await this.sweepState();
    const selected =
      rootRunIds === undefined
        ? roots
        : roots.filter((run) => rootRunIds.includes(run.runId));
    const results: SweepResult[] = [];
    for (const run of selected) {
      const terminated = await this.terminate(
        run,
        "stale",
        "Heartbeat expired",
      );
      results.push({
        retryBudgetRemaining: terminated.attempt < MAX_ATTEMPTS,
        run: terminated,
      });
    }
    return results;
  }

  /** Returns running records and their outermost heartbeat-expired roots. */
  private async sweepState(): Promise<{
    readonly live: readonly ActiveAgentRecord[];
    readonly roots: readonly ActiveAgentRecord[];
  }> {
    const now = this.now().getTime();
    const live = (await this.provider.listActiveAgents()).filter(
      (entry) => entry.status === "running",
    );
    const stale = live.filter(
      (entry) =>
        now - Date.parse(entry.lastHeartbeat) > STALE_AFTER_MILLISECONDS,
    );
    const roots = stale.filter(
      (candidate) =>
        !stale.some((other) => this.isDescendant(candidate, other.runId, live)),
    );
    return { live, roots };
  }

  /** Creates a replacement attempt for a failed or stale run. */
  public async restart(
    input: RestartActiveAgentInput,
  ): Promise<ActiveAgentContext> {
    if ((await this.provider.getActiveAgent(input.runId)) !== null)
      throw new Error(`Run ID already exists: ${input.runId}`);
    const restartSource = await this.provider.getActiveAgent(
      input.restartOfRunId,
    );
    if (
      restartSource === null ||
      (restartSource.status !== "failed" && restartSource.status !== "stale")
    )
      throw new Error("Only a failed or stale Active Agent can restart");
    let attempt = restartSource.attempt + 1;
    let retryKey = restartSource.retryKey;
    if (attempt > MAX_ATTEMPTS) {
      const error = await this.provider.getErrorByKey(
        retryErrorKey(restartSource.retryKey),
      );
      if (error === null || error.status !== "resolved")
        throw new Error("Retry chain is blocked until its Error is resolved");
      attempt = 1;
      retryKey = input.runId;
    }
    if (restartSource.parentRunId !== null) {
      const parent = await this.provider.getActiveAgent(
        restartSource.parentRunId,
      );
      if (parent === null || parent.status !== "running")
        throw new Error("Parent Active Agent is no longer running");
    } else {
      const collision = (await this.provider.listActiveAgents()).some(
        (entry) =>
          entry.status === "running" &&
          entry.parentRunId === null &&
          entry.taskId === restartSource.taskId,
      );
      if (collision)
        throw new Error("Task already has a running root Active Agent");
    }
    const startedAt = this.now().toISOString();
    const agent = await this.agentById(restartSource.agentId);
    this.assertAgentVersion(restartSource, agent);
    const task = await this.provider.getTask(restartSource.taskId);
    if (task === null || task.archived)
      throw new Error("Active Agent Task is unavailable");
    const resources = await this.resourcesFor(agent);
    const run = await this.provider.createActiveAgent({
      agentId: restartSource.agentId,
      agentVersion: agent.version,
      attempt,
      harnessId: input.harnessId,
      parentRunId: restartSource.parentRunId,
      restartOfRunId: restartSource.runId,
      retryKey,
      runId: input.runId,
      startedAt,
      taskId: restartSource.taskId,
    });
    return {
      agent,
      resources,
      run,
      systemPrompt: commandProxySystemPrompt(),
      task,
    };
  }

  /** Returns the pinned command policy after checking run ownership. */
  public async commandPolicy(
    runId: string,
    harnessId: string,
  ): Promise<AgentCommandPolicy> {
    const run = await this.runningOwned(runId, harnessId);
    const agent = await this.agentById(run.agentId);
    this.assertAgentVersion(run, agent);
    return agent.commands;
  }

  /** Creates or reopens a keyed Error through the configured provider. */
  public async reportError(input: ReportErrorInput) {
    return this.provider.reportError(input);
  }
  /** Stores a resolution and marks the keyed Error resolved. */
  public async resolveError(key: string, resolution: string) {
    return this.provider.resolveError(key, resolution);
  }

  private async terminate(
    run: ActiveAgentRecord,
    status: "failed" | "stale",
    summary: string,
  ): Promise<ActiveAgentRecord> {
    const all = await this.provider.listActiveAgents();
    for (const child of this.descendants(run.runId, all).filter(
      (entry) => entry.status === "running",
    )) {
      await this.provider.updateActiveAgent(child.runId, {
        failureSummary: `Stopped because ancestor ${run.runId} ${status}`,
        finishedAt: this.now().toISOString(),
        status: "stopped",
      });
      await this.provider.archiveActiveAgent(child.runId);
    }
    const terminated = await this.provider.updateActiveAgent(run.runId, {
      failureSummary: summary,
      finishedAt: this.now().toISOString(),
      status,
    });
    if (terminated.attempt >= MAX_ATTEMPTS) {
      await this.provider.reportError({
        activeAgentId: terminated.id,
        agentId: terminated.agentId,
        description: `Active Agent ${terminated.runId} exhausted ${MAX_ATTEMPTS} attempts: ${summary}`,
        errorKey: retryErrorKey(terminated.retryKey),
        resolution: "",
        severity: "high",
        source: "system",
        taskId: terminated.taskId,
        title: "Active Agent retry limit reached",
      });
    }
    return terminated;
  }

  private async context(
    run: ActiveAgentRecord,
    agent: AgentRecord,
  ): Promise<ActiveAgentContext> {
    this.assertAgentVersion(run, agent);
    const task = await this.provider.getTask(run.taskId);
    if (task === null || task.archived)
      throw new Error("Active Agent Task is unavailable");
    const resources = await this.resourcesFor(agent);
    return {
      agent,
      resources,
      run,
      systemPrompt: commandProxySystemPrompt(),
      task,
    };
  }

  private async resourcesFor(
    agent: AgentRecord,
  ): Promise<ActiveAgentContext["resources"]> {
    const available = await this.provider.listResources();
    const byId = new Map(available.map((entry) => [entry.id, entry]));
    const resources = agent.resourceIds.map((id) => {
      const resource = byId.get(id);
      if (
        resource === undefined ||
        resource.archived ||
        resource.state !== "active"
      )
        throw new Error(`Agent Resource is unavailable: ${id}`);
      if (
        resource.kind.toLowerCase() !== "prompt" &&
        resource.kind.toLowerCase() !== "policy"
      )
        throw new Error(
          `Agent Resource must be Prompt or Policy: ${resource.key}`,
        );
      return resource;
    });
    return resources;
  }

  private async requiredAgent(key: string): Promise<AgentRecord> {
    const agent = await this.provider.getAgentByKey(key);
    if (agent === null || agent.archived || !agent.enabled)
      throw new Error(`Agent is unavailable: ${key}`);
    return agent;
  }
  private async agentById(id: string): Promise<AgentRecord> {
    const agent = await this.provider.getAgent(id);
    if (agent === null || agent.archived)
      throw new Error(`Agent is unavailable: ${id}`);
    return agent;
  }
  private assertAgentVersion(run: ActiveAgentRecord, agent: AgentRecord): void {
    if (!this.agentVersionMatches(run.agentVersion, agent))
      throw new Error("Agent definition changed after the run started");
  }
  private agentVersionMatches(version: string, agent: AgentRecord): boolean {
    return (
      version === agent.version ||
      (agent.compatibleVersions?.includes(version) ?? false)
    );
  }
  private async runningOwned(
    runId: string,
    harnessId: string,
  ): Promise<ActiveAgentRecord> {
    const run = await this.provider.getActiveAgent(runId);
    if (run === null || run.status !== "running")
      throw new Error("Active Agent is not running");
    if (run.harnessId !== harnessId)
      throw new Error("Harness does not own Active Agent");
    return run;
  }
  private descendants(
    runId: string,
    values: readonly ActiveAgentRecord[],
  ): ActiveAgentRecord[] {
    return values.filter((entry) => this.isDescendant(entry, runId, values));
  }
  private isDescendant(
    candidate: ActiveAgentRecord,
    runId: string,
    values: readonly ActiveAgentRecord[],
  ): boolean {
    let parent = candidate.parentRunId;
    const seen = new Set<string>();
    while (parent !== null) {
      if (parent === runId) return true;
      if (seen.has(parent)) return false;
      seen.add(parent);
      parent =
        values.find((entry) => entry.runId === parent)?.parentRunId ?? null;
    }
    return false;
  }
}

/** Returns the stable Error key that gates a retry chain after its limit. */
export function retryErrorKey(retryKey: string): string {
  return `active-agent-retry:${retryKey}`;
}
