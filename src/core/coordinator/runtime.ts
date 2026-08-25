/** Shared provider-backed mechanics for AgentCoordinator use cases. */
import { taskDescriptionHasSection } from "../../domain/task-description.js";
import type {
  ActiveAgentContext,
  ActiveAgentRecord,
  AgentRecord,
  TaskRecord,
} from "../../domain/records.js";
import type { AgentTaskProvider } from "../../provider/agent-task-provider.js";
import type {
  AgentLifecycleCommands,
  LifecycleCommandContext,
} from "../lifecycle-commands.js";
import {
  harnessContext,
  harnessResource,
  sameOptionalPath,
} from "./context.js";
import { MAX_ATTEMPTS, retryErrorKey } from "./retry.js";

export class CoordinatorRuntime {
  public constructor(
    protected readonly provider: AgentTaskProvider,
    protected readonly now: () => Date,
    protected readonly lifecycle: AgentLifecycleCommands,
  ) {}

  /** Runs cleanup and persists a failed or stale terminal transition. */
  protected async terminate(
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
  protected async reportSkippedCleanup(
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
  protected async context(
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
  protected startLifecycleContext(
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
  protected terminalLifecycleContext(
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
  protected assertWorkingDirectory(
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
  protected async resourcesFor(
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
  protected assertTaskEligibility(agent: AgentRecord, task: TaskRecord): void {
    if (!agent.allowedTaskTypes.includes(task.type))
      throw new Error(`Agent is not allowed to use Task type: ${task.type}`);
    if (!agent.allowedStatuses.includes(task.status))
      throw new Error(
        `Agent is not allowed to use Task status: ${task.status}`,
      );
  }

  /** Verifies the Task body sections required by one declared outcome. */
  protected assertRequiredOutcomeSections(
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
  protected assertCaller(agent: AgentRecord, harnessId: string): void {
    if (agent.calledBy !== "" && agent.calledBy !== harnessId)
      throw new Error("Harness is not allowed to invoke Agent");
  }

  /** Loads a non-archived agent definition by key. */
  protected async requiredAgent(key: string): Promise<AgentRecord> {
    /** Agent definition resolved for the current run. */
    const agent = await this.provider.getAgentByKey(key);
    if (agent === null || agent.archived || !agent.enabled)
      throw new Error(`Agent is unavailable: ${key}`);
    return agent;
  }

  /** Returns one available Agent by provider record ID. */
  protected async agentById(id: string): Promise<AgentRecord> {
    /** Agent definition resolved for the current run. */
    const agent = await this.provider.getAgent(id);
    if (agent === null || agent.archived)
      throw new Error(`Agent is unavailable: ${id}`);
    return agent;
  }

  /** Rejects mid-run changes to the Agent definition. */
  protected assertAgentVersion(
    run: ActiveAgentRecord,
    agent: AgentRecord,
  ): void {
    if (run.agentVersion !== agent.version)
      throw new Error("Agent definition changed after the run started");
  }

  /** Allows restart only from the current or explicitly compatible version. */
  protected assertRestartVersion(
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
  protected async runningOwned(
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
  protected descendants(
    ancestorRunId: string,
    snapshot: readonly ActiveAgentRecord[],
    parents: ReadonlyMap<string, string | null> = this.parentIndex(snapshot),
  ): ActiveAgentRecord[] {
    return snapshot.filter((entry) =>
      this.isDescendant(entry, ancestorRunId, parents),
    );
  }

  /** Indexes the first parent relation for each Run ID in one snapshot. */
  protected parentIndex(
    snapshot: readonly ActiveAgentRecord[],
  ): ReadonlyMap<string, string | null> {
    /** Parent relation lookup preserving Array.find's first-match behavior. */
    const parents = new Map<string, string | null>();
    for (const run of snapshot)
      if (!parents.has(run.runId)) parents.set(run.runId, run.parentRunId);
    return parents;
  }

  /** Counts parent links for deterministic deepest-first cleanup. */
  protected runDepth(
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
  protected isDescendant(
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
