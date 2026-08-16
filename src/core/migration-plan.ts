/** Finalizes digest-bound workspace migration plans and verifies explicit human authorization before apply. */
import { toJsonValue } from "../domain/json.js";
import type {
  WorkspaceMigrationPlan,
  WorkspaceMigrationPlanCore,
} from "../domain/schema.js";
import { digestJson } from "./digest.js";

/** Attaches a canonical digest to a workspace migration plan. */
export function finalizeMigrationPlan(
  core: WorkspaceMigrationPlanCore,
): WorkspaceMigrationPlan {
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

/** Rejects a migration plan whose canonical digest is not explicitly authorized. */
export function assertAuthorizedPlan(
  plan: WorkspaceMigrationPlan,
  expectedDigest: string,
): void {
  /** Digest and core used during assert authorized plan. */
  const { digest: _digest, ...core } = plan;
  /** Recomputed used during assert authorized plan. */
  const recomputed = finalizeMigrationPlan(core).digest;
  if (recomputed !== plan.digest || plan.digest !== expectedDigest) {
    throw new Error(
      "Workspace migration plan digest does not match authorization",
    );
  }
}
