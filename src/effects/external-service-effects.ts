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

/** Defines the data and behavior required by workspace locator. */
export interface WorkspaceLocator {
  /** Resolves an authorized workspace path for the repository. */
  locate(workspaceKey: string, repositoryId: string): Promise<string>;
}
/** Defines the data and behavior required by configured command. */
export interface ConfiguredCommand {
  /** Lists the arguments prefix accepted by this contract. */
  readonly argumentsPrefix: readonly string[];
  /** Stores the SHA-256 digest of executable. */
  readonly executableDigest: string;
  /** Provides executable path to configured command. */
  readonly executablePath: string;
  /** Provides key to configured command. */
  readonly key: string;
  /** Indicates whether replay safe. */
  readonly replaySafe: true;
  /** Sets timeout in milliseconds. */
  readonly timeoutMilliseconds: number;
}
/** Defines the data and behavior required by command process result. */
export interface CommandProcessResult {
  /** Provides exit code to command process result. */
  readonly exitCode: number;
  /** Provides stderr to command process result. */
  readonly stderr: Uint8Array;
  /** Provides stdout to command process result. */
  readonly stdout: Uint8Array;
}
/** Defines the data and behavior required by command process runner. */
export interface CommandProcessRunner {
  /** Runs command process runner within its configured limits. */
  run(input: {
    /** Lists the arguments accepted by this contract. */
    readonly arguments: readonly string[];
    /** Provides cwd to command process runner. */
    readonly cwd: string;
    /** Provides executable path to command process runner. */
    readonly executablePath: string;
    /** Sets output limit in bytes. */
    readonly outputLimitBytes: number;
    /** Provides signal to command process runner. */
    readonly signal: AbortSignal;
    /** Sets timeout in milliseconds. */
    readonly timeoutMilliseconds: number;
  }): Promise<CommandProcessResult>;
}

