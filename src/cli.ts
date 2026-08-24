#!/usr/bin/env node
/** Command-line surface for the simplified, harness-owned lifecycle. */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

import {
  EnvironmentConfigError,
  parseEnvironmentConfig,
  type EnvironmentConfig,
} from "./config/environment.js";
import { AgentCoordinator, type SweepResult } from "./core/coordinator.js";
import { ConfiguredLifecycleCommands } from "./core/lifecycle-commands.js";
import {
  CommandProxy,
  createCommandBrokerExecutor,
  createCommandExecutionGate,
} from "./core/command-proxy.js";
import { toJsonValue, type JsonValue } from "./domain/json.js";
import {
  type ActiveAgentRecord,
  parseReportErrorInput,
  type ReportErrorInput,
} from "./domain/records.js";
import type { AgentTaskProvider } from "./provider/agent-task-provider.js";
import { NotionProvider } from "./provider/notion/notion-provider.js";
import { NotionHttpTransport } from "./provider/notion/notion-transport.js";
import { SingleHostMutex } from "./provider/notion/single-host-mutex.js";

/** Flags accepted before a command family and action. */
const GLOBAL_FLAGS = ["environment", "help", "json"] as const;
/** Flags that do not consume a following value. */
const BOOLEAN_FLAGS = new Set(["apply", "help", "json", "plan"]);
/** Declarative syntax for one CLI command. */
interface CommandSpec {
  /** Command-specific flags accepted by the parser. */
  readonly flags: readonly string[];
  /** Space-separated command family and action. */
  readonly name: string;
  /** Help text showing the command's invocation syntax. */
  readonly usage: string;
}

/** Supported command shapes and their accepted flags. */
const COMMAND_SPECS: readonly CommandSpec[] = [
  { flags: [], name: "help", usage: "help" },
  {
    flags: ["status"],
    name: "task list",
    usage: "task list [--status STATUS]",
  },
  { flags: ["id"], name: "task get", usage: "task get --id ID" },
  { flags: [], name: "agent list", usage: "agent list" },
  { flags: ["key"], name: "agent get", usage: "agent get --key KEY" },
  { flags: [], name: "resource list", usage: "resource list" },
  { flags: ["key"], name: "resource get", usage: "resource get --key KEY" },
  { flags: [], name: "active-agent list", usage: "active-agent list" },
  {
    flags: ["run-id"],
    name: "active-agent get",
    usage: "active-agent get --run-id ID",
  },
  {
    flags: ["agent-key", "harness-id", "parent-run-id", "run-id", "task-id"],
    name: "active-agent start",
    usage:
      "active-agent start --run-id ID --agent-key KEY --task-id ID --harness-id ID [--parent-run-id ID]",
  },
  {
    flags: ["harness-id", "run-id"],
    name: "active-agent heartbeat",
    usage: "active-agent heartbeat --run-id ID --harness-id ID",
  },
  {
    flags: ["harness-id", "outcome", "run-id"],
    name: "active-agent complete",
    usage:
      "active-agent complete --run-id ID --harness-id ID --outcome OUTCOME",
  },
  {
    flags: ["harness-id", "input", "run-id", "section"],
    name: "active-agent update-task-section",
    usage:
      "active-agent update-task-section --run-id ID --harness-id ID --section NAME --input FILE|-",
  },
  {
    flags: ["harness-id", "run-id", "summary"],
    name: "active-agent fail",
    usage: "active-agent fail --run-id ID --harness-id ID --summary TEXT",
  },
  { flags: [], name: "active-agent sweep", usage: "active-agent sweep" },
  {
    flags: ["harness-id", "restart-of-run-id", "run-id"],
    name: "active-agent restart",
    usage:
      "active-agent restart --restart-of-run-id ID --run-id ID --harness-id ID",
  },
  {
    flags: [],
    name: "command proxy",
    usage: "command proxy -- COMMAND [ARGUMENT...]",
  },
  { flags: [], name: "error list", usage: "error list" },
  { flags: ["key"], name: "error get", usage: "error get --key KEY" },
  {
    flags: ["input"],
    name: "error report",
    usage: "error report --input FILE|-",
  },
  {
    flags: ["key", "resolution"],
    name: "error resolve",
    usage: "error resolve --key KEY --resolution TEXT",
  },
  { flags: [], name: "validate", usage: "validate" },
  {
    flags: ["apply", "expected-plan-digest", "plan"],
    name: "init",
    usage: "init --plan | init --apply --expected-plan-digest SHA256",
  },
  { flags: [], name: "providers", usage: "providers" },
];
/** Command specifications indexed by `family action`. */
const COMMAND_SPEC_BY_NAME = new Map(
  COMMAND_SPECS.map((spec) => [spec.name, spec] as const),
);
/** Complete CLI usage text. */
const HELP = `agent-task-manager

Commands:
${COMMAND_SPECS.map((spec) => `  ${spec.usage}`).join("\n")}

Global flags:
  --environment FILE   Configuration file (default: AGENT_TASK_MANAGER_ENVIRONMENT or agent-task-manager.environment.json)
  --json               Accepted for compatibility; output is always JSON.
`;

