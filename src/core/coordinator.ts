/** Coordinates owned Agent runs, hierarchy, completion, failure, and retries. */
import { resolve } from "node:path";

import type {
  ActiveAgentContext,
  ActiveAgentRecord,
  AgentRecord,
  ReportErrorInput,
  ResourceRecord,
  RestartActiveAgentInput,
  StartActiveAgentInput,
  TaskRecord,
} from "../domain/records.js";
import type { AgentCommandPolicy } from "../domain/commands.js";
import {
  taskDescriptionHasSection,
  upsertTaskDescriptionSection,
} from "../domain/task-description.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import { commandProxySystemPrompt } from "./agent-system-prompt.js";
import {
  NO_LIFECYCLE_COMMANDS,
  type AgentLifecycleCommands,
  type LifecycleCommandContext,
} from "./lifecycle-commands.js";

/** Maximum time a running Agent may go without a heartbeat. */
export const STALE_AFTER_MILLISECONDS = 5 * 60 * 1000;
/** Maximum attempts in one retry chain before human resolution is required. */
export const MAX_ATTEMPTS = 3;

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
export class AgentCoordinator {
  /** Creates a coordinator with an injectable clock for deterministic hosts/tests. */
  public constructor(
    private readonly provider: AgentTaskProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly lifecycle: AgentLifecycleCommands = NO_LIFECYCLE_COMMANDS,
  ) {}

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

