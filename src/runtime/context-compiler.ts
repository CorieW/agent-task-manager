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

/** Compiles run context into its trusted runtime form. */
export async function compileRunContext(input: {
  /** Provides activated to compile run context. */
  readonly activated: ActivatedDefinition;
  /** Provides additional input to compile run context. */
  readonly additionalInput: JsonObject;
  /** Provider boundary used for durable state reads and writes. */
  readonly provider: AgentTaskProvider;
  /** Stable identifier for run id. */
  readonly runId: string;
  /** Provides runtime receipt to compile run context. */
  readonly runtimeReceipt: RuntimeCapabilityReceipt;
  /** Stable identifier for task id. */
  readonly taskId: string;
}): Promise<RunContext> {
  validateRuntimeCapabilityReceipt(input.runtimeReceipt);
  /** Stores task used by compile run context. */
  const task = await input.provider.getTaskSnapshot(input.taskId);
  if (task.archived)
    throw new Error("Cannot compile context for an archived Task");
  /** Stores resolved used by compile run context. */
  const resolved = input.activated.resolved;
  /** Collects the canonical fields used to compute the record digest. */
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
  /** Combined output size accumulated in bytes. */
  const bytes = Buffer.byteLength(JSON.stringify(toJsonValue(core)), "utf8");
  if (bytes > resolved.definition.contextBudgetBytes)
    throw new Error("Compiled run context exceeds the Agent context budget");
  return finalizeRunContext(core);
}

/** Returns d string or throws when invalid or absent. */
function requiredString(value: string, label: string): string {
  if (value === "") throw new TypeError(`${label} is required`);
  return value;
}
