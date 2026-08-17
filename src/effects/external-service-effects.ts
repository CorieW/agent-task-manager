/** Implements configured command, disposable-browser, and draft-publication brokers. */
import { readFile } from "node:fs/promises";
import { isAbsolute, parse, resolve } from "node:path";

import { isSha256Digest, sha256 } from "../core/digest.js";
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

/** Workspace locator boundary. */
export interface WorkspaceLocator {
  /** Resolves an authorized workspace path for the repository. */
  locate(workspaceKey: string, repositoryId: string): Promise<string>;
}

/** Provider-neutral configured command contract. */
export interface ConfiguredCommand {
  /** Ordered the arguments prefix used by this contract. */
  readonly argumentsPrefix: readonly string[];
  /** SHA-256 digest of canonical executable. */
  readonly executableDigest: string;
  /** Absolute path of the executable to launch. */
  readonly executablePath: string;
  /** Stable key used by configured command. */
  readonly key: string;
  /** Indicates whether replay safe. */
  readonly replaySafe: true;
  /** Timeout in milliseconds. */
  readonly timeoutMilliseconds: number;
}

/** Outcome returned by command process. */
export interface CommandProcessResult {
  /** Process exit code returned by the child. */
  readonly exitCode: number;
  /** Captured standard-error bytes. */
  readonly stderr: Uint8Array;
  /** Captured standard-output bytes. */
  readonly stdout: Uint8Array;
}

/** Provider-neutral command process runner contract. */
export interface CommandProcessRunner {
  /** Runs command process runner within its configured limits. */
  run(input: {
    /** Ordered the arguments used by this contract. */
    readonly arguments: readonly string[];
    /** Working directory for the operation. */
    readonly cwd: string;
    /** Absolute path of the executable to launch. */
    readonly executablePath: string;
    /** Output limit in bytes. */
    readonly outputLimitBytes: number;
    /** Cancellation signal for the operation. */
    readonly signal: AbortSignal;
    /** Timeout in milliseconds. */
    readonly timeoutMilliseconds: number;
  }): Promise<CommandProcessResult>;
}

