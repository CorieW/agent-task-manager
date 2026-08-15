import { toJsonValue } from "../domain/json.js";
import type {
  WorkspaceMigrationPlan,
  WorkspaceMigrationPlanCore,
} from "../domain/schema.js";
import { digestJson } from "./digest.js";

export function finalizeMigrationPlan(
  core: WorkspaceMigrationPlanCore,
): WorkspaceMigrationPlan {
  return { ...core, digest: digestJson(toJsonValue(core)) };
}

export function assertAuthorizedPlan(
  plan: WorkspaceMigrationPlan,
  expectedDigest: string,
): void {
  const { digest: _digest, ...core } = plan;
  const recomputed = finalizeMigrationPlan(core).digest;
  if (recomputed !== plan.digest || plan.digest !== expectedDigest) {
    throw new Error("Workspace migration plan digest does not match authorization");
  }
}