/** Implements node command process runner and its boundary checks. */
export class NodeCommandProcessRunner implements CommandProcessRunner {
  /** Runs node command process runner within its configured limits. */
  public async run(input: {
    /** Lists the arguments accepted by this contract. */
    readonly arguments: readonly string[];
    /** Provides cwd to run. */
    readonly cwd: string;
    /** Provides executable path to run. */
    readonly executablePath: string;
    /** Sets output limit in bytes. */
    readonly outputLimitBytes: number;
    /** Provides signal to run. */
    readonly signal: AbortSignal;
    /** Sets timeout in milliseconds. */
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

/** Implements configured command effects and its boundary checks. */
export class ConfiguredCommandEffects implements ReconcilableEffectAdapter<CommandRunPayload> {
  /** Provides id to configured command effects. */
  public readonly id = "configured-command";
  /** Records the version used for compatibility checks. */
  public readonly version = "1";
  /** Provides commands to configured command effects. */
  readonly #commands: ReadonlyMap<string, ConfiguredCommand>;
  /** Creates configured command effects with its required collaborators. */
  public constructor(
    commands: readonly ConfiguredCommand[],
    /** Provides workspaces to configured command effects. */ private readonly workspaces: WorkspaceLocator,
    /** Provides runner to configured command effects. */ private readonly runner: CommandProcessRunner = new NodeCommandProcessRunner(),
    /** Sets output limit in bytes. */ private readonly outputLimitBytes = 2_000_000,
  ) {
    if (
      commands.length === 0 ||
      new Set(commands.map((command) => command.key)).size !== commands.length
    )
      throw new TypeError("Configured commands must be non-empty and unique");
    for (const command of commands) validateCommand(command);
    this.#commands = new Map(commands.map((command) => [command.key, command]));
  }
  /** Reconciles previously observed command execution state. */
  public async reconcile(): Promise<ExternalEffectObservation> {
    return notApplied({ replaySafe: true });
  }
  /** Applies the configured command effect. */
  public async apply({
    control,
    payload,
  }: {
    /** Provides control to apply. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides payload to apply. */
    readonly payload: CommandRunPayload;
  }): Promise<ExternalEffectObservation> {
    /** Stores command used by apply. */
    const command = this.#commands.get(payload.commandKey);
    if (command === undefined)
      throw new Error(`Command is not configured: ${payload.commandKey}`);
    if (
      sha256(await readFile(command.executablePath)) !==
      command.executableDigest
    )
      throw new Error(`Command executable drifted: ${command.key}`);
    /** Stores cwd used by apply. */
    const cwd = await this.workspaces.locate(
      payload.workspaceKey,
      payload.repositoryId,
    );
    /** Holds the validated result returned by apply. */
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
    /** Stores evidence used by apply. */
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

/** Defines the data and behavior required by draft publication target. */
export interface DraftPublicationTarget {
  /** Provides id to draft publication target. */
  readonly id: string;
  /** Lists the repository ids accepted by this contract. */
  readonly repositoryIds: readonly string[];
}
/** Defines the data and behavior required by draft publication driver. */
export interface DraftPublicationDriver {
  /** Applies the configured provider mutation. */
  apply(input: {
    /** Provides control to draft publication driver. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides payload to draft publication driver. */
    readonly payload: DraftPrPayload;
    /** Provides target to draft publication driver. */
    readonly target: DraftPublicationTarget;
  }): Promise<ExternalEffectObservation>;
  /** Reconciles previously observed provider mutation state. */
  reconcile(input: {
    /** Provides control to draft publication driver. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides payload to draft publication driver. */
    readonly payload: DraftPrPayload;
    /** Provides target to draft publication driver. */
    readonly target: DraftPublicationTarget;
  }): Promise<ExternalEffectObservation>;
}
/** Implements draft publication effects and its boundary checks. */
export class DraftPublicationEffects implements ReconcilableEffectAdapter<DraftPrPayload> {
  /** Provides id to draft publication effects. */
  public readonly id = "draft-publication";
  /** Records the version used for compatibility checks. */
  public readonly version = "1";
  /** Provides targets to draft publication effects. */
  readonly #targets: ReadonlyMap<string, DraftPublicationTarget>;
  /** Creates draft publication effects with its required collaborators. */
  public constructor(
    targets: readonly DraftPublicationTarget[],
    /** Provides driver to draft publication effects. */ private readonly driver: DraftPublicationDriver,
  ) {
    if (
      targets.length === 0 ||
      new Set(targets.map((target) => target.id)).size !== targets.length
    )
      throw new TypeError("Publication targets must be non-empty and unique");
    this.#targets = new Map(targets.map((target) => [target.id, target]));
  }
  /** Applies the requested draft publication. */
  public apply(input: {
    /** Provides control to apply. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides payload to apply. */
    readonly payload: DraftPrPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.apply({ ...input, target: this.target(input.payload) });
  }
  /** Reconciles previously observed draft publication state. */
  public reconcile(input: {
    /** Provides control to reconcile. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides payload to reconcile. */
    readonly payload: DraftPrPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.reconcile({
      ...input,
      target: this.target(input.payload),
    });
  }
  /** Returns the publication target authorized for the repository. */
  private target(payload: DraftPrPayload): DraftPublicationTarget {
    /** Stores target used by target. */
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

/** Defines the data and behavior required by disposable browser environment. */
export interface DisposableBrowserEnvironment {
  /** Lists network origins allowed for this browser environment. */
  readonly allowedOrigins: readonly string[];
  /** Provides id to disposable browser environment. */
  readonly id: string;
  /** Requires this browser environment to provide isolation. */
  readonly isolated: true;
}
/** Defines the data and behavior required by disposable browser driver. */
export interface DisposableBrowserDriver {
  /** Applies the requested disposable browser operation. */
  apply(input: {
    /** Provides control to disposable browser driver. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides environment to disposable browser driver. */
    readonly environment: DisposableBrowserEnvironment;
    /** Provides payload to disposable browser driver. */
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation>;
  /** Reconciles previously observed disposable browser state. */
  reconcile(input: {
    /** Provides control to disposable browser driver. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides environment to disposable browser driver. */
    readonly environment: DisposableBrowserEnvironment;
    /** Provides payload to disposable browser driver. */
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation>;
}
/** Implements disposable browser effects and its boundary checks. */
export class DisposableBrowserEffects implements ReconcilableEffectAdapter<BrowserRunPayload> {
  /** Provides id to disposable browser effects. */
  public readonly id = "disposable-browser";
  /** Records the version used for compatibility checks. */
  public readonly version = "1";
  /** Provides environments to disposable browser effects. */
  readonly #environments: ReadonlyMap<string, DisposableBrowserEnvironment>;
  /** Creates disposable browser effects with its required collaborators. */
  public constructor(
    environments: readonly DisposableBrowserEnvironment[],
    /** Provides driver to disposable browser effects. */ private readonly driver: DisposableBrowserDriver,
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
  /** Applies the requested local HTTP operation. */
  public apply(input: {
    /** Provides control to apply. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides payload to apply. */
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.apply({
      ...input,
      environment: this.environment(input.payload.environmentKey),
    });
  }
  /** Reconciles previously observed local HTTP state. */
  public reconcile(input: {
    /** Provides control to reconcile. */
    readonly control: ExternalEffectControl;
    /** Identifies effect. */
    readonly effectId: string;
    /** Provides payload to reconcile. */
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.reconcile({
      ...input,
      environment: this.environment(input.payload.environmentKey),
    });
  }
  /** Returns the configured environment or credentials for the requested boundary. */
  private environment(id: string): DisposableBrowserEnvironment {
    /** Holds the parsed value being validated by environment. */
    const found = this.#environments.get(id);
    if (found === undefined)
      throw new Error(`Browser environment is not configured: ${id}`);
    return found;
  }
}

/** Rejects invalid command before it crosses the boundary. */
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
/** Rejects invalid browser environment before it crosses the boundary. */
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
    /** Stores url used by validate browser environment. */
    const url = new URL(origin);
    if (
      !(["http:", "https:"] as string[]).includes(url.protocol) ||
      url.origin !== origin
    )
      throw new TypeError("Browser origin must be an exact HTTP(S) origin");
  }
}
/** Creates the corresponding canonical external-effect observation. */
function applied(
  externalIdentity: JsonObject,
  evidence: JsonObject,
): ExternalEffectObservation {
  return createEffectObservation("applied", evidence, externalIdentity);
}
/** Creates the corresponding canonical external-effect observation. */
function failed(evidence: JsonObject): ExternalEffectObservation {
  return createEffectObservation("failed", evidence);
}
/** Creates the corresponding canonical external-effect observation. */
function notApplied(evidence: JsonObject): ExternalEffectObservation {
  return createEffectObservation("not_applied", evidence);
}
