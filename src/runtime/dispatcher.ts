// Launches one activated Sub-agent through verified control-plane and tool boundaries.
import { digestJson } from "../core/digest.js";
import { toJsonValue, type JsonObject } from "../domain/json.js";
import type { AgentTaskProvider } from "../provider/agent-task-provider.js";
import type { ActivatedDefinition } from "../core/definition-activation.js";
import { compileRunContext } from "./context-compiler.js";
import { parseAgentResult, type AgentResult, type RuntimeCapabilityReceipt } from "./contracts.js";
import type { AgentRunnerAdapter, ModelTransportAdapter, ToolIsolationAdapter, ToolIsolationPolicy } from "./adapters.js";
import { superviseProcess, type ProcessTelemetry } from "./process-supervisor.js";

export interface DispatchResult {
  readonly contextDigest: string;
  readonly result: AgentResult;
  readonly telemetry: ProcessTelemetry;
}

export async function dispatchActivatedAgent(input: {
  readonly activated: ActivatedDefinition;
  readonly additionalInput: JsonObject;
  readonly graceMilliseconds?: number;
  readonly modelTransport: ModelTransportAdapter;
  readonly outputLimitBytes: number;
  readonly provider: AgentTaskProvider;
  readonly runId: string;
  readonly runner: AgentRunnerAdapter;
  readonly taskId: string;
  readonly toolIsolation: ToolIsolationAdapter;
  readonly toolPolicy: ToolIsolationPolicy;
}): Promise<DispatchResult> {
  const definition = input.activated.resolved.definition;
  try {
    if (input.toolPolicy.runId !== input.runId) throw new Error("Tool isolation policy belongs to a different run");
    validateToolIsolationPolicy(input.toolPolicy);
    const [runnerIdentity, controlPlane, isolation] = await Promise.all([
      input.runner.identity(),
      input.modelTransport.prepare({ model: definition.model, reasoning: definition.reasoning, runId: input.runId }),
      input.toolIsolation.prepare(input.toolPolicy),
    ]);
    if (runnerIdentity.id !== input.runner.id) throw new Error("Agent runner identity does not match its registered adapter");
    if (!runnerIdentity.supportedProfiles.includes(definition.runnerProfile)) throw new Error(`Agent runner does not support profile ${definition.runnerProfile}`);
    if (controlPlane.receipt.model !== definition.model || controlPlane.receipt.reasoning !== definition.reasoning) throw new Error("Model transport receipt does not match the definition");
    const runtimeReceipt: RuntimeCapabilityReceipt = {
      controlPlaneSeparated: true,
      credentialExposedToTools: false,
      executableDigest: runnerIdentity.executableDigest,
      executableVersion: runnerIdentity.executableVersion,
      filesystemPolicyDigest: isolation.receipt.filesystemPolicyDigest,
      isolationAdapterId: input.toolIsolation.id,
      model: definition.model,
      modelTransportDigest: controlPlane.receipt.digest,
      modelTransportAdapterId: input.modelTransport.id,
      networkPolicyDigest: isolation.receipt.networkPolicyDigest,
      reasoning: definition.reasoning,
      runnerProfile: definition.runnerProfile,
      runnerAdapterId: input.runner.id,
      schema: "runtime-capability-receipt-v1",
      toolEnvironmentDigest: isolation.receipt.environmentDigest,
      toolProcessTreeEnforced: true,
    };
    const context = await compileRunContext({
      activated: input.activated, additionalInput: input.additionalInput, provider: input.provider,
      runId: input.runId, runtimeReceipt, taskId: input.taskId,
    });
    const outputResource = input.activated.resolved.resources.find((resource) => resource.key === definition.outputSchema);
    if (outputResource === undefined) throw new Error("Output schema Resource is absent from the resolved definition");
    const outputSchema = jsonObject(JSON.parse(outputResource.body), "Output schema");
    let lastError: unknown;
    for (let attempt = 1; attempt <= definition.retry.maxAttempts; attempt += 1) {
      try {
        const process = await input.runner.start({
          context, controlPlaneHandle: controlPlane.opaqueHandle, outputLimitBytes: input.outputLimitBytes,
          outputSchema, toolIsolationHandle: isolation.opaqueHandle,
        });
        const supervised = await superviseProcess({
          deadlineMilliseconds: definition.deadlineSeconds * 1000,
          graceMilliseconds: input.graceMilliseconds ?? 5_000,
          outputLimitBytes: input.outputLimitBytes,
          process,
        });
        if (supervised.telemetry.toolViolation !== null) throw new Error(`Unauthorized tool operation: ${supervised.telemetry.toolViolation}`);
        if (supervised.telemetry.timedOut) throw new Error("Agent process exceeded its deadline");
        if (supervised.completion.exitCode !== 0) throw new Error(`Agent process exited with code ${supervised.completion.exitCode ?? "unknown"}`);
        const result = parseAgentResult({ allowedIntents: definition.allowedIntents, context, outputSchema, raw: supervised.completion.stdout });
        return { contextDigest: context.digest, result, telemetry: supervised.telemetry };
      } catch (error) {
        lastError = error;
        if (definition.retry.noVerdict !== "retry" || attempt === definition.retry.maxAttempts) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Agent execution failed without a result");
  } catch (error) {
    await recordRuntimeError(input, error);
    throw error;
  }
}

async function recordRuntimeError(input: {
  readonly activated: ActivatedDefinition;
  readonly provider: AgentTaskProvider;
  readonly runId: string;
  readonly taskId: string;
}, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const definition = input.activated.resolved.definition;
  const basis = { definitionDigest: input.activated.resolved.digest, message, runId: input.runId, taskId: input.taskId };
  const operationDigest = digestJson(toJsonValue(basis));
  await input.provider.createOrUpdateError({
    description: `Sub-agent runtime failed closed: ${message}`,
    errorKey: `agent-runtime:${input.runId}`,
    idempotencyKey: `agent-runtime:${operationDigest}`,
    relatedRunId: input.runId,
    relatedSubAgentId: definition.id,
    relatedTaskId: input.taskId,
    resolution: "Inspect the runtime capability receipts and process telemetry. Correct the adapter, policy, or agent output, then start a new verified attempt.",
    severity: "high",
    title: "Sub-agent runtime failure",
  });
}

function jsonObject(value: unknown, label: string): JsonObject {
  const json = toJsonValue(value);
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new TypeError(`${label} must be an object`);
  return json;
}

function validateToolIsolationPolicy(policy: ToolIsolationPolicy): void {
  for (const [label, values] of [["allowedEnvironmentNames", policy.allowedEnvironmentNames], ["allowedReadRoots", policy.allowedReadRoots], ["allowedWriteRoots", policy.allowedWriteRoots]] as const) {
    if (new Set(values).size !== values.length || values.some((value) => value === "")) throw new TypeError(`Tool policy ${label} must contain unique non-empty values`);
  }
  const secretName = /(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu;
  if (policy.allowedEnvironmentNames.some((name) => secretName.test(name))) throw new Error("Tool policy cannot expose secret-shaped environment variables");
  for (const root of [...policy.allowedReadRoots, ...policy.allowedWriteRoots]) {
    if (!/^(?:[A-Za-z]:[\\/]|\/)/u.test(root)) throw new TypeError(`Tool policy root must be absolute: ${root}`);
  }
  if (policy.network.mode === "none" && policy.network.allowedOrigins.length !== 0) throw new Error("Network-none policy cannot list allowed origins");
  if (policy.network.mode === "allowlist" && policy.network.allowedOrigins.length === 0) throw new Error("Network allowlist policy requires at least one origin");
  for (const origin of policy.network.allowedOrigins) {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new TypeError(`Tool policy origin is invalid: ${origin}`);
    }
  }
}