/** Implements node command process runner and its boundary checks. */
export class NodeCommandProcessRunner implements CommandProcessRunner {
  /** Runs node command process runner within its configured limits. */
  public async run(input: {
    /** Ordered the arguments used by this contract. */
    readonly arguments: readonly string[];
    /** Working directory for the operation. */
    readonly cwd: string;
    /** Absolute path of the executable to launch. */
    readonly executablePath: string;
    /** Output limit in bytes. */
    readonly outputLimitBytes: number;
    /** Cancellation signal for the operation. */
    readonly signal: AbortSignal;
    /** Timeout in milliseconds. */
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
  /** Stable identifier for configured command effects. */
  public readonly id = "configured-command";
  /** Ordered version used by compatibility checks. */
  public readonly version = "1";
  /** Ordered configured command accepted by configured command effects. */
  readonly #commands: ReadonlyMap<string, ConfiguredCommand>;
  /** Creates configured command effects with its required collaborators. */
  public constructor(
    commands: readonly ConfiguredCommand[],
    /** Workspaces callback used by configured command effects. */ private readonly workspaces: WorkspaceLocator,
    /** Runner used to execute the requested workload. */ private readonly runner: CommandProcessRunner = new NodeCommandProcessRunner(),
    /** Output limit in bytes. */ private readonly outputLimitBytes = 2_000_000,
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
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Validated effect payload. */
    readonly payload: CommandRunPayload;
  }): Promise<ExternalEffectObservation> {
    /** Command snapshot used consistently during the apply operation. */
    const command = this.#commands.get(payload.commandKey);
    if (command === undefined)
      throw new Error(`Command is not configured: ${payload.commandKey}`);
    if (
      sha256(await readFile(command.executablePath)) !==
      command.executableDigest
    )
      throw new Error(`Command executable drifted: ${command.key}`);
    /** Result of `this.workspaces.locate`, retained for the apply operation. */
    const cwd = await this.workspaces.locate(
      payload.workspaceKey,
      payload.repositoryId,
    );
    /** Validated result returned by apply. */
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
    /** Evidence snapshot used consistently during the apply operation. */
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

/** Provider-neutral draft publication target contract. */
export interface DraftPublicationTarget {
  /** Ordered id accepted by draft publication target. */
  readonly id: string;
  /** Ordered the repository ids used by this contract. */
  readonly repositoryIds: readonly string[];
}

/** Draft publication driver boundary. */
export interface DraftPublicationDriver {
  /** Creates or refreshes the one authorized Draft PR without changing its draft state. */
  apply(input: {
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Validated effect payload. */
    readonly payload: DraftPrPayload;
    /** Canonical target workspace schema. */
    readonly target: DraftPublicationTarget;
  }): Promise<ExternalEffectObservation>;
  /** Reconciles the stable target/repository/base/head Draft PR identity. */
  reconcile(input: {
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Validated effect payload. */
    readonly payload: DraftPrPayload;
    /** Canonical target workspace schema. */
    readonly target: DraftPublicationTarget;
  }): Promise<ExternalEffectObservation>;
}

/** Implements draft publication effects and its boundary checks. */
export class DraftPublicationEffects implements ReconcilableEffectAdapter<DraftPrPayload> {
  /** Stable identifier for draft publication effects. */
  public readonly id = "draft-publication";
  /** Ordered version used by compatibility checks. */
  public readonly version = "1";
  /** Ordered draft publication target accepted by draft publication effects. */
  readonly #targets: ReadonlyMap<string, DraftPublicationTarget>;
  /** Creates draft publication effects with its required collaborators. */
  public constructor(
    targets: readonly DraftPublicationTarget[],
    /** Driver used to control the underlying runtime. */ private readonly driver: DraftPublicationDriver,
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
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Validated effect payload. */
    readonly payload: DraftPrPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.apply({ ...input, target: this.target(input.payload) });
  }
  /** Reconciles previously observed draft publication state. */
  public reconcile(input: {
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Validated effect payload. */
    readonly payload: DraftPrPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.reconcile({
      ...input,
      target: this.target(input.payload),
    });
  }
  /** Returns the publication target authorized for the repository. */
  private target(payload: DraftPrPayload): DraftPublicationTarget {
    /** Target snapshot used consistently during the target operation. */
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

/** Trusted dependencies available to disposable browser. */
export interface DisposableBrowserEnvironment {
  /** Ordered network origins allowed for this browser environment. */
  readonly allowedOrigins: readonly string[];
  /** Stable identifier for disposable browser environment. */
  readonly id: string;
  /** Requires this browser environment to provide isolation. */
  readonly isolated: true;
}

/** Disposable browser driver boundary. */
export interface DisposableBrowserDriver {
  /** Applies the requested disposable browser operation. */
  apply(input: {
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Environment variables exposed to the operation. */
    readonly environment: DisposableBrowserEnvironment;
    /** Validated effect payload. */
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation>;
  /** Reconciles previously observed disposable browser state. */
  reconcile(input: {
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Environment variables exposed to the operation. */
    readonly environment: DisposableBrowserEnvironment;
    /** Validated effect payload. */
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation>;
}

/** Implements disposable browser effects and its boundary checks. */
export class DisposableBrowserEffects implements ReconcilableEffectAdapter<BrowserRunPayload> {
  /** Stable identifier for disposable browser effects. */
  public readonly id = "disposable-browser";
  /** Ordered version used by compatibility checks. */
  public readonly version = "1";
  /** Ordered disposable browser environment accepted by disposable browser effects. */
  readonly #environments: ReadonlyMap<string, DisposableBrowserEnvironment>;
  /** Creates disposable browser effects with its required collaborators. */
  public constructor(
    environments: readonly DisposableBrowserEnvironment[],
    /** Driver used to control the underlying runtime. */ private readonly driver: DisposableBrowserDriver,
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
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Validated effect payload. */
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.apply({
      ...input,
      environment: this.environment(input.payload.environmentKey),
    });
  }
  /** Reconciles previously observed local HTTP state. */
  public reconcile(input: {
    /** Cancellation signal and absolute deadline for the effect. */
    readonly control: ExternalEffectControl;
    /** Stable identifier for effect id. */
    readonly effectId: string;
    /** Validated effect payload. */
    readonly payload: BrowserRunPayload;
  }): Promise<ExternalEffectObservation> {
    return this.driver.reconcile({
      ...input,
      environment: this.environment(input.payload.environmentKey),
    });
  }
  /** Returns the configured environment or credentials for the requested boundary. */
  private environment(id: string): DisposableBrowserEnvironment {
    /** Parsed candidate awaiting environment validation. */
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
    !isSha256Digest(command.executableDigest) ||
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
    /** Result of `URL`, retained for the validate browser environment operation. */
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
