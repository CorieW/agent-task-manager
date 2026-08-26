/** Mutex coordination for lifecycle mutations and stale-run sweeps. */
import type { AgentCoordinator, SweepResult } from "../core/coordinator.js";
import type { ActiveAgentRecord } from "../domain/records.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { SingleHostMutex } from "../core/single-host-mutex.js";

/** Serializes a terminal lifecycle mutation against commands in its subtree. */
export async function withRunLeases<T>(
  globalMutex: SingleHostMutex,
  runMutex: (runId: string) => SingleHostMutex,
  provider: AgentTaskProvider,
  roots: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return globalMutex.run(async () => {
    /** Active Agent snapshot used to determine the protected run set. */
    const active = await provider.listActiveAgents();
    /** Sorted run subtree protected by this terminal mutation. */
    const runIds = affectedRunIds(active, roots);
    /** Release callbacks in acquisition order. */
    const releases: Array<() => Promise<void>> = [];
    try {
      for (const runId of runIds) releases.push(await runMutex(runId).lock());
      return await operation();
    } finally {
      await releaseAllInReverse(releases);
    }
  });
}

/** Releases every acquired lease in reverse order before rethrowing the first cleanup failure. */
async function releaseAllInReverse(
  releases: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  /** Whether at least one release has thrown, including a thrown `undefined`. */
  let hasFailure = false;
  /** First cleanup failure in reverse execution order. */
  let firstFailure: unknown;

  for (const release of releases.toReversed()) {
    try {
      await release();
    } catch (error) {
      if (!hasFailure) {
        hasFailure = true;
        firstFailure = error;
      }
    }
  }

  if (hasFailure) throw firstFailure;
}

/** Structured sweep result that reports independently fenced stale subtrees. */
export interface SweepBatchResult {
  /** Stale subtree roots skipped because another command owns a lease. */
  readonly blockedRunIds: readonly string[];
  /** Successfully swept subtree results. */
  readonly swept: readonly SweepResult[];
}

/** Sweeps each planned stale subtree without leasing unrelated healthy runs. */
export async function sweepWithRunLeases(
  globalMutex: SingleHostMutex,
  runMutex: (runId: string) => SingleHostMutex,
  coordinator: AgentCoordinator,
): Promise<SweepBatchResult> {
  return globalMutex.run(async () => {
    /** Independently leasable stale subtrees proposed by the coordinator. */
    const plans = await coordinator.planSweep();
    /** Root IDs skipped because their subtree could not be fully leased. */
    const blockedRunIds: string[] = [];
    /** Results from subtrees swept during this batch. */
    const swept: SweepResult[] = [];
    for (const plan of plans) {
      /** Release callbacks for this subtree in acquisition order. */
      const releases: Array<() => Promise<void>> = [];
      try {
        try {
          for (const runId of plan.runIds)
            releases.push(await runMutex(runId).lock());
        } catch (error) {
          if (!isLockContention(error)) throw error;
          blockedRunIds.push(plan.rootRunId);
          continue;
        }
        swept.push(...(await coordinator.sweep([plan.rootRunId])));
      } finally {
        await releaseAllInReverse(releases);
      }
    }
    return { blockedRunIds, swept };
  });
}

/** Identifies a live or quarantined same-host run lease. */
function isLockContention(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** Returns sorted roots and descendants whose terminal state may be mutated. */
function affectedRunIds(
  active: readonly ActiveAgentRecord[],
  roots: readonly string[],
): readonly string[] {
  /** Growing set seeded with the requested roots. */
  const result = new Set(roots);
  /** Whether the previous traversal discovered another descendant. */
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of active)
      if (
        run.parentRunId !== null &&
        result.has(run.parentRunId) &&
        !result.has(run.runId)
      ) {
        result.add(run.runId);
        changed = true;
      }
  }
  return [...result].sort();
}
