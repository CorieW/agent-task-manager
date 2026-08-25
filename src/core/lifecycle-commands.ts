/** Runs trusted, Agent-configured commands at lifecycle boundaries. */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

import type {
  AgentLifecycleConfig,
  LifecycleCommandConfig,
} from "../domain/lifecycle.js";
import type { ActiveAgentStatus } from "../domain/records.js";
import { processLookupEnvironment } from "./process-environment.js";

/** Stable values available to lifecycle command templates and environments. */
export interface LifecycleCommandContext {
  /** Stable Agent-definition key used for lookup. */
  readonly agentKey: string;
  /** Terminal failure explanation recorded for the run. */
  readonly failureSummary: string;
  /** Identity of the harness that owns the run. */
  readonly harnessId: string;
  /** Agent-declared terminal outcome. */
  readonly outcome: string;
  /** Run ID of the parent run, or null for a root. */
  readonly parentRunId: string | null;
  /** Harness-supplied idempotency identity of the run attempt. */
  readonly runId: string;
  /** Current lifecycle status of the record or process. */
  readonly status: ActiveAgentStatus;
  /** Provider record ID of the assigned Task. */
  readonly taskId: string;
  /** Absolute execution directory, or null for the host default. */
  readonly workingDirectory: string | null;
}

/** Fully rendered shell-free command passed to a trusted host executor. */
export interface LifecycleCommandInvocation {
  /** Literal arguments passed to the configured executable. */
  readonly arguments: readonly string[];
  /** Explicit environment variables supplied to the executable. */
  readonly environment: NodeJS.ProcessEnv;
  /** Path or normalized name of the executable to run. */
  readonly executable: string;
  /** Maximum execution or request duration in milliseconds. */
  readonly timeoutMilliseconds: number;
  /** Absolute execution directory, or null for the host default. */
  readonly workingDirectory: string | null;
}

/** Injectable boundary used to execute one trusted lifecycle command. */
export type LifecycleCommandExecutor = (
  invocation: LifecycleCommandInvocation,
) => Promise<void>;

/** Lifecycle capabilities consumed by the provider-neutral coordinator. */
export interface AgentLifecycleCommands {
  /** Runs configured post-Agent lifecycle commands in declaration order. */
  after(
    config: AgentLifecycleConfig,
    context: LifecycleCommandContext,
  ): Promise<void>;
  /** Runs configured pre-Agent lifecycle commands in declaration order. */
  before(
    config: AgentLifecycleConfig,
    context: LifecycleCommandContext,
  ): Promise<void>;
  /** Resolves the configured absolute working directory for a run. */
  workingDirectory(
    config: AgentLifecycleConfig,
    context: Omit<LifecycleCommandContext, "workingDirectory">,
  ): string | null;
}

/** No-op lifecycle commands for programmatic hosts without environment hooks. */
export const NO_LIFECYCLE_COMMANDS: AgentLifecycleCommands = {
  /** Runs configured post-Agent lifecycle commands in declaration order. */
  async after(config) {
    assertEmptyLifecycle(config);
  },
  /** Runs configured pre-Agent lifecycle commands in declaration order. */
  async before(config) {
    assertEmptyLifecycle(config);
  },
  /** Resolves the configured absolute working directory for a run. */
  workingDirectory(config) {
    assertEmptyLifecycle(config);
    return null;
  },
};

/** Renders and runs ordered lifecycle commands from trusted configuration. */
export class ConfiguredLifecycleCommands implements AgentLifecycleCommands {
  /** Creates a renderer bound to one environment and host executor. */
  public constructor(
    private readonly environmentId: string,
    private readonly hostEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly execute: LifecycleCommandExecutor = executeCommand,
  ) {}

  /** Resolves the optional per-Agent execution directory template. */
  public workingDirectory(
    config: AgentLifecycleConfig,
    context: Omit<LifecycleCommandContext, "workingDirectory">,
  ): string | null {
    /** Configured working-directory template for the Agent. */
    const template = config.workingDirectory;
    if (template === null) return null;
    /** Rendered absolute working directory for the run. */
    const value = render(
      template,
      {
        ...context,
        workingDirectory: null,
      },
      this.environmentId,
    );
    if (!isAbsolute(value))
      throw new Error(
        `Lifecycle working directory did not render as an absolute path for Agent: ${context.agentKey}`,
      );
    return value;
  }

  /** Runs matching before-Agent commands in configured order. */
  public async before(
    config: AgentLifecycleConfig,
    context: LifecycleCommandContext,
  ): Promise<void> {
    await this.run("beforeAgent", config.beforeAgent, context);
  }

  /** Runs matching after-Agent commands in configured order. */
  public async after(
    config: AgentLifecycleConfig,
    context: LifecycleCommandContext,
  ): Promise<void> {
    await this.run("afterAgent", config.afterAgent, context);
  }

