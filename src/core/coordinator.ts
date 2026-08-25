/** Coordinates owned Agent runs, hierarchy, completion, failure, and retries. */
import type {
  ActiveAgentContext,
  ActiveAgentRecord,
  ReportErrorInput,
  RestartActiveAgentInput,
  StartActiveAgentInput,
  TaskRecord,
} from "../domain/records.js";
import type { AgentCommandPolicy } from "../domain/commands.js";
import { upsertTaskDescriptionSection } from "../domain/task-description.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { harnessContext } from "./coordinator/context.js";
import { CoordinatorRuntime } from "./coordinator/runtime.js";
import { MAX_ATTEMPTS } from "./coordinator/retry.js";
export { MAX_ATTEMPTS, retryErrorKey } from "./coordinator/retry.js";
import { retryErrorKey } from "./coordinator/retry.js";
import {
  NO_LIFECYCLE_COMMANDS,
  type AgentLifecycleCommands,
} from "./lifecycle-commands.js";

/** Maximum time a running Agent may go without a heartbeat. */
export const STALE_AFTER_MILLISECONDS = 5 * 60 * 1000;
/** Maximum attempts in one retry chain before human resolution is required. */

/** Result of terminating one stale root and its running descendants. */
export interface SweepResult {
  /** Whether the terminated run remains below the automatic retry limit. */
  readonly retryBudgetRemaining: boolean;
  /** Active Agent run included in the immutable execution context. */
  readonly run: ActiveAgentRecord;
}

/** One stale root and every running run its termination may mutate. */
export interface SweepPlan {
  /** Run ID of the outermost stale root. */
  readonly rootRunId: string;
  /** Sorted run IDs whose state the operation may mutate. */
  readonly runIds: readonly string[];
}

/** Enforces provider-neutral lifecycle, ownership, and hierarchy invariants. */
export class AgentCoordinator extends CoordinatorRuntime {
  /** Creates a coordinator with an injectable clock for deterministic hosts/tests. */
  public constructor(
    provider: AgentTaskProvider,
    now: () => Date = () => new Date(),
    lifecycle: AgentLifecycleCommands = NO_LIFECYCLE_COMMANDS,
  ) {
    super(provider, now, lifecycle);
  }