/** Runs one CLI invocation and returns its JSON-serializable result. */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<JsonValue> {
  /** Parsed flags, positionals, and proxied command arguments. */
  const parsed = parseArguments(argv);
  /** Command family and optional action selected by the caller. */
  const [family, action] = parsed.positionals;
  /** Whether invocation should short-circuit to help output. */
  const helpRequested = family === undefined || parsed.flags.help === true;
  /** Normalized lookup key for flag validation and dispatch. */
  const command = helpRequested ? "help" : parsed.positionals.join(" ");
  validateFlags(command, parsed.flags);
  if (parsed.commandArguments.length !== 0 && command !== "command proxy")
    throw new Error(`Command arguments are not allowed for ${command}`);
  if (helpRequested || command === "help") return { help: HELP };
  if (family === "providers")
    return {
      providers: [{ connectionSecret: "NOTION_TOKEN", type: "notion" }],
    };

  /** Validated environment configuration for the requested command. */
  const configuration = await loadEnvironment(parsed.flags.environment, env);
  /** Provider implementation that owns persistence for this invocation. */
  const provider = providerFor(configuration, env);
  /** Lifecycle coordinator bound to this invocation's provider and hooks. */
  const coordinator = new AgentCoordinator(
    provider,
    () => new Date(),
    new ConfiguredLifecycleCommands(configuration.environmentId, env),
  );
  /** Lazily resolved coordination directory shared by all invocation locks. */
  let mutexRoot: string | undefined;
  /** Resolves and caches the trusted coordination directory. */
  const coordinationRoot = (): string =>
    (mutexRoot ??= coordinationDirectory(env));
  /** Lazily created environment-wide mutex. */
  let mutex: SingleHostMutex | undefined;
  /** Returns the invocation's environment-wide mutex. */
  const environmentMutex = (): SingleHostMutex =>
    (mutex ??= new SingleHostMutex(
      {
        environmentId: configuration.environmentId,
        scope: "environment",
      },
      coordinationRoot(),
    ));
  /** Per-run mutex instances reused throughout this invocation. */
  const runMutexes = new Map<string, SingleHostMutex>();
  /** Returns the cached mutex for a run, creating it when necessary. */
  const runMutex = (runId: string): SingleHostMutex => {
    /** Existing record selected for an idempotent update. */
    const existing = runMutexes.get(runId);
    if (existing !== undefined) return existing;
    /** New command-scope mutex for the requested run. */
    const created = new SingleHostMutex(
      {
        environmentId: configuration.environmentId,
        runId,
        scope: "command",
      },
      coordinationRoot(),
    );
    runMutexes.set(runId, created);
    return created;
  };

  if (family === "command" && action === "proxy") {
    /** Brokered executable and its uninterpreted argument vector. */
    const [executable, ...arguments_] = parsed.commandArguments;
    if (executable === undefined)
      throw new Error("command proxy requires a command after --");
    /** Run identity injected by the trusted command harness. */
    const runId = requiredEnvironmentValue(
      env,
      "AGENT_TASK_MANAGER_COMMAND_RUN_ID",
    );
    /** Harness identity injected by the trusted command harness. */
    const harnessId = requiredEnvironmentValue(
      env,
      "AGENT_TASK_MANAGER_COMMAND_HARNESS_ID",
    );
    return toJsonValue(
      await new CommandProxy(
        coordinator,
        commandBrokerExecutor(env),
        createCommandExecutionGate(environmentMutex(), runMutex),
      ).execute({
        arguments: arguments_,
        command: executable,
        harnessId,
        runId,
      }),
    );
  }

  if (family === "validate") {
    /** Environment-configuration validation result. */
    const environment = await provider.validateEnvironment();
    /** Remote-workspace validation result. */
    const workspace = await provider.validateWorkspace();
    return toJsonValue({
      environment,
      valid: environment.valid && workspace.valid,
      workspace,
    });
  }
  if (family === "init") {
    /** Deterministic workspace plan produced before either preview or apply. */
    const plan = await provider.planWorkspace(configuration.environmentId);
    if (parsed.flags.plan === true && parsed.flags.apply !== true)
      return toJsonValue(plan);
    if (parsed.flags.apply !== true)
      throw new Error("init requires --plan or --apply");
    /** Caller-authorized digest required before any workspace mutation. */
    const expected = requiredFlag(parsed.flags, "expected-plan-digest");
    if (plan.digest !== expected)
      throw new Error(
        `Workspace plan drifted: expected ${expected}, observed ${plan.digest}`,
      );
    return toJsonValue({
      plan,
      tables: await environmentMutex().run(() =>
        provider.applyWorkspacePlan(plan),
      ),
    });
  }
  if (family === "task") {
    if (action === "list")
      return toJsonValue(
        await provider.listTasks(optionalString(parsed.flags.status)),
      );
    if (action === "get")
      return toJsonValue(
        await provider.getTask(requiredFlag(parsed.flags, "id")),
      );
  }
  if (family === "agent") {
    if (action === "list") return toJsonValue(await provider.listAgents());
    if (action === "get")
      return toJsonValue(
        await provider.getAgentByKey(requiredFlag(parsed.flags, "key")),
      );
  }
  if (family === "resource") {
    if (action === "list") return toJsonValue(await provider.listResources());
    if (action === "get")
      return toJsonValue(
        await provider.getResourceByKey(requiredFlag(parsed.flags, "key")),
      );
  }
  if (family === "active-agent") {
    if (action === "list")
      return toJsonValue(await provider.listActiveAgents());
    if (action === "get")
      return toJsonValue(
        await provider.getActiveAgent(requiredFlag(parsed.flags, "run-id")),
      );
    if (action === "start")
      return toJsonValue(
        await environmentMutex().run(() =>
          coordinator.start({
            agentKey: requiredFlag(parsed.flags, "agent-key"),
            harnessId: requiredFlag(parsed.flags, "harness-id"),
            parentRunId: optionalString(parsed.flags["parent-run-id"]) ?? null,
            runId: requiredFlag(parsed.flags, "run-id"),
            taskId: requiredFlag(parsed.flags, "task-id"),
          }),
        ),
      );
    if (action === "heartbeat")
      return toJsonValue(
        await runMutex(requiredFlag(parsed.flags, "run-id")).run(() =>
          coordinator.heartbeat(
            requiredFlag(parsed.flags, "run-id"),
            requiredFlag(parsed.flags, "harness-id"),
          ),
        ),
      );
    if (action === "complete")
      return toJsonValue(
        await withRunLeases(
          environmentMutex(),
          runMutex,
          provider,
          [requiredFlag(parsed.flags, "run-id")],
          () =>
            coordinator.complete(
              requiredFlag(parsed.flags, "run-id"),
              requiredFlag(parsed.flags, "harness-id"),
              requiredFlag(parsed.flags, "outcome"),
            ),
        ),
      );
    if (action === "update-task-section") {
      /** Replacement section content read from the requested input source. */
      const content = await readTextInput(requiredFlag(parsed.flags, "input"));
      return toJsonValue(
        await withRunLeases(
          environmentMutex(),
          runMutex,
          provider,
          [requiredFlag(parsed.flags, "run-id")],
          () =>
            coordinator.updateTaskSection(
              requiredFlag(parsed.flags, "run-id"),
              requiredFlag(parsed.flags, "harness-id"),
              requiredFlag(parsed.flags, "section"),
              content,
            ),
        ),
      );
    }
    if (action === "fail")
      return toJsonValue(
        await withRunLeases(
          environmentMutex(),
          runMutex,
          provider,
          [requiredFlag(parsed.flags, "run-id")],
          () =>
            coordinator.fail(
              requiredFlag(parsed.flags, "run-id"),
              requiredFlag(parsed.flags, "harness-id"),
              requiredFlag(parsed.flags, "summary"),
            ),
        ),
      );
    if (action === "sweep")
      return toJsonValue(
        await sweepWithRunLeases(environmentMutex(), runMutex, coordinator),
      );
    if (action === "restart")
      return toJsonValue(
        await withRunLeases(
          environmentMutex(),
          runMutex,
          provider,
          [requiredFlag(parsed.flags, "restart-of-run-id")],
          () =>
            coordinator.restart({
              restartOfRunId: requiredFlag(parsed.flags, "restart-of-run-id"),
              harnessId: requiredFlag(parsed.flags, "harness-id"),
              runId: requiredFlag(parsed.flags, "run-id"),
            }),
        ),
      );
  }
  if (family === "error") {
    if (action === "list") return toJsonValue(await provider.listErrors());
    if (action === "get")
      return toJsonValue(
        await provider.getErrorByKey(requiredFlag(parsed.flags, "key")),
      );
    if (action === "report") {
      /** Strictly parsed error report payload. */
      const input = await readErrorInput(requiredFlag(parsed.flags, "input"));
      return toJsonValue(
        await environmentMutex().run(() => coordinator.reportError(input)),
      );
    }
    if (action === "resolve")
      return toJsonValue(
        await environmentMutex().run(() =>
          coordinator.resolveError(
            requiredFlag(parsed.flags, "key"),
            requiredFlag(parsed.flags, "resolution"),
          ),
        ),
      );
  }
  throw new Error(`Unknown command: ${parsed.positionals.join(" ")}`);
}

