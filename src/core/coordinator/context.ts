/** Pure projections and comparisons used by coordinator operations. */
import { resolve } from "node:path";

import type {
  ActiveAgentContext,
  ActiveAgentRecord,
  AgentRecord,
  ResourceRecord,
  TaskRecord,
} from "../../domain/records.js";
import { commandProxySystemPrompt } from "../agent-system-prompt.js";

/** Builds the exact external execution context from already validated records. */
export function harnessContext(
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
export function harnessResource(
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
export function sameOptionalPath(
  left: string | null,
  right: string | null,
): boolean {
  if (left === null || right === null) return left === right;
  /** Resolved left path used for platform-aware equality. */
  const normalizedLeft = resolve(left);
  /** Resolved right path used for platform-aware equality. */
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
