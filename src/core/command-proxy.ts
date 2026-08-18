/** Authorizes and executes one Agent command without invoking a shell. */
import { spawn } from "node:child_process";

import { commandIsAllowed, normalizeCommandName } from "../domain/commands.js";
import type { AgentCoordinator } from "./coordinator.js";

/** Harness-owned command request presented to the command proxy. */
export interface ProxyCommandInput {
  readonly arguments: readonly string[];
  readonly command: string;
  readonly harnessId: string;
  readonly runId: string;
}

/** Captured result of a shell-free proxied command. */
export interface ProxyCommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

/** Injectable shell-free execution boundary used by the proxy. */
export type CommandExecutor = (
  command: string,
  arguments_: readonly string[],
) => Promise<ProxyCommandResult>;

/** Verifies run ownership and Agent policy before delegating one command. */
export class CommandProxy {
  /** Creates a proxy with an injectable executor for deterministic tests. */
  public constructor(
    private readonly coordinator: AgentCoordinator,
    private readonly executor: CommandExecutor = executeCommand,
  ) {}

  /** Executes an allowed command for a running, harness-owned Agent. */
  public async execute(input: ProxyCommandInput): Promise<ProxyCommandResult> {
    const command = normalizeCommandName(input.command);
    const policy = await this.coordinator.commandPolicy(
      input.runId,
      input.harnessId,
    );
    if (!commandIsAllowed(policy, command))
      throw new Error(`Agent command is not allowed: ${command}`);
    return this.executor(input.command, input.arguments);
  }
}

/** Spawns one executable directly and captures its output without a shell. */
async function executeCommand(
  command: string,
  arguments_: readonly string[],
): Promise<ProxyCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) =>
      resolve({
        command: normalizeCommandName(command),
        exitCode,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });
}
