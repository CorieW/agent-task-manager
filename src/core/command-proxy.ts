/** Authorizes Agent commands and delegates execution to a sandboxed broker. */
import { spawn } from "node:child_process";
import { constants as operatingSystemConstants } from "node:os";
import { isAbsolute } from "node:path";

import { commandIsAllowed, normalizeCommandName } from "../domain/commands.js";
import type { AgentCommandPolicy } from "../domain/commands.js";
import type { AgentCoordinator } from "./coordinator.js";
import { processLookupEnvironment } from "./process-environment.js";

/** Harness-owned command request presented to the command proxy. */
export interface ProxyCommandInput {
  /** Literal arguments passed to the configured executable. */
  readonly arguments: readonly string[];
  /** Normalized executable name authorized for the run. */
  readonly command: string;
  /** Identity of the harness that owns the run. */
  readonly harnessId: string;
  /** Harness-supplied idempotency identity of the run attempt. */
  readonly runId: string;
}

/** Captured result of a shell-free proxied command. */
export interface ProxyCommandResult {
  /** Normalized executable name authorized for the run. */
  readonly command: string;
  /** Numeric process exit code, or null when terminated by a signal. */
  readonly exitCode: number | null;
  /** Termination signal or request cancellation signal, when present. */
  readonly signal: NodeJS.Signals | null;
  /** Captured standard-error output from the brokered command. */
  readonly stderr: string;
  /** Captured standard-output text from the brokered command. */
  readonly stdout: string;
}

/** Manager-side safety bounds for one broker protocol exchange. */
export interface CommandBrokerOptions {
  /** Explicit environment variables supplied to the executable. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Maximum combined broker output accepted in bytes. */
  readonly maxOutputBytes?: number;
  /** Grace period in milliseconds before shutdown is considered unconfirmed. */
  readonly terminationGraceMilliseconds?: number;
  /** Maximum execution or request duration in milliseconds. */
  readonly timeoutMilliseconds?: number;
}

/** Versioned, fully authorized request sent to the sandbox broker. */
export interface BrokerCommandRequest {
  /** Literal arguments passed to the configured executable. */
  readonly arguments: readonly string[];
  /** Normalized executable name authorized for the run. */
  readonly command: string;
  /** Agent command inclusion or exclusion policy. */
  readonly commands: AgentCommandPolicy;
  /** Harness-supplied idempotency identity of the run attempt. */
  readonly runId: string;
  /** Versioned schema identifier for the serialized object. */
  readonly schema: "agent-command-broker-request-v1";
  /** Absolute execution directory, or null for the host default. */
  readonly workingDirectory: string | null;
}

/** Sandboxed execution boundary supplied by the trusted host. */
export type CommandExecutor = (
  request: BrokerCommandRequest,
) => Promise<ProxyCommandResult>;

/** Signals that broker containment could not be proven empty. */
export class ContainmentShutdownUnconfirmedError extends Error {
  /** Creates a fail-closed shutdown error while retaining the run fence. */
  public constructor(message: string) {
    super(message);
    this.name = "ContainmentShutdownUnconfirmedError";
  }
}

/** Two-phase gate that registers a run lease before broker execution. */
export interface CommandExecutionGate {
  /** Authorizes under the global mutex, then executes under the run lease. */
  execute<T>(
    runId: string,
    authorize: () => Promise<BrokerCommandRequest>,
    execute: (request: BrokerCommandRequest) => Promise<T>,
  ): Promise<T>;
}

/** Release token that can preserve a fail-closed durable fence. */
export interface CommandLeaseRelease {
  (): Promise<void>;
  /** Closes the local handle while deliberately preserving the lease file. */
  abandon(): Promise<void>;
}

