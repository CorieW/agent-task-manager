/** Implements configured command, disposable-browser, and draft-publication brokers. */
import { readFile } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";

import { sha256 } from "../core/digest.js";
import type { JsonObject } from "../domain/json.js";
import type {
  ExternalEffectControl,
  ExternalEffectObservation,
} from "./contracts.js";
import { createEffectObservation } from "./observations.js";
import { runBoundedChildProcess } from "./bounded-child-process.js";
import type {
  BrowserRunPayload,
  CommandRunPayload,
  DraftPrPayload,
  ReconcilableEffectAdapter,
} from "./typed-effect-handlers.js";

export interface WorkspaceLocator {
  locate(workspaceKey: string, repositoryId: string): Promise<string>;
}
export interface ConfiguredCommand {
  readonly argumentsPrefix: readonly string[];
  readonly executableDigest: string;
  readonly executablePath: string;
  readonly key: string;
  readonly replaySafe: true;
  readonly timeoutMilliseconds: number;
}
export interface CommandProcessResult {
  readonly exitCode: number;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
}
export interface CommandProcessRunner {
  run(input: {
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly executablePath: string;
    readonly outputLimitBytes: number;
    readonly signal: AbortSignal;
    readonly timeoutMilliseconds: number;
  }): Promise<CommandProcessResult>;
}

export class NodeCommandProcessRunner implements CommandProcessRunner {
  public async run(input: {
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly executablePath: string;
    readonly outputLimitBytes: number;
    readonly signal: AbortSignal;
    readonly timeoutMilliseconds: number;
  }): Promise<CommandProcessResult> {
    return runBoundedChildProcess({
      arguments: input.arguments,
      cwd: input.cwd,
      deadlineAt: Date.now() + input.timeoutMilliseconds,
      environment: {},
      executablePath: input.executablePath,
      outputLimitBytes: input.outputLimitBytes,
      signal: input.signal,
    });
  }
}

export class ConfiguredCommandEffects implements ReconcilableEffectAdapter<CommandRunPayload> {
  public readonly id = "configured-command";
  public readonly version = "1";
  readonly #commands: ReadonlyMap<string, ConfiguredCommand>;
  public constructor(
    commands: readonly ConfiguredCommand[],
    private readonly workspaces: WorkspaceLocator,
    private readonly runner: CommandProcessRunner = new NodeCommandProcessRunner(),
    private readonly outputLimitBytes = 2_000_000,
  ) {
    if (
      commands.length === 0 ||
      new Set(commands.map((command) => command.key)).size !== commands.length
    )
      throw new TypeError("Configured commands must be non-empty and unique");
    for (const command of commands) validateCommand(command);
    this.#commands = new Map(commands.map((command) => [command.key, command]));
  }
  public async reconcile(): Promise<ExternalEffectObservation> {
    return notApplied({ replaySafe: true });
  }
  public async apply({
    control,
    payload,
  }: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly payload: CommandRunPayload;
  }): Promise<ExternalEffectObservation> {
    const command = this.#commands.get(payload.commandKey);
    if (command === undefined)
      throw new Error(`Command is not configured: ${payload.commandKey}`);
    if (
      sha256(await readFile(command.executablePath)) !==
      command.executableDigest
    )
      throw new Error(`Command executable drifted: ${command.key}`);
    const cwd = await this.workspaces.locate(
      payload.workspaceKey,
      payload.repositoryId,
    );
    const result = await this.runner.run({
      arguments: [...command.argumentsPrefix, ...payload.arguments],
      cwd,
      executablePath: command.executablePath,
      outputLimitBytes: this.outputLimitBytes,
      signal: control.signal,
      timeoutMilliseconds: Math.min(
        command.timeoutMilliseconds,
        Math.max(1, control.deadlineAt - Date.now()),
      ),
    });
    const evidence = {
      exitCode: result.exitCode,
      stderrDigest: sha256(result.stderr),
      stdoutDigest: sha256(result.stdout),
    };
    return result.exitCode === 0
      ? applied(
          { commandKey: command.key, workspaceKey: payload.workspaceKey },
          evidence,
        )
      : failed(evidence);
  }
}