  /** Starts a run or idempotently replays an identical existing Run ID. */
  public async start(
    input: StartActiveAgentInput,
  ): Promise<ActiveAgentContext> {
    /** Existing run considered for idempotent start replay. */
    const replay = await this.provider.getActiveAgent(input.runId);
    if (replay !== null) {
      if (replay.archived || replay.status !== "running")
        throw new Error("Run ID belongs to a terminal Active Agent");
      /** Agent definition resolved for the current run. */
      const agent = await this.requiredAgent(input.agentKey);
      this.assertCaller(agent, input.harnessId);
      if (
        replay.agentId !== agent.id ||
        replay.agentVersion !== agent.version ||
        replay.taskId !== input.taskId ||
        replay.parentRunId !== input.parentRunId ||
        replay.harnessId !== input.harnessId
      )
        throw new Error(
          "Run ID reuse conflicts with the existing Active Agent",
        );
      this.assertWorkingDirectory(agent, replay);
      return this.context(replay, agent);
    }
    assertNewRunId(input.runId);
    /** Agent definition resolved for the current run. */
    const agent = await this.requiredAgent(input.agentKey);
    this.assertCaller(agent, input.harnessId);
    /** Assigned Task loaded and checked for availability. */
    const task = await this.provider.getTask(input.taskId);
    if (task === null || task.archived)
      throw new Error(`Task is unavailable: ${input.taskId}`);
    this.assertTaskEligibility(agent, task);
    /** Snapshot of currently running Active Agent records. */
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
      /** Running parent selected from the Task's live-run snapshot. */
      const parent = live.find((entry) => entry.runId === input.parentRunId);
      if (parent === undefined)
        throw new Error("Parent Active Agent is not running");
      if (parent.taskId !== input.taskId)
        throw new Error("Child Active Agent must use its parent Task");
      if (parent.harnessId !== input.harnessId)
        throw new Error("Child Active Agent must use its parent harness");
    }
    /** Resources resolved in the Agent definition's declared order. */
    const resources = await this.resourcesFor(agent);
    /** Trusted lifecycle executor and context for the run. */
    const lifecycle = this.startLifecycleContext(agent, input);
    await this.lifecycle.before(agent.lifecycleCommands, lifecycle);
    /** Single ISO timestamp shared by the new run fields. */
    const startedAt = this.now().toISOString();
    /** Newly persisted Active Agent for this start attempt. */
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
      workingDirectory: lifecycle.workingDirectory,
    });
    return harnessContext(agent, resources, run, task);
  }

  /** Records a heartbeat after verifying the run is running and harness-owned. */
  public async heartbeat(
    runId: string,
    harnessId: string,
  ): Promise<ActiveAgentRecord> {
    /** Running harness-owned Active Agent eligible for a heartbeat. */
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
    /** Active Agent record loaded directly so partial completion can resume. */
    let run = await this.provider.getActiveAgent(runId);
    if (run === null) throw new Error("Active Agent is unavailable");
    if (run.harnessId !== harnessId)
      throw new Error("Harness does not own Active Agent");
    if (run.status === "completed") {
      if (run.outcome !== outcome)
        throw new Error("Completed Active Agent has a different outcome");
      if (!run.archived) await this.provider.archiveActiveAgent(runId);
      /** Provider readback of the completed run after archival. */
      const archived = await this.provider.getActiveAgent(runId);
      if (archived === null)
        throw new Error("Completed Active Agent became unavailable");
      return archived;
    }
    if (run.status !== "running")
      throw new Error("Active Agent is not running");
    /** Descendant runs checked before completing the root. */
    const descendants = this.descendants(
      run.runId,
      await this.provider.listActiveAgents(),
    );
    if (descendants.some((entry) => entry.status === "running"))
      throw new Error(
        "Active Agent cannot complete while descendants are running",
      );
    /** Agent definition resolved for the current run. */
    const agent = await this.agentById(run.agentId);
    this.assertAgentVersion(run, agent);
    this.assertWorkingDirectory(agent, run);
    /** Assigned Task loaded and checked for availability. */
    const task = await this.provider.getTask(run.taskId);
    if (task === null || task.archived)
      throw new Error("Active Agent Task is unavailable");
    if (!Object.hasOwn(agent.transitions, outcome))
      throw new Error(`Agent does not declare outcome: ${outcome}`);
    /** Destination Task status, or the sentinel that retains the current status. */
    const target = agent.transitions[outcome]!;
    if (run.outcome !== "" && run.outcome !== outcome)
      throw new Error("Active Agent is finalizing a different outcome");
    if (run.outcome === "") this.assertTaskEligibility(agent, task);
    this.assertRequiredOutcomeSections(agent, task, outcome);
    if (run.outcome === "")
      run = await this.provider.updateActiveAgent(runId, {
        completionTaskStatus: task.status,
        outcome,
      });
    await this.lifecycle.after(
      agent.lifecycleCommands,
      this.terminalLifecycleContext(run, agent.key, "completed", outcome, ""),
    );
    if (target !== "$current") {
      /** Current Task state checked immediately before the guarded transition. */
      const current = await this.provider.getTask(run.taskId);
      if (current === null || current.archived)
        throw new Error("Active Agent Task is unavailable");
      this.assertRequiredOutcomeSections(agent, current, outcome);
      if (current.status !== target) {
        if (
          run.completionTaskStatus === undefined ||
          run.completionTaskStatus === "" ||
          current.status !== run.completionTaskStatus
        )
          throw new Error("Task status changed while completion was pending");
        this.assertTaskEligibility(agent, current);
        await this.provider.setTaskStatus(
          run.taskId,
          current.status,
          current.version,
          target,
        );
      }
    }
    /** Completed run record returned after archival. */
    const completed = await this.provider.updateActiveAgent(runId, {
      finishedAt: this.now().toISOString(),
      outcome,
      status: "completed",
    });
    await this.provider.archiveActiveAgent(runId);
    return (await this.provider.getActiveAgent(runId)) ?? completed;
  }

  /** Fails a harness-owned run and stops each running descendant. */
  public async fail(
    runId: string,
    harnessId: string,
    summary: string,
  ): Promise<ActiveAgentRecord> {
    /** Running harness-owned Active Agent selected for failure. */
    const run = await this.runningOwned(runId, harnessId);
    return this.terminate(run, "failed", summary);
  }

  /** Plans independently leaseable stale subtrees from one provider snapshot. */
  public async planSweep(): Promise<readonly SweepPlan[]> {
    /** Running snapshot and outermost stale roots derived from it. */
    const { live, roots } = await this.sweepState();
    /** First-observed parent relation indexed for this exact snapshot. */
    const parents = this.parentIndex(live);
    return roots.map((root) => ({
      rootRunId: root.runId,
      runIds: [root, ...this.descendants(root.runId, live, parents)]
        .map((run) => run.runId)
        .sort(),
    }));
  }

  /** Terminates stale roots, optionally restricted to an already leased plan. */
  public async sweep(
    rootRunIds?: readonly string[],
  ): Promise<readonly SweepResult[]> {
    /** Outermost stale roots selected from the running snapshot. */
    const { roots } = await this.sweepState();
    /** Requested stale roots that still qualify in the current snapshot. */
    const selected =
      rootRunIds === undefined
        ? roots
        : roots.filter((run) => rootRunIds.includes(run.runId));
    /** Results accumulated in deterministic processing order. */
    const results: SweepResult[] = [];
    for (const run of selected) {
      /** Terminal run record returned after provider mutation. */
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
    /** Complete running snapshot used for descendant analysis. */
    readonly live: readonly ActiveAgentRecord[];
    /** Outermost stale roots selected from the running snapshot. */
    readonly roots: readonly ActiveAgentRecord[];
  }> {
    /** Clock reading used for all comparisons in this operation. */
    const now = this.now().getTime();
    /** Snapshot of currently running Active Agent records. */
    const live = (await this.provider.listActiveAgents()).filter(
      (entry) => entry.status === "running",
    );
    /** Heartbeat-expired runs in the current running snapshot. */
    const stale = live.filter(
      (entry) =>
        now - Date.parse(entry.lastHeartbeat) > STALE_AFTER_MILLISECONDS,
    );
    /** First-observed parent relation indexed for this exact snapshot. */
    const parents = this.parentIndex(live);
    /** Outermost stale roots selected from the running snapshot. */
    const roots = stale.filter(
      (candidate) =>
        !stale.some((other) =>
          this.isDescendant(candidate, other.runId, parents),
        ),
    );
    return { live, roots };
  }

  /** Creates a replacement attempt for a failed or stale run. */
  public async restart(
    input: RestartActiveAgentInput,
  ): Promise<ActiveAgentContext> {
    assertNewRunId(input.runId);
    if ((await this.provider.getActiveAgent(input.runId)) !== null)
      throw new Error(`Run ID already exists: ${input.runId}`);
    /** Failed or stale attempt selected for restart. */
    const restartSource = await this.provider.getActiveAgent(
      input.restartOfRunId,
    );
    if (
      restartSource === null ||
      (restartSource.status !== "failed" && restartSource.status !== "stale")
    )
      throw new Error("Only a failed or stale Active Agent can restart");
    /** Persisted retry-chain snapshot used to enforce one unique current leaf. */
    const attempts = (await this.provider.listActiveAgents()).filter(
      (entry) => entry.retryKey === restartSource.retryKey,
    );
    if (attempts.some((entry) => entry.restartOfRunId === restartSource.runId))
      throw new Error("Active Agent attempt already has a replacement");
    /** Maximum visible attempt number for the persisted retry chain. */
    const highestAttempt = Math.max(
      restartSource.attempt,
      ...attempts.map((entry) => entry.attempt),
    );
    if (restartSource.attempt !== highestAttempt)
      throw new Error("Only the latest Active Agent attempt can restart");
    /** One-based attempt number within the retry chain. */
    let attempt = highestAttempt + 1;
    /** Stable identity shared by attempts in one retry chain. */
    let retryKey = restartSource.retryKey;
    if (attempt > MAX_ATTEMPTS) {
      /** Error record that gates the exhausted retry chain. */
      const error = await this.provider.getErrorByKey(
        retryErrorKey(restartSource.retryKey),
      );
      if (error === null || error.status !== "resolved")
        throw new Error("Retry chain is blocked until its Error is resolved");
      attempt = 1;
      retryKey = input.runId;
    }
    if (restartSource.parentRunId !== null) {
      /** Running parent retained by the replacement attempt. */
      const parent = await this.provider.getActiveAgent(
        restartSource.parentRunId,
      );
      if (parent === null || parent.status !== "running")
        throw new Error("Parent Active Agent is no longer running");
    } else {
      /** Whether another running root already owns the Task. */
      const collision = (await this.provider.listActiveAgents()).some(
        (entry) =>
          entry.status === "running" &&
          entry.parentRunId === null &&
          entry.taskId === restartSource.taskId,
      );
      if (collision)
        throw new Error("Task already has a running root Active Agent");
    }
    /** Single ISO timestamp shared by the new run fields. */
    const startedAt = this.now().toISOString();
    /** Agent definition resolved for the current run. */
    const agent = await this.agentById(restartSource.agentId);
    if (!agent.enabled) throw new Error("Disabled Agent cannot restart");
    this.assertCaller(agent, input.harnessId);
    this.assertRestartVersion(restartSource, agent);
    /** Assigned Task loaded and checked for availability. */
    const task = await this.provider.getTask(restartSource.taskId);
    if (task === null || task.archived)
      throw new Error("Active Agent Task is unavailable");
    this.assertTaskEligibility(agent, task);
    /** Resources resolved in the Agent definition's declared order. */
    const resources = await this.resourcesFor(agent);
    /** Trusted lifecycle executor and context for the run. */
    const lifecycle = this.startLifecycleContext(agent, {
      harnessId: input.harnessId,
      parentRunId: restartSource.parentRunId,
      runId: input.runId,
      taskId: restartSource.taskId,
    });
    await this.lifecycle.before(agent.lifecycleCommands, lifecycle);
    /** Newly persisted Active Agent for this replacement attempt. */
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
      workingDirectory: lifecycle.workingDirectory,
    });
    return harnessContext(agent, resources, run, task);
  }

  /** Returns the pinned command policy and configured execution directory. */
  public async commandAuthorization(
    runId: string,
    harnessId: string,
  ): Promise<{
    /** Agent command inclusion or exclusion policy. */
    readonly commands: AgentCommandPolicy;
    /** Absolute execution directory, or null for the host default. */
    readonly workingDirectory: string | null;
  }> {
    /** Running harness-owned Active Agent whose command policy is requested. */
    const run = await this.runningOwned(runId, harnessId);
    /** Agent definition resolved for the current run. */
    const agent = await this.agentById(run.agentId);
    this.assertAgentVersion(run, agent);
    this.assertWorkingDirectory(agent, run);
    return {
      commands: agent.commands,
      workingDirectory: run.workingDirectory,
    };
  }

  /** Replaces one Agent-authorized Task-description section in place. */
  public async updateTaskSection(
    runId: string,
    harnessId: string,
    section: string,
    content: string,
  ): Promise<TaskRecord> {
    /** Running harness-owned Active Agent requesting the Task update. */
    const run = await this.runningOwned(runId, harnessId);
    /** Agent definition resolved for the current run. */
    const agent = await this.agentById(run.agentId);
    this.assertAgentVersion(run, agent);
    this.assertWorkingDirectory(agent, run);
    if (!agent.taskDescription.writableSections.includes(section))
      throw new Error(
        `Agent is not allowed to write Task description section: ${section}`,
      );
    /** Assigned Task loaded and checked for availability. */
    const task = await this.provider.getTask(run.taskId);
    if (task === null || task.archived)
      throw new Error("Active Agent Task is unavailable");
    this.assertTaskEligibility(agent, task);
    /** Markdown body read or rendered for the current record. */
    const body = upsertTaskDescriptionSection(task.body, section, content);
    return this.provider.updateTaskBody(task.id, task.body, body);
  }

  /** Creates or reopens a keyed Error through the configured provider. */
  public async reportError(input: ReportErrorInput) {
    return this.provider.reportError(input);
  }

  /** Stores a resolution and marks the keyed Error resolved. */
  public async resolveError(key: string, resolution: string) {
    return this.provider.resolveError(key, resolution);
  }
}

/** Restricts new run identities to one bounded path-safe component. */
function assertNewRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(runId))
    throw new Error("Run ID must be a path-safe identifier");
}