/** Mutex capabilities needed to register a long-lived command lease. */
export interface CommandLeaseMutex {
  /** Acquires exclusive command execution and returns its release callback. */
  lock(options?: {
    /** Whether a dead owning process permits automatic lock recovery. */
    readonly reclaimable?: boolean;
  }): Promise<CommandLeaseRelease>;
  /** Executes an operation while holding the command lease. */
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/** Holds a run lease while releasing the global mutex before execution. */
export function createCommandExecutionGate(
  globalMutex: CommandLeaseMutex,
  runMutex: (runId: string) => CommandLeaseMutex,
): CommandExecutionGate {
  return {
    execute: async <T>(
      runId: string,
      authorize: () => Promise<BrokerCommandRequest>,
      execute: (request: BrokerCommandRequest) => Promise<T>,
    ): Promise<T> => {
      /** Release callback for the acquired lease or mutex. */
      let release: CommandLeaseRelease | undefined;
      /** Broker request authorized while the global mutex is held. */
      let request: BrokerCommandRequest | undefined;
      await globalMutex.run(async () => {
        release = await runMutex(runId).lock({ reclaimable: false });
        try {
          request = await authorize();
        } catch (error) {
          await release();
          release = undefined;
          throw error;
        }
      });
      try {
        return await execute(request!);
      } catch (error) {
        if (error instanceof ContainmentShutdownUnconfirmedError) {
          await release!.abandon();
          release = undefined;
        }
        throw error;
      } finally {
        if (release !== undefined) await release();
      }
    },
  };
}

/** Verifies run ownership and Agent policy before delegating one command. */
export class CommandProxy {
  /** Creates a proxy with a host-supplied, process-tree-contained executor. */
  public constructor(
    private readonly coordinator: AgentCoordinator,
    private readonly executor: CommandExecutor,
    private readonly gate: CommandExecutionGate,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** Executes an allowed command for a running, harness-owned Agent. */
  public async execute(input: ProxyCommandInput): Promise<ProxyCommandResult> {
    return this.gate.execute(
      input.runId,
      async () => {
        /** Canonical command key selected from positional arguments. */
        const command = normalizeCommandName(input.command, this.platform);
        /** Pinned command policy and execution directory for the run. */
        const authorization = await this.coordinator.commandAuthorization(
          input.runId,
          input.harnessId,
        );
        if (!commandIsAllowed(authorization.commands, command, this.platform))
          throw new Error(`Agent command is not allowed: ${command}`);
        return {
          arguments: [...input.arguments],
          command,
          commands: authorization.commands,
          runId: input.runId,
          schema: "agent-command-broker-request-v1",
          workingDirectory: authorization.workingDirectory,
        };
      },
      (request) => this.executor(request),
    );
  }
}

/** Creates an executor backed by a host-owned sandbox broker protocol. */
export function createCommandBrokerExecutor(
  brokerExecutable: string,
  brokerArguments: readonly string[] = [],
  options: CommandBrokerOptions = {},
): CommandExecutor {
  if (!isAbsolute(brokerExecutable))
    throw new TypeError("Command broker executable must be an absolute path");
  /** Maximum combined broker output accepted in bytes. */
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? 1024 * 1024,
    "Command broker maxOutputBytes",
  );
  /** Maximum execution or request duration in milliseconds. */
  const timeoutMilliseconds = positiveInteger(
    options.timeoutMilliseconds ?? 5 * 60 * 1000,
    "Command broker timeoutMilliseconds",
  );
  /** Grace period in milliseconds before shutdown is considered unconfirmed. */
  const terminationGraceMilliseconds = positiveInteger(
    options.terminationGraceMilliseconds ?? 1000,
    "Command broker terminationGraceMilliseconds",
  );
  return async (request) =>
    new Promise((resolve, reject) => {
      /** Contained broker process and its protocol streams. */
      const child = spawn(brokerExecutable, brokerArguments, {
        cwd: request.workingDirectory ?? undefined,
        env: processLookupEnvironment(options.environment ?? process.env),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      /** Captured standard-output text from the brokered command. */
      const stdout: Buffer[] = [];
      /** Captured standard-error output from the brokered command. */
      const stderr: Buffer[] = [];
      /** Combined stdout and stderr byte count received so far. */
      let outputBytes = 0;
      /** Whether the broker exchange Promise has reached a terminal result. */
      let settled = false;
      /** Containment failure retained until process closure is confirmed. */
      let terminationError: Error | undefined;
      /** Shutdown-grace timer armed after termination begins. */
      let graceTimer: NodeJS.Timeout | undefined;
      /** Command timeout that begins broker termination. */
      const timer = setTimeout(() => {
        terminate(
          new Error(
            `Command broker timed out after ${timeoutMilliseconds} milliseconds`,
          ),
        );
      }, timeoutMilliseconds);
      /** Escalation that rejects when containment shutdown cannot be confirmed. */
      const forceUnconfirmedShutdown = (): void => {
        if (settled || terminationError === undefined) return;
        settled = true;
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        try {
          child.kill("SIGKILL");
        } catch {
          // The durable run fence remains when termination cannot be sent.
        }
        child.unref();
        reject(
          new ContainmentShutdownUnconfirmedError(
            `${terminationError.message}; broker containment shutdown was not confirmed`,
          ),
        );
      };
      /** Idempotent broker-process termination transition. */
      const terminate = (error: Error): void => {
        if (settled || terminationError !== undefined) return;
        terminationError = error;
        clearTimeout(timer);
        child.stdin.end();
        graceTimer = setTimeout(
          forceUnconfirmedShutdown,
          terminationGraceMilliseconds,
        );
      };
      /** Stream handler that enforces the combined output limit. */
      const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
        if (terminationError !== undefined) return;
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          terminate(
            new Error(`Command broker output exceeded ${maxOutputBytes} bytes`),
          );
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.stdin.once("error", (error) => terminate(error));
      child.once("error", (error) => terminate(error));
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        if (terminationError !== undefined) {
          if (exitCode === 0 && signal === null) reject(terminationError);
          else
            reject(
              new ContainmentShutdownUnconfirmedError(
                `${terminationError.message}; broker containment shutdown was not confirmed`,
              ),
            );
          return;
        }
        if (exitCode !== 0 || signal !== null) {
          reject(
            new ContainmentShutdownUnconfirmedError(
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
      child.stdin.write(`${JSON.stringify(request)}\n`, "utf8");
    });
}

/** Requires a finite positive integer broker bound. */
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}

/** Validates the single JSON result emitted by the command broker. */
function parseBrokerResult(
  value: string,
  expectedCommand: string,
): ProxyCommandResult {
  /** Validated result returned by the current operation. */
  const result: unknown = JSON.parse(value);
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new TypeError("Command broker result must be an object");
  /** Strict record projected from the untyped boundary value. */
  const record = result as Record<string, unknown>;
  /** Allowlisted keys accepted by the current boundary. */
  const keys = ["command", "exitCode", "signal", "stderr", "stdout"];
  /** Whether the broker reported an ordinary numeric exit code. */
  const normalExit =
    Number.isSafeInteger(record.exitCode) &&
    (record.exitCode as number) >= 0 &&
    record.signal === null;
  /** Whether the broker reported termination by signal. */
  const signalledExit =
    record.exitCode === null &&
    typeof record.signal === "string" &&
    Object.hasOwn(operatingSystemConstants.signals, record.signal);
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in record)) ||
    record.command !== expectedCommand ||
    (!normalExit && !signalledExit) ||
    typeof record.stderr !== "string" ||
    typeof record.stdout !== "string"
  )
    throw new TypeError("Command broker returned an invalid result");
  return record as unknown as ProxyCommandResult;
}