export interface DraftPublicationTarget {
  readonly id: string;
  readonly repositoryIds: readonly string[];
}
export interface DraftPublicationDriver {
  apply(input: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly payload: DraftPrPayload;
    readonly target: DraftPublicationTarget;
  }): Promise<ExternalEffectObservation>;
  reconcile(input: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly payload: DraftPrPayload;
    readonly target: DraftPublicationTarget;
  }): Promise<ExternalEffectObservation>;
}
export class DraftPublicationEffects implements ReconcilableEffectAdapter<DraftPrPayload> {
  public readonly id = "draft-publication";
  public readonly version = "1";
  readonly #targets: ReadonlyMap<string, DraftPublicationTarget>;
  public constructor(
    targets: readonly DraftPublicationTarget[],
    private readonly driver: DraftPublicationDriver,
  ) {
    if (
      targets.length === 0 ||
      new Set(targets.map((target) => target.id)).size !== targets.length
    )
      throw new TypeError("Publication targets must be non-empty and unique");
    this.#targets = new Map(targets.map((target) => [target.id, target]));
  }
  public apply(input: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly payload: DraftPrPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.apply({ ...input, target: this.target(input.payload) });
  }
  public reconcile(input: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly payload: DraftPrPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.reconcile({
      ...input,
      target: this.target(input.payload),
    });
  }
  private target(payload: DraftPrPayload): DraftPublicationTarget {
    const target = this.#targets.get(payload.publicationTarget);
    if (
      target === undefined ||
      !target.repositoryIds.includes(payload.repositoryId)
    )
      throw new Error(
        "Publication target is not authorized for this repository",
      );
    return target;
  }
}

export interface DisposableBrowserEnvironment {
  readonly allowedOrigins: readonly string[];
  readonly id: string;
  readonly isolated: true;
}
export interface DisposableBrowserDriver {
  apply(input: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly environment: DisposableBrowserEnvironment;
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation>;
  reconcile(input: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly environment: DisposableBrowserEnvironment;
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation>;
}
export class DisposableBrowserEffects implements ReconcilableEffectAdapter<BrowserRunPayload> {
  public readonly id = "disposable-browser";
  public readonly version = "1";
  readonly #environments: ReadonlyMap<string, DisposableBrowserEnvironment>;
  public constructor(
    environments: readonly DisposableBrowserEnvironment[],
    private readonly driver: DisposableBrowserDriver,
  ) {
    if (
      environments.length === 0 ||
      new Set(environments.map((environment) => environment.id)).size !==
        environments.length
    )
      throw new TypeError("Browser environments must be non-empty and unique");
    environments.forEach(validateBrowserEnvironment);
    this.#environments = new Map(
      environments.map((environment) => [environment.id, environment]),
    );
  }
  public apply(input: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.apply({
      ...input,
      environment: this.environment(input.payload.environmentKey),
    });
  }
  public reconcile(input: {
    readonly control: ExternalEffectControl;
    readonly effectId: string;
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.reconcile({
      ...input,
      environment: this.environment(input.payload.environmentKey),
    });
  }
  private environment(id: string): DisposableBrowserEnvironment {
    const found = this.#environments.get(id);
    if (found === undefined)
      throw new Error(`Browser environment is not configured: ${id}`);
    return found;
  }
}

function validateCommand(command: ConfiguredCommand): void {
  if (
    command.key === "" ||
    !isAbsolute(command.executablePath) ||
    !/^[a-f0-9]{64}$/u.test(command.executableDigest) ||
    command.timeoutMilliseconds < 1 ||
    !Number.isSafeInteger(command.timeoutMilliseconds) ||
    command.argumentsPrefix.some((value) => value.includes("\0"))
  )
    throw new TypeError("Configured command is invalid");
  resolve(command.executablePath);
  if (
    parse(resolve(command.executablePath)).root ===
    resolve(command.executablePath)
  )
    throw new TypeError("Command executable path is invalid");
}
function validateBrowserEnvironment(
  environment: DisposableBrowserEnvironment,
): void {
  if (
    environment.id === "" ||
    environment.isolated !== true ||
    environment.allowedOrigins.length === 0 ||
    new Set(environment.allowedOrigins).size !==
      environment.allowedOrigins.length
  )
    throw new TypeError("Disposable browser environment is invalid");
  for (const origin of environment.allowedOrigins) {
    const url = new URL(origin);
    if (
      !(["http:", "https:"] as string[]).includes(url.protocol) ||
      url.origin !== origin
    )
      throw new TypeError("Browser origin must be an exact HTTP(S) origin");
  }
}
function applied(
  externalIdentity: JsonObject,
  evidence: JsonObject,
): ExternalEffectObservation {
  return createEffectObservation("applied", evidence, externalIdentity);
}
function failed(evidence: JsonObject): ExternalEffectObservation {
  return createEffectObservation("failed", evidence);
}
function notApplied(evidence: JsonObject): ExternalEffectObservation {
  return createEffectObservation("not_applied", evidence);
}
