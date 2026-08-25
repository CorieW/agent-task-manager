/** Shared deterministic records and coordinator setup for lifecycle tests. */
import { AgentCoordinator } from "../../src/core/coordinator.js";
import {
  NO_LIFECYCLE_COMMANDS,
  type AgentLifecycleCommands,
} from "../../src/core/lifecycle-commands.js";
import type {
  AgentRecord,
  ResourceRecord,
  TaskRecord,
} from "../../src/domain/records.js";
import { EMPTY_AGENT_LIFECYCLE } from "../../src/domain/lifecycle.js";
import { EMPTY_AGENT_TASK_DESCRIPTION } from "../../src/domain/task-description.js";
import { InMemoryProvider } from "../../src/provider/in-memory-provider.js";

/** Builds the canonical eligible Task used by coordinator scenarios. */
export function task(): TaskRecord {
  return {
    archived: false,
    body: "Task context",
    dependencies: [],
    id: "task-1",
    priority: 1,
    properties: {},
    status: "Planned",
    title: "Implement",
    type: "Feature",
    version: "1",
  };
}

/** Builds one Resource fixture with configurable kind and lifecycle state. */
export function resource(
  id: string,
  kind = "Prompt",
  state: ResourceRecord["state"] = "active",
): ResourceRecord {
  return {
    archived: false,
    body: `${id} body`,
    id,
    key: id,
    kind,
    properties: {},
    state,
    version: "1",
  };
}

/** Builds the canonical Agent definition used by coordinator scenarios. */
export function agent(): AgentRecord {
  return {
    allowedStatuses: ["Planned", "Blocked", "In review"],
    allowedTaskTypes: ["Feature"],
    archived: false,
    body: "Agent",
    calledBy: "",
    commands: { exclusion: [] },
    enabled: true,
    id: "agent-1",
    key: "coder",
    lifecycleCommands: EMPTY_AGENT_LIFECYCLE,
    model: "gpt",
    name: "Coder",
    notes: "",
    properties: {},
    reasoning: "high",
    resourceIds: ["prompt", "policy"],
    taskDescription: EMPTY_AGENT_TASK_DESCRIPTION,
    transitions: {
      blocked: "Blocked",
      succeeded: "In review",
      unchanged: "$current",
    },
    version: "1",
  };
}

/** Creates a coordinator fixture with deterministic records and clock. */
export function setup(
  now = new Date("2026-08-17T12:00:00.000Z"),
  lifecycle: AgentLifecycleCommands = NO_LIFECYCLE_COMMANDS,
) {
  /** Clock captured by the setup fixture. */
  let clock = now;
  /** Provider implementation that owns persistence for this invocation. */
  const provider = new InMemoryProvider({
    agents: [agent()],
    resources: [resource("prompt"), resource("policy", "Policy")],
    tasks: [task()],
  });
  /** Coordinator captured by the setup fixture. */
  const coordinator = new AgentCoordinator(provider, () => clock, lifecycle);
  return {
    coordinator,
    provider,
    /** Updates clock. */
    setClock(value: Date) {
      clock = value;
    },
  };
}