/** Parsed CLI tokens split by their dispatch role. */
interface ParsedArguments {
  /** Tokens following `--`, passed unchanged to the command broker. */
  readonly commandArguments: readonly string[];
  /** Parsed long flags keyed without their leading `--`. */
  readonly flags: Readonly<Record<string, boolean | string>>;
  /** Positional tokens that identify the command family and action. */
  readonly positionals: readonly string[];
}

/** Rejects flags outside the selected command's allowlist. */
function validateFlags(
  command: string,
  flags: Readonly<Record<string, boolean | string>>,
): void {
  /** Declared syntax for the selected command. */
  const spec = COMMAND_SPEC_BY_NAME.get(command);
  if (spec === undefined) throw new Error(`Unknown command: ${command}`);
  /** Global flags available to this command boundary. */
  const globalFlags =
    command === "command proxy"
      ? GLOBAL_FLAGS.filter((name) => name !== "environment")
      : GLOBAL_FLAGS;
  /** Complete allowlist for the selected command. */
  const allowed = new Set([...globalFlags, ...spec.flags]);
  for (const name of Object.keys(flags))
    if (!allowed.has(name))
      throw new Error(`Flag --${name} is not allowed for ${command}`);
}

/** Splits CLI tokens into positionals, flags, and broker arguments. */
function parseArguments(argv: readonly string[]): ParsedArguments {
  /** Long flags accumulated from the argument vector. */
  const flags: Record<string, boolean | string> = {};
  /** Non-flag command tokens before the `--` boundary. */
  const positionals: string[] = [];
  /** Unparsed command tokens after the `--` boundary. */
  let commandArguments: readonly string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    /** Current argument token. */
    const value = argv[index]!;
    if (value === "--") {
      commandArguments = argv.slice(index + 1);
      break;
    }
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    /** Offset of an inline `--name=value` separator. */
    const equals = value.indexOf("=");
    if (equals !== -1) {
      /** Flag name extracted from an inline assignment. */
      const name = value.slice(2, equals);
      if (BOOLEAN_FLAGS.has(name))
        throw new Error(`Boolean flag --${name} does not accept a value`);
      flags[name] = value.slice(equals + 1);
      continue;
    }
    /** Flag name extracted from a standalone long option. */
    const name = value.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    /** Possible value token following a non-boolean flag. */
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else flags[name] = true;
  }
  return { commandArguments, flags, positionals };
}

