#!/usr/bin/env node
/** Command-line surface for the simplified, harness-owned lifecycle. */
import process from "node:process";

import { AgentCoordinator } from "./core/coordinator.js";
import { ConfiguredLifecycleCommands } from "./core/lifecycle-commands.js";
import {
  CommandProxy,
  createCommandExecutionGate,
} from "./core/command-proxy.js";
import { toJsonValue, type JsonValue } from "./domain/json.js";
import { SingleHostMutex } from "./provider/notion/single-host-mutex.js";
import { HELP, parseArguments, validateFlags } from "./cli/arguments.js";
import {
  cliErrorPayload,
  isDirectExecution,
  proxyExitCode,
} from "./cli/entry.js";
import {
  coordinationDirectory,
  optionalString,
  readErrorInput,
  readTextInput,
  requiredEnvironmentValue,
  requiredFlag,
} from "./cli/input.js";
import { sweepWithRunLeases, withRunLeases } from "./cli/leases.js";
import {
  commandBrokerExecutor,
  loadEnvironment,
  providerFor,
} from "./cli/runtime.js";

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
      throw new Error("command proxy requires a command");
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

export {
  cliErrorPayload,
  isDirectExecution,
  parseArguments,
  proxyExitCode,
  sweepWithRunLeases,
};
export type { ParsedArguments } from "./cli/arguments.js";
export type { SweepBatchResult } from "./cli/leases.js";
