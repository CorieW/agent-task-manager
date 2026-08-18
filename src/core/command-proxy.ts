/** Authorizes Agent commands and delegates execution to a sandboxed broker. */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { commandIsAllowed, normalizeCommandName } from "../domain/commands.js";
import type { AgentCommandPolicy } from "../domain/commands.js";
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

/** Versioned, fully authorized request sent to the sandbox broker. */
export interface BrokerCommandRequest {
  readonly arguments: readonly string[];
  readonly command: string;
  readonly commands: AgentCommandPolicy;
  readonly runId: string;
  readonly schema: "agent-command-broker-request-v1";
}

/** Sandboxed execution boundary supplied by the trusted host. */
export type CommandExecutor = (
  request: BrokerCommandRequest,
) => Promise<ProxyCommandResult>;

/** Exclusive-operation boundary shared with lifecycle mutations. */
export interface CommandMutex {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/** Verifies run ownership and Agent policy before delegating one command. */
export class CommandProxy {
  /** Creates a proxy with a host-supplied, process-tree-contained executor. */
  public constructor(
    private readonly coordinator: AgentCoordinator,
    private readonly executor: CommandExecutor,
    private readonly mutex: CommandMutex,
  ) {}

  /** Executes an allowed command for a running, harness-owned Agent. */
  public async execute(input: ProxyCommandInput): Promise<ProxyCommandResult> {
    return this.mutex.run(async () => {
      const command = normalizeCommandName(input.command);
      const policy = await this.coordinator.commandPolicy(
        input.runId,
        input.harnessId,
      );
      if (!commandIsAllowed(policy, command))
        throw new Error(`Agent command is not allowed: ${command}`);
      return this.executor({
        arguments: [...input.arguments],
        command,
        commands: policy,
        runId: input.runId,
        schema: "agent-command-broker-request-v1",
      });
    });
  }
}

/** Creates an executor backed by a host-owned sandbox broker protocol. */
export function createCommandBrokerExecutor(
  brokerExecutable: string,
  brokerArguments: readonly string[] = [],
): CommandExecutor {
  if (!isAbsolute(brokerExecutable))
    throw new TypeError("Command broker executable must be an absolute path");
  return async (request) =>
    new Promise((resolve, reject) => {
      const child = spawn(brokerExecutable, brokerArguments, {
        env: commandEnvironment(process.env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        if (exitCode !== 0 || signal !== null) {
          reject(
            new Error(
              `Command broker failed (${signal ?? String(exitCode)}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
          );
          return;
        }
        try {
          resolve(
            parseBrokerResult(
              Buffer.concat(stdout).toString("utf8"),
              request.command,
            ),
          );
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
    });
}

/** Validates the single JSON result emitted by the command broker. */
function parseBrokerResult(
  value: string,
  expectedCommand: string,
): ProxyCommandResult {
  const result: unknown = JSON.parse(value);
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new TypeError("Command broker result must be an object");
  const record = result as Record<string, unknown>;
  const keys = ["command", "exitCode", "signal", "stderr", "stdout"];
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in record)) ||
    record.command !== expectedCommand ||
    (record.exitCode !== null && typeof record.exitCode !== "number") ||
    (record.signal !== null && typeof record.signal !== "string") ||
    typeof record.stderr !== "string" ||
    typeof record.stdout !== "string"
  )
    throw new TypeError("Command broker returned an invalid result");
  return record as unknown as ProxyCommandResult;
}

/** Copies only non-secret variables required for process lookup and runtime basics. */
function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WINDIR",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}
