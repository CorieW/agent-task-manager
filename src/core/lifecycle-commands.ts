/** Runs trusted, environment-configured commands at Agent lifecycle boundaries. */
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

import type {
  LifecycleCommandConfig,
  LifecycleCommandsConfig,
} from "../config/environment.js";
import type { ActiveAgentStatus } from "../domain/records.js";

/** Stable values available to lifecycle command templates and environments. */
export interface LifecycleCommandContext {
  readonly agentKey: string;
  readonly failureSummary: string;
  readonly harnessId: string;
  readonly outcome: string;
  readonly parentRunId: string | null;
  readonly runId: string;
  readonly status: ActiveAgentStatus;
  readonly taskId: string;
  readonly workingDirectory: string | null;
}

/** Fully rendered shell-free command passed to a trusted host executor. */
export interface LifecycleCommandInvocation {
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly timeoutMilliseconds: number;
  readonly workingDirectory: string | null;
}

/** Injectable boundary used to execute one trusted lifecycle command. */
export type LifecycleCommandExecutor = (
  invocation: LifecycleCommandInvocation,
) => Promise<void>;

/** Lifecycle capabilities consumed by the provider-neutral coordinator. */
export interface AgentLifecycleCommands {
  after(context: LifecycleCommandContext): Promise<void>;
  before(context: LifecycleCommandContext): Promise<void>;
  workingDirectory(
    agentKey: string,
    context: Omit<LifecycleCommandContext, "workingDirectory">,
  ): string | null;
}

/** No-op lifecycle commands for programmatic hosts without environment hooks. */
export const NO_LIFECYCLE_COMMANDS: AgentLifecycleCommands = {
  async after() {},
  async before() {},
  workingDirectory() {
    return null;
  },
};

/** Renders and runs ordered lifecycle commands from trusted configuration. */
export class ConfiguredLifecycleCommands implements AgentLifecycleCommands {
  public constructor(
    private readonly environmentId: string,
    private readonly config: LifecycleCommandsConfig,
    private readonly hostEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly execute: LifecycleCommandExecutor = executeCommand,
  ) {}

  /** Resolves the optional per-Agent execution directory template. */
  public workingDirectory(
    agentKey: string,
    context: Omit<LifecycleCommandContext, "workingDirectory">,
  ): string | null {
    if (!Object.hasOwn(this.config.workingDirectories, agentKey)) return null;
    const template = this.config.workingDirectories[agentKey];
    if (template === undefined) return null;
    const value = render(
      template,
      {
        ...context,
        agentKey,
        workingDirectory: null,
      },
      this.environmentId,
    );
    if (!isAbsolute(value))
      throw new Error(
        `Lifecycle working directory did not render as an absolute path for Agent: ${agentKey}`,
      );
    return value;
  }

  /** Runs matching before-Agent commands in configured order. */
  public async before(context: LifecycleCommandContext): Promise<void> {
    await this.run("beforeAgent", this.config.beforeAgent, context);
  }

  /** Runs matching after-Agent commands in configured order. */
  public async after(context: LifecycleCommandContext): Promise<void> {
    await this.run("afterAgent", this.config.afterAgent, context);
  }

  private async run(
    phase: "afterAgent" | "beforeAgent",
    commands: readonly LifecycleCommandConfig[],
    context: LifecycleCommandContext,
  ): Promise<void> {
    for (const [index, command] of commands.entries()) {
      if (
        command.agentKeys !== null &&
        !command.agentKeys.includes(context.agentKey)
      )
        continue;
      const executable = render(
        command.executable,
        context,
        this.environmentId,
      );
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
            ...runtimeEnvironment(this.hostEnvironment),
            ...Object.fromEntries(
              command.inheritEnvironment.flatMap((key) => {
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

function runtimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function render(
  template: string,
  context: LifecycleCommandContext,
  environmentId: string,
): string {
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