/** Loads and validates the selected environment configuration file. */
async function loadEnvironment(
  flag: boolean | string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<EnvironmentConfig> {
  /** Configuration path chosen from flag, environment, or default. */
  const path =
    optionalString(flag) ??
    env.AGENT_TASK_MANAGER_ENVIRONMENT ??
    "agent-task-manager.environment.json";
  return parseEnvironmentConfig(
    toJsonValue(JSON.parse(await readFile(path, "utf8")) as unknown),
  );
}

/** Creates the configured provider after resolving its credentials. */
function providerFor(
  configuration: EnvironmentConfig,
  env: NodeJS.ProcessEnv,
): AgentTaskProvider {
  if (configuration.provider.type !== "notion")
    throw new Error(`Unsupported provider: ${configuration.provider.type}`);
  /** Environment-variable name holding the Notion token. */
  const tokenVariable =
    typeof configuration.provider.connection.tokenEnv === "string"
      ? configuration.provider.connection.tokenEnv
      : "NOTION_TOKEN";
  /** Notion token resolved from the configured environment variable. */
  const token = env[tokenVariable];
  if (token === undefined || token.trim() === "")
    throw new Error(`Missing Notion token in ${tokenVariable}`);
  return new NotionProvider(
    configuration.provider,
    new NotionHttpTransport({ token }),
  );
}

/** Loads the mandatory host-owned sandbox broker used for Agent commands. */
function commandBrokerExecutor(env: NodeJS.ProcessEnv) {
  /** Absolute executable path for the trusted sandbox broker. */
  const executable = env.AGENT_TASK_MANAGER_COMMAND_BROKER;
  if (executable === undefined || executable.trim() === "")
    throw new Error(
      "AGENT_TASK_MANAGER_COMMAND_BROKER must name an absolute sandbox broker executable",
    );
  /** Optional cap on combined command output. */
  const maxOutputBytes = optionalPositiveInteger(
    env.AGENT_TASK_MANAGER_COMMAND_MAX_OUTPUT_BYTES,
    "AGENT_TASK_MANAGER_COMMAND_MAX_OUTPUT_BYTES",
  );
  /** Optional command execution timeout. */
  const timeoutMilliseconds = optionalPositiveInteger(
    env.AGENT_TASK_MANAGER_COMMAND_TIMEOUT_MS,
    "AGENT_TASK_MANAGER_COMMAND_TIMEOUT_MS",
  );
  /** Optional grace period between termination signals. */
  const terminationGraceMilliseconds = optionalPositiveInteger(
    env.AGENT_TASK_MANAGER_COMMAND_TERMINATION_GRACE_MS,
    "AGENT_TASK_MANAGER_COMMAND_TERMINATION_GRACE_MS",
  );
  return createCommandBrokerExecutor(executable, [], {
    environment: env,
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(terminationGraceMilliseconds === undefined
      ? {}
      : { terminationGraceMilliseconds }),
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
  });
}

/** Parses an optional positive integer environment setting. */
function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  /** Numeric representation of the environment setting. */
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** Serializes a terminal lifecycle mutation against commands in its subtree. */
async function withRunLeases<T>(
  globalMutex: SingleHostMutex,
  runMutex: (runId: string) => SingleHostMutex,
  provider: AgentTaskProvider,
  roots: readonly string[] | null,
  operation: () => Promise<T>,
): Promise<T> {
  return globalMutex.run(async () => {
    /** Active Agent snapshot used to determine the protected run set. */
    const active = await provider.listActiveAgents();
    /** Sorted run subtree protected by this terminal mutation. */
    const runIds = affectedRunIds(active, roots);
    /** Release callbacks in acquisition order. */
    const releases: Array<() => Promise<void>> = [];
    try {
      for (const runId of runIds) releases.push(await runMutex(runId).lock());
      return await operation();
    } finally {
      await releaseAllInReverse(releases);
    }
  });
}

/** Releases every acquired lease in reverse order before rethrowing the first cleanup failure. */
async function releaseAllInReverse(
  releases: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  /** Whether at least one release has thrown, including a thrown `undefined`. */
  let hasFailure = false;
  /** First cleanup failure in reverse execution order. */
  let firstFailure: unknown;

  for (const release of releases.toReversed()) {
    try {
      await release();
    } catch (error) {
      if (!hasFailure) {
        hasFailure = true;
        firstFailure = error;
      }
    }
  }

  if (hasFailure) throw firstFailure;
}

/** Structured sweep result that reports independently fenced stale subtrees. */
export interface SweepBatchResult {
  /** Stale subtree roots skipped because another command owns a lease. */
  readonly blockedRunIds: readonly string[];
  /** Successfully swept subtree results. */
  readonly swept: readonly SweepResult[];
}

/** Sweeps each planned stale subtree without leasing unrelated healthy runs. */
export async function sweepWithRunLeases(
  globalMutex: SingleHostMutex,
  runMutex: (runId: string) => SingleHostMutex,
  coordinator: AgentCoordinator,
): Promise<SweepBatchResult> {
  return globalMutex.run(async () => {
    /** Independently leasable stale subtrees proposed by the coordinator. */
    const plans = await coordinator.planSweep();
    /** Root IDs skipped because their subtree could not be fully leased. */
    const blockedRunIds: string[] = [];
    /** Results from subtrees swept during this batch. */
    const swept: SweepResult[] = [];
    for (const plan of plans) {
      /** Release callbacks for this subtree in acquisition order. */
      const releases: Array<() => Promise<void>> = [];
      try {
        try {
          for (const runId of plan.runIds)
            releases.push(await runMutex(runId).lock());
        } catch (error) {
          if (!isLockContention(error)) throw error;
          blockedRunIds.push(plan.rootRunId);
          continue;
        }
        swept.push(...(await coordinator.sweep([plan.rootRunId])));
      } finally {
        await releaseAllInReverse(releases);
      }
    }
    return { blockedRunIds, swept };
  });
}

/** Identifies a live or quarantined same-host run lease. */
function isLockContention(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** Returns sorted roots and descendants whose terminal state may be mutated. */
function affectedRunIds(
  active: readonly ActiveAgentRecord[],
  roots: readonly string[] | null,
): readonly string[] {
  if (roots === null)
    return [...new Set(active.map((run) => run.runId))].sort();
  /** Growing set seeded with the requested roots. */
  const result = new Set(roots);
  /** Whether the previous traversal discovered another descendant. */
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of active)
      if (
        run.parentRunId !== null &&
        result.has(run.parentRunId) &&
        !result.has(run.runId)
      ) {
        result.add(run.runId);
        changed = true;
      }
  }
  return [...result].sort();
}