  /** Runs cleanup and persists a failed or stale terminal transition. */
  private async terminate(
    run: ActiveAgentRecord,
    status: "failed" | "stale",
    summary: string,
  ): Promise<ActiveAgentRecord> {
    /** Provider snapshot used for stable hierarchy traversal. */
    const all = await this.provider.listActiveAgents();
    /** First-observed parent relation indexed for this exact snapshot. */
    const parents = this.parentIndex(all);
    for (const child of this.descendants(run.runId, all, parents)
      .filter((entry) => entry.status === "running")
      .toSorted(
        (left, right) =>
          this.runDepth(right, parents) - this.runDepth(left, parents) ||
          left.runId.localeCompare(right.runId),
      )) {
      /** Terminal failure explanation recorded for the run. */
      const failureSummary = `Stopped because ancestor ${run.runId} ${status}`;
      /** Agent definition governing the descendant's cleanup hooks. */
      const childAgent = await this.provider.getAgent(child.agentId);
      if (childAgent !== null && childAgent.version === child.agentVersion) {
        this.assertWorkingDirectory(childAgent, child);
        await this.lifecycle.after(
          childAgent.lifecycleCommands,
          this.terminalLifecycleContext(
            child,
            childAgent.key,
            "stopped",
            "",
            failureSummary,
          ),
        );
      }
      await this.provider.updateActiveAgent(child.runId, {
        failureSummary,
        finishedAt: this.now().toISOString(),
        status: "stopped",
      });
      await this.provider.archiveActiveAgent(child.runId);
      if (childAgent === null || childAgent.version !== child.agentVersion)
        await this.reportSkippedCleanup(child, childAgent);
    }
    /** Agent definition resolved for the current run. */
    const agent = await this.provider.getAgent(run.agentId);
    if (agent !== null && agent.version === run.agentVersion) {
      this.assertWorkingDirectory(agent, run);
      await this.lifecycle.after(
        agent.lifecycleCommands,
        this.terminalLifecycleContext(run, agent.key, status, "", summary),
      );
    }
    /** Terminal run record returned after provider mutation. */
    const terminated = await this.provider.updateActiveAgent(run.runId, {
      failureSummary: summary,
      finishedAt: this.now().toISOString(),
      status,
    });
    if (agent === null || agent.version !== run.agentVersion)
      await this.reportSkippedCleanup(terminated, agent);
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

  /** Records lifecycle cleanup that was withheld because its definition was untrusted. */
  private async reportSkippedCleanup(
    run: ActiveAgentRecord,
    agent: AgentRecord | null,
  ): Promise<void> {
    /** Stable reason for operators diagnosing the skipped cleanup. */
    const reason =
      agent === null
        ? "the Agent definition is unavailable"
        : "the Agent definition changed after the run started";
    await this.provider.reportError({
      activeAgentId: run.id,
      agentId: run.agentId,
      description: `Lifecycle cleanup was skipped because ${reason}.`,
      errorKey: `active-agent-cleanup:${run.runId}`,
      resolution: "",
      severity: "high",
      source: "system",
      taskId: run.taskId,
      title: "Active Agent lifecycle cleanup skipped",
    });
  }

  /** Hydrates the immutable Task, Agent, Resource, and run context. */
  private async context(
    run: ActiveAgentRecord,
    agent: AgentRecord,
  ): Promise<ActiveAgentContext> {
    this.assertAgentVersion(run, agent);
    /** Assigned Task loaded and checked for availability. */
    const task = await this.provider.getTask(run.taskId);
    if (task === null || task.archived)
      throw new Error("Active Agent Task is unavailable");
    this.assertTaskEligibility(agent, task);
    /** Resources resolved in the Agent definition's declared order. */
    const resources = await this.resourcesFor(agent);
    return harnessContext(agent, resources, run, task);
  }

  /** Starts lifecycle context. */
  private startLifecycleContext(
    agent: AgentRecord,
    input: {
      /** Identity of the harness that owns the run. */
      readonly harnessId: string;
      /** Run ID of the parent run, or null for a root. */
      readonly parentRunId: string | null;
      /** Harness-supplied idempotency identity of the run attempt. */
      readonly runId: string;
      /** Provider record ID of the assigned Task. */
      readonly taskId: string;
    },
  ): LifecycleCommandContext {
    /** Run-bound context assembled after all eligibility checks. */
    const context = {
      agentKey: agent.key,
      failureSummary: "",
      harnessId: input.harnessId,
      outcome: "",
      parentRunId: input.parentRunId,
      runId: input.runId,
      status: "running" as const,
      taskId: input.taskId,
    };
    return {
      ...context,
      workingDirectory: this.lifecycle.workingDirectory(
        agent.lifecycleCommands,
        context,
      ),
    };
  }

  /** Builds the immutable context for a terminal lifecycle command. */
  private terminalLifecycleContext(
    run: ActiveAgentRecord,
    agentKey: string,
    status: ActiveAgentRecord["status"],
    outcome: string,
    failureSummary: string,
  ): LifecycleCommandContext {
    return {
      agentKey,
      failureSummary,
      harnessId: run.harnessId,
      outcome,
      parentRunId: run.parentRunId,
      runId: run.runId,
      status,
      taskId: run.taskId,
      workingDirectory: run.workingDirectory,
    };
  }

  /** Verifies that a run retained the Agent's configured working directory. */
  private assertWorkingDirectory(
    agent: AgentRecord,
    run: ActiveAgentRecord,
  ): void {
    /** Caller-supplied digest or value required to authorize the operation. */
    const expected = this.lifecycle.workingDirectory(agent.lifecycleCommands, {
      agentKey: agent.key,
      failureSummary: "",
      harnessId: run.harnessId,
      outcome: "",
      parentRunId: run.parentRunId,
      runId: run.runId,
      status: "running",
      taskId: run.taskId,
    });
    if (!sameOptionalPath(expected, run.workingDirectory))
      throw new Error(
        "Active Agent working directory does not match lifecycle configuration",
      );
  }

  /** Resolves active Resources in the Agent definition's declared order. */
  private async resourcesFor(
    agent: AgentRecord,
  ): Promise<ActiveAgentContext["resources"]> {
    /** Active Resources indexed for Agent-context assembly. */
    const available = await this.provider.listResources();
    /** Active Resources indexed by provider ID. */
    const byId = new Map(available.map((entry) => [entry.id, entry]));
    /** Resources resolved in the Agent definition's declared order. */
    const resources = agent.resourceIds.map((id) => {
      /** Resource currently resolved or validated for Agent context. */
      const resource = byId.get(id);
      if (
        resource === undefined ||
        resource.archived ||
        resource.state !== "active"
      )
        throw new Error(`Agent Resource is unavailable: ${id}`);
      if (resource.kind.trim() === "")
        throw new Error(`Agent Resource Kind is empty: ${resource.key}`);
      if (
        resource.key.startsWith("prompt/") &&
        resource.kind.toLowerCase() !== "prompt"
      )
        throw new Error(
          `Agent Prompt Resource has wrong Kind: ${resource.key}`,
        );
      return resource;
    });
    return resources.map(harnessResource);
  }

  /** Verifies that the Agent may operate on the Task's type and status. */
  private assertTaskEligibility(agent: AgentRecord, task: TaskRecord): void {
    if (!agent.allowedTaskTypes.includes(task.type))
      throw new Error(`Agent is not allowed to use Task type: ${task.type}`);
    if (!agent.allowedStatuses.includes(task.status))
      throw new Error(
        `Agent is not allowed to use Task status: ${task.status}`,
      );
  }

  /** Verifies the Task body sections required by one declared outcome. */
  private assertRequiredOutcomeSections(
    agent: AgentRecord,
    task: TaskRecord,
    outcome: string,
  ): void {
    for (const section of agent.taskDescription.requiredSectionsByOutcome[
      outcome
    ] ?? [])
      if (!taskDescriptionHasSection(task.body, section))
        throw new Error(
          `Agent outcome ${outcome} requires Task description section: ${section}`,
        );
  }

  /** Verifies that an invocation uses the Agent's configured harness identity. */
  private assertCaller(agent: AgentRecord, harnessId: string): void {
    if (agent.calledBy !== "" && agent.calledBy !== harnessId)
      throw new Error("Harness is not allowed to invoke Agent");
  }

  /** Loads a non-archived agent definition by key. */
  private async requiredAgent(key: string): Promise<AgentRecord> {
    /** Agent definition resolved for the current run. */
    const agent = await this.provider.getAgentByKey(key);
    if (agent === null || agent.archived || !agent.enabled)
      throw new Error(`Agent is unavailable: ${key}`);
    return agent;
  }

  /** Returns one available Agent by provider record ID. */
  private async agentById(id: string): Promise<AgentRecord> {
    /** Agent definition resolved for the current run. */
    const agent = await this.provider.getAgent(id);
    if (agent === null || agent.archived)
      throw new Error(`Agent is unavailable: ${id}`);
    return agent;
  }

  /** Rejects mid-run changes to the Agent definition. */
  private assertAgentVersion(run: ActiveAgentRecord, agent: AgentRecord): void {
    if (run.agentVersion !== agent.version)
      throw new Error("Agent definition changed after the run started");
  }

  /** Allows restart only from the current or explicitly compatible version. */
  private assertRestartVersion(
    run: ActiveAgentRecord,
    agent: AgentRecord,
  ): void {
    if (
      run.agentVersion !== agent.version &&
      !(agent.restartCompatibleVersions?.includes(run.agentVersion) ?? false)
    )
      throw new Error("Agent definition changed after the run started");
  }

  /** Loads a running Active Agent owned by the supplied harness. */
  private async runningOwned(
    runId: string,
    harnessId: string,
  ): Promise<ActiveAgentRecord> {
    /** Active Agent loaded for running-state and ownership checks. */
    const run = await this.provider.getActiveAgent(runId);
    if (run === null || run.status !== "running")
      throw new Error("Active Agent is not running");
    if (run.harnessId !== harnessId)
      throw new Error("Harness does not own Active Agent");
    if (run.outcome !== "")
      throw new Error("Active Agent is finalizing an outcome");
    return run;
  }

  /** Returns every run transitively parented by the requested run. */
  private descendants(
    ancestorRunId: string,
    snapshot: readonly ActiveAgentRecord[],
    parents: ReadonlyMap<string, string | null> = this.parentIndex(snapshot),
  ): ActiveAgentRecord[] {
    return snapshot.filter((entry) =>
      this.isDescendant(entry, ancestorRunId, parents),
    );
  }

  /** Indexes the first parent relation for each Run ID in one snapshot. */
  private parentIndex(
    snapshot: readonly ActiveAgentRecord[],
  ): ReadonlyMap<string, string | null> {
    /** Parent relation lookup preserving Array.find's first-match behavior. */
    const parents = new Map<string, string | null>();
    for (const run of snapshot)
      if (!parents.has(run.runId)) parents.set(run.runId, run.parentRunId);
    return parents;
  }

  /** Counts parent links for deterministic deepest-first cleanup. */
  private runDepth(
    run: ActiveAgentRecord,
    parents: ReadonlyMap<string, string | null>,
  ): number {
    /** Number of parent links used for deepest-first cleanup ordering. */
    let depth = 0;
    /** Parent Run ID currently followed toward the root. */
    let parentRunId = run.parentRunId;
    /** Parent IDs already traversed while defending against malformed cycles. */
    const seen = new Set<string>();
    while (parentRunId !== null && !seen.has(parentRunId)) {
      seen.add(parentRunId);
      depth += 1;
      parentRunId = parents.get(parentRunId) ?? null;
    }
    return depth;
  }

  /** Tests transitive ancestry while terminating on missing parents or cycles. */
  private isDescendant(
    candidate: ActiveAgentRecord,
    ancestorRunId: string,
    parents: ReadonlyMap<string, string | null>,
  ): boolean {
    /** Parent run currently being followed toward the root. */
    let parentRunId = candidate.parentRunId;
    /** Identifiers already visited while detecting cycles or repetition. */
    const seen = new Set<string>();
    while (parentRunId !== null) {
      if (parentRunId === ancestorRunId) return true;
      if (seen.has(parentRunId)) return false;
      seen.add(parentRunId);
      parentRunId = parents.get(parentRunId) ?? null;
    }
    return false;
  }
}

/** Builds the exact external execution context from already validated records. */
function harnessContext(
  agent: AgentRecord,
  resources: ActiveAgentContext["resources"],
  run: ActiveAgentRecord,
  task: TaskRecord,
): ActiveAgentContext {
  return {
    agent: harnessAgent(agent),
    resources,
    run,
    systemPrompt: commandProxySystemPrompt(agent.taskDescription),
    task: harnessTask(task),
  };
}

/** Projects an Agent definition onto the fields an execution harness may read. */
function harnessAgent(agent: AgentRecord): ActiveAgentContext["agent"] {
  return {
    allowedStatuses: agent.allowedStatuses,
    allowedTaskTypes: agent.allowedTaskTypes,
    id: agent.id,
    key: agent.key,
    model: agent.model,
    name: agent.name,
    notes: agent.notes,
    reasoning: agent.reasoning,
    taskDescription: agent.taskDescription,
    transitions: agent.transitions,
    version: agent.version,
  };
}

/** Projects a Resource onto its execution-context fields. */
function harnessResource(
  resource: ResourceRecord,
): ActiveAgentContext["resources"][number] {
  return {
    body: resource.body,
    id: resource.id,
    key: resource.key,
    kind: resource.kind,
    state: resource.state,
    version: resource.version,
  };
}

/** Projects a Task onto its execution-context fields. */
function harnessTask(task: TaskRecord): ActiveAgentContext["task"] {
  return {
    body: task.body,
    dependencies: task.dependencies,
    id: task.id,
    priority: task.priority,
    status: task.status,
    title: task.title,
    type: task.type,
    version: task.version,
  };
}

/** Compares nullable paths with host-platform case semantics. */
function sameOptionalPath(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  /** Resolved left path used for platform-aware equality. */
  const normalizedLeft = resolve(left);
  /** Resolved right path used for platform-aware equality. */
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Returns the stable Error key that gates a retry chain after its limit. */
export function retryErrorKey(retryKey: string): string {
  return `active-agent-retry:${retryKey}`;
}

/** Restricts new run identities to one bounded path-safe component. */
function assertNewRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(runId))
    throw new Error("Run ID must be a path-safe identifier");
}