  /** Executes configured lifecycle commands. */
  private async run(
    phase: "afterAgent" | "beforeAgent",
    commands: readonly LifecycleCommandConfig[],
    context: LifecycleCommandContext,
  ): Promise<void> {
    for (const [index, command] of commands.entries()) {
      /** Path or normalized name of the executable to run. */
      const executable = render(
        command.executable,
        context,
        this.environmentId,
      );
      /** Absolute execution directory, or null for the host default. */
      const workingDirectory =
        command.workingDirectory === null
          ? null
          : render(command.workingDirectory, context, this.environmentId);
      if (executable.trim() === "")
        throw new Error(
          `Lifecycle ${phase} command ${index + 1} rendered an empty executable`,
        );
      if (workingDirectory !== null && !isAbsolute(workingDirectory))
        throw new Error(
          `Lifecycle ${phase} command ${index + 1} working directory is not absolute`,
        );
      try {
        await this.execute({
          arguments: command.arguments.map((argument) =>
            render(argument, context, this.environmentId),
          ),
          environment: {
            ...processLookupEnvironment(this.hostEnvironment),
            ...Object.fromEntries(
              command.inheritEnvironment.flatMap((key) => {
                /** Explicitly inherited host value, when defined. */
                const value = this.hostEnvironment[key];
                return value === undefined ? [] : [[key, value]];
              }),
            ),
            ...Object.fromEntries(
              Object.entries(command.environment).map(([key, value]) => [
                key,
                render(value, context, this.environmentId),
              ]),
            ),
            ...contextEnvironment(context, this.environmentId, phase),
          },
          executable,
          timeoutMilliseconds: command.timeoutMilliseconds,
          workingDirectory,
        });
      } catch (error) {
        throw new Error(
          `Lifecycle ${phase} command ${index + 1} failed for run ${context.runId}`,
          { cause: error },
        );
      }
    }
  }
}

/** Enforces that disabled lifecycle execution receives an empty policy. */
function assertEmptyLifecycle(config: AgentLifecycleConfig): void {
  if (
    config.workingDirectory !== null ||
    config.beforeAgent.length !== 0 ||
    config.afterAgent.length !== 0
  )
    throw new Error(
      "Agent lifecycle configuration requires a host lifecycle executor",
    );
}

/** Expands validated lifecycle placeholders from the run context. */
function render(
  template: string,
  context: LifecycleCommandContext,
  environmentId: string,
): string {
  /** Placeholder values available to the template renderer. */
  const values: Readonly<Record<string, string>> = {
    agentKey: context.agentKey,
    environmentId,
    failureSummary: context.failureSummary,
    harnessId: context.harnessId,
    outcome: context.outcome,
    parentRunId: context.parentRunId ?? "",
    runId: context.runId,
    status: context.status,
    taskId: context.taskId,
    workingDirectory: context.workingDirectory ?? "",
  };
  return Object.entries(values).reduce(
    (value, [key, replacement]) => value.replaceAll(`{{${key}}}`, replacement),
    template,
  );
}

/** Builds immutable run context variables for lifecycle commands. */
function contextEnvironment(
  context: LifecycleCommandContext,
  environmentId: string,
  phase: "afterAgent" | "beforeAgent",
): NodeJS.ProcessEnv {
  return {
    AGENT_TASK_MANAGER_AGENT_KEY: context.agentKey,
    AGENT_TASK_MANAGER_ENVIRONMENT_ID: environmentId,
    AGENT_TASK_MANAGER_FAILURE_SUMMARY: context.failureSummary,
    AGENT_TASK_MANAGER_HARNESS_ID: context.harnessId,
    AGENT_TASK_MANAGER_LIFECYCLE_PHASE: phase,
    AGENT_TASK_MANAGER_OUTCOME: context.outcome,
    AGENT_TASK_MANAGER_PARENT_RUN_ID: context.parentRunId ?? "",
    AGENT_TASK_MANAGER_RUN_ID: context.runId,
    AGENT_TASK_MANAGER_STATUS: context.status,
    AGENT_TASK_MANAGER_TASK_ID: context.taskId,
    AGENT_TASK_MANAGER_WORKING_DIRECTORY: context.workingDirectory ?? "",
  };
}

/** Executes one lifecycle command without a shell. */
function executeCommand(invocation: LifecycleCommandInvocation): Promise<void> {
  return new Promise((resolveCommand, reject) => {
    execFile(
      invocation.executable,
      [...invocation.arguments],
      {
        cwd: invocation.workingDirectory ?? undefined,
        encoding: "utf8",
        env: invocation.environment,
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: invocation.timeoutMilliseconds,
        windowsHide: true,
      },
      (error) => {
        if (error === null) resolveCommand();
        else reject(error);
      },
    );
  });
}