/** Reads and strictly parses an error-report payload. */
async function readErrorInput(path: string): Promise<ReportErrorInput> {
  /** Untrusted environment or provider payload before strict parsing. */
  const raw = await readTextInput(path);
  /** JSON-safe representation passed to domain validation. */
  const value = toJsonValue(JSON.parse(raw) as unknown);
  return parseReportErrorInput(value);
}

/** Reads UTF-8 text from a file or standard input. */
async function readTextInput(path: string): Promise<string> {
  return path === "-" ? readStdin() : readFile(path, "utf8");
}

/** Collects standard input as UTF-8 text. */
async function readStdin(): Promise<string> {
  /** Binary chunks collected from the input stream. */
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a required string-valued CLI flag. */
function requiredFlag(
  flags: Readonly<Record<string, boolean | string>>,
  name: string,
): string {
  /** String value supplied for the named flag. */
  const value = optionalString(flags[name]);
  if (value === undefined || value === "") throw new Error(`Missing --${name}`);
  return value;
}

/** Reads a non-empty identity value injected by the trusted harness. */
function requiredEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  /** Raw value supplied by the trusted harness environment. */
  const value = env[name];
  if (value === undefined || value.trim() === "")
    throw new Error(`Missing ${name}`);
  return value;
}

/** Resolves manager-only lock storage provisioned outside Agent sandboxes. */
function coordinationDirectory(env: NodeJS.ProcessEnv): string {
  /** Required manager-owned coordination path. */
  const path = requiredEnvironmentValue(
    env,
    "AGENT_TASK_MANAGER_COORDINATION_DIRECTORY",
  );
  if (!isAbsolute(path))
    throw new Error(
      "AGENT_TASK_MANAGER_COORDINATION_DIRECTORY must be an absolute path",
    );
  return path;
}

