import type { JsonValue } from "../domain/json.js";
import type {
  WorkspaceMigrationPlan,
  WorkspaceMigrationPlanCore,
} from "../domain/schema.js";
import { digestJson } from "./digest.js";

function asJson(value: WorkspaceMigrationPlanCore): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function finalizeMigrationPlan(
  core: WorkspaceMigrationPlanCore,
): WorkspaceMigrationPlan {
  return { ...core, digest: digestJson(asJson(core)) };
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
