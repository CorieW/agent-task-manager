/** Compiles one bounded immutable work context from activated provider data. */
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { ActivatedDefinition } from "../core/definition-activation.js";
import {
  finalizeRunContext,
  resourceContext,
  validateRuntimeCapabilityReceipt,
  type RunContext,
  type RuntimeCapabilityReceipt,
} from "./contracts.js";

export async function compileRunContext(input: {
  readonly activated: ActivatedDefinition;
  readonly additionalInput: JsonObject;
  readonly provider: AgentTaskProvider;
  readonly runId: string;
  readonly runtimeReceipt: RuntimeCapabilityReceipt;
  readonly taskId: string;
}): Promise<RunContext> {
  validateRuntimeCapabilityReceipt(input.runtimeReceipt);
  const task = await input.provider.getTaskSnapshot(input.taskId);
  if (task.archived)
    throw new Error("Cannot compile context for an archived Task");
  const resolved = input.activated.resolved;
  const core = {
    activationDigest: input.activated.digest,
    capabilityGrant: input.activated.grant,
    definitionDigest: resolved.digest,
    input: structuredClone(input.additionalInput),
    resourcePins: resolved.resources.map(({ digest, key, version }) => ({
      digest,
      key,
      version,
    })),
    resources: resourceContext(resolved.resources),
    runId: requiredString(input.runId, "Run ID"),
    runtimeReceipt: structuredClone(input.runtimeReceipt),
    schema: "run-context-v1" as const,
    task,
  };
  const bytes = Buffer.byteLength(JSON.stringify(toJsonValue(core)), "utf8");
  if (bytes > resolved.definition.contextBudgetBytes)
    throw new Error(
      "Compiled run context exceeds the Sub-agent context budget",
    );
  return finalizeRunContext(core);
}

function requiredString(value: string, label: string): string {
  if (value === "") throw new TypeError(`${label} is required`);
  return value;
}