/** Narrows an optional flag value to a string. */
function optionalString(
  value: boolean | string | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      /** Process exit code derived from the thrown value. */
      const exitCode = proxyExitCode(result);
      if (exitCode !== null) process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(
        `${JSON.stringify(cliErrorPayload(error), null, 2)}\n`,
      );
      process.exitCode = 1;
    },
  );
}

/** Converts a rejected CLI invocation into its stable machine-readable envelope. */
export function cliErrorPayload(error: unknown): JsonValue {
  /** Human-readable failure text preserved without serializing sensitive causes. */
  const message = error instanceof Error ? error.message : String(error);
  /** Structured validation details available for aggregate configuration errors. */
  const issues =
    error instanceof EnvironmentConfigError ? [...error.issues] : undefined;
  return {
    error: {
      ...(issues === undefined ? {} : { issues }),
      message,
      name: error instanceof Error ? error.name : "Error",
    },
  };
}

/** Identifies a CLI entry point after resolving package-manager links. */
export function isDirectExecution(
  moduleUrl: string,
  argumentPath: string | undefined,
): boolean {
  if (argumentPath === undefined) return false;
  try {
    /** Canonical path of this module. */
    const modulePath = realpathSync(fileURLToPath(moduleUrl));
    /** Canonical path used to invoke the process. */
    const invokedPath = realpathSync(argumentPath);
    return process.platform === "win32"
      ? modulePath.toLowerCase() === invokedPath.toLowerCase()
      : modulePath === invokedPath;
  } catch {
    return moduleUrl === pathToFileURL(argumentPath).href;
  }
}

/** Returns a nonzero status for failed or signalled proxied commands. */
export function proxyExitCode(result: JsonValue): number | null {
  if (result === null || Array.isArray(result) || typeof result !== "object")
    return null;
  if (typeof result.signal === "string") return 1;
  return typeof result.exitCode === "number" ? result.exitCode : null;
}
