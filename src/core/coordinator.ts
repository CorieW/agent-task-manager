/** Coordinates owned Agent runs, hierarchy, completion, failure, and retries. */
import { resolve } from "node:path";

import type {
  ActiveAgentContext,
  ActiveAgentRecord,
  AgentRecord,
  ReportErrorInput,
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
      /** Agent definition resolved for the current run. */
      const agent = await this.requiredAgent(input.agentKey);
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
    /** Agent definition resolved for the current run. */
    const agent = await this.requiredAgent(input.agentKey);
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
    }
    /** Resources resolved in the Agent definition's declared order. */
    const resources = await this.resourcesFor(agent);
    /** Trusted lifecycle executor and context for the run. */
    const lifecycle = this.startLifecycleContext(agent, input);
    await this.lifecycle.before(agent.lifecycleCommands, lifecycle);
    /** Single ISO timestamp shared by the new run fields. */
    const startedAt = this.now().toISOString();
    /** Active Agent record loaded or created for the operation. */
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
    return {
      agent,
      resources,
      run,
      systemPrompt: commandProxySystemPrompt(agent.taskDescription),
      task,
    };
  }

  /** Records a heartbeat after verifying the run is running and harness-owned. */
  public async heartbeat(
    runId: string,
    harnessId: string,
  ): Promise<ActiveAgentRecord> {
    /** Active Agent record loaded or created for the operation. */
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
    /** Active Agent record loaded or created for the operation. */
    const run = await this.runningOwned(runId, harnessId);
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
    this.assertTaskEligibility(agent, task);
    if (!Object.hasOwn(agent.transitions, outcome))
      throw new Error(`Agent does not declare outcome: ${outcome}`);
    for (const section of agent.taskDescription.requiredSectionsByOutcome[
      outcome
    ] ?? [])
      if (!taskDescriptionHasSection(task.body, section))
        throw new Error(
          `Agent outcome ${outcome} requires Task description section: ${section}`,
        );
    await this.lifecycle.after(
      agent.lifecycleCommands,
      this.terminalLifecycleContext(run, agent.key, "completed", outcome, ""),
    );
    /** Destination Task status or related Notion table selected by the operation. */
    const target = agent.transitions[outcome]!;
    if (target !== "$current")
      await this.provider.setTaskStatus(run.taskId, target);
    /** Completed run record returned after archival. */
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
    /** Active Agent record loaded or created for the operation. */
    const run = await this.runningOwned(runId, harnessId);
    return this.terminate(run, "failed", summary);
  }

  /** Plans independently leaseable stale subtrees from one provider snapshot. */
  public async planSweep(): Promise<readonly SweepPlan[]> {
    /** Running snapshot and outermost stale roots derived from it. */
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
    /** Outermost stale roots selected from the running snapshot. */
    const { roots } = await this.sweepState();
    /** Notion select or date value after shape validation. */
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
    /** Outermost stale roots selected from the running snapshot. */
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
    /** Failed or stale attempt selected for restart. */
    const restartSource = await this.provider.getActiveAgent(
      input.restartOfRunId,
    );
    if (
      restartSource === null ||
      (restartSource.status !== "failed" && restartSource.status !== "stale")
    )
      throw new Error("Only a failed or stale Active Agent can restart");
    /** One-based attempt number within the retry chain. */
    let attempt = restartSource.attempt + 1;
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
    /** Active Agent record loaded or created for the operation. */
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
    return {
      agent,
      resources,
      run,
      systemPrompt: commandProxySystemPrompt(agent.taskDescription),
      task,
    };
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
    /** Active Agent record loaded or created for the operation. */
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
    /** Active Agent record loaded or created for the operation. */
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

  /** Transitions agent coordinator. */
  private async terminate(
    run: ActiveAgentRecord,
    status: "failed" | "stale",
    summary: string,
  ): Promise<ActiveAgentRecord> {
    /** Provider snapshot used for stable hierarchy traversal. */
    const all = await this.provider.listActiveAgents();
    for (const child of this.descendants(run.runId, all).filter(
      (entry) => entry.status === "running",
    )) {
      /** Terminal failure explanation recorded for the run. */
      const failureSummary = `Stopped because ancestor ${run.runId} ${status}`;
      /** Agent definition governing the descendant's cleanup hooks. */
      const childAgent = await this.provider.getAgent(child.agentId);
      if (childAgent !== null) {
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
    }
    /** Agent definition resolved for the current run. */
    const agent = await this.provider.getAgent(run.agentId);
    if (agent !== null) {
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
    return {
      agent,
      resources,
      run,
      systemPrompt: commandProxySystemPrompt(agent.taskDescription),
      task,
    };
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
    /** Lookup used by resources for. */
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

  /** Verifies that the Agent may operate on the Task's type and status. */
  private assertTaskEligibility(agent: AgentRecord, task: TaskRecord): void {
    if (!agent.allowedTaskTypes.includes(task.type))
      throw new Error(`Agent is not allowed to use Task type: ${task.type}`);
    if (!agent.allowedStatuses.includes(task.status))
      throw new Error(
        `Agent is not allowed to use Task status: ${task.status}`,
      );
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
    /** Active Agent record loaded or created for the operation. */
    const run = await this.provider.getActiveAgent(runId);
    if (run === null || run.status !== "running")
      throw new Error("Active Agent is not running");
    if (run.harnessId !== harnessId)
      throw new Error("Harness does not own Active Agent");
    return run;
  }
  /** Returns every run transitively parented by the requested run. */
  private descendants(
    runId: string,
    values: readonly ActiveAgentRecord[],
  ): ActiveAgentRecord[] {
    return values.filter((entry) => this.isDescendant(entry, runId, values));
  }
  /** Reports whether descendant. */
  private isDescendant(
    candidate: ActiveAgentRecord,
    runId: string,
    values: readonly ActiveAgentRecord[],
  ): boolean {
    /** Parent run currently being followed toward the root. */
    let parent = candidate.parentRunId;
    /** Identifiers already visited while detecting cycles or repetition. */
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
