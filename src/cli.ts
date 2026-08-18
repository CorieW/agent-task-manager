#!/usr/bin/env node
/** Command-line surface for the simplified, harness-owned lifecycle. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";

import {
  parseEnvironmentConfig,
  type EnvironmentConfig,
} from "./config/environment.js";
import { AgentCoordinator } from "./core/coordinator.js";
import { CommandProxy } from "./core/command-proxy.js";
import { toJsonValue, type JsonValue } from "./domain/json.js";
import {
  parseReportErrorInput,
  type ReportErrorInput,
} from "./domain/records.js";
import type { AgentTaskProvider } from "./provider/agent-task-provider.js";
import { NotionProvider } from "./provider/notion/notion-provider.js";
import { NotionHttpTransport } from "./provider/notion/notion-transport.js";

const GLOBAL_FLAGS = ["environment", "help", "json"] as const;
const BOOLEAN_FLAGS = new Set(["apply", "help", "json", "plan"]);
interface CommandSpec {
  readonly flags: readonly string[];
  readonly name: string;
  readonly usage: string;
}
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
    flags: ["harness-id", "run-id"],
    name: "command proxy",
    usage: "command proxy --run-id ID --harness-id ID -- COMMAND [ARGUMENT...]",
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
const COMMAND_SPEC_BY_NAME = new Map(
  COMMAND_SPECS.map((spec) => [spec.name, spec] as const),
);
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
  const parsed = parseArguments(argv);
  const [family, action] = parsed.positionals;
  const helpRequested = family === undefined || parsed.flags.help === true;
  const command = helpRequested ? "help" : parsed.positionals.join(" ");
  validateFlags(command, parsed.flags);
  if (parsed.commandArguments.length !== 0 && command !== "command proxy")
    throw new Error(`Command arguments are not allowed for ${command}`);
  if (helpRequested || command === "help") return { help: HELP };
  if (family === "providers")
    return {
      providers: [{ connectionSecret: "NOTION_TOKEN", type: "notion" }],
    };

  const configuration = await loadEnvironment(parsed.flags.environment, env);
  const provider = providerFor(configuration, env);
  const coordinator = new AgentCoordinator(provider);

  if (family === "command" && action === "proxy") {
    const [executable, ...arguments_] = parsed.commandArguments;
    if (executable === undefined)
      throw new Error("command proxy requires a command after --");
    return toJsonValue(
      await new CommandProxy(coordinator).execute({
        arguments: arguments_,
        command: executable,
        harnessId: requiredFlag(parsed.flags, "harness-id"),
        runId: requiredFlag(parsed.flags, "run-id"),
      }),
    );
  }

  if (family === "validate") {
    const environment = await provider.validateEnvironment();
    const workspace = await provider.validateWorkspace();
    return toJsonValue({
      environment,
      valid: environment.valid && workspace.valid,
      workspace,
    });
  }
  if (family === "init") {
    const plan = await provider.planWorkspace(configuration.environmentId);
    if (parsed.flags.plan === true && parsed.flags.apply !== true)
      return plan as unknown as JsonValue;
    if (parsed.flags.apply !== true)
      throw new Error("init requires --plan or --apply");
    const expected = requiredFlag(parsed.flags, "expected-plan-digest");
    if (plan.digest !== expected)
      throw new Error(
        `Workspace plan drifted: expected ${expected}, observed ${plan.digest}`,
      );
    return {
      plan,
      tables: await provider.applyWorkspacePlan(plan),
    } as unknown as JsonValue;
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
        await coordinator.start({
          agentKey: requiredFlag(parsed.flags, "agent-key"),
          harnessId: requiredFlag(parsed.flags, "harness-id"),
          parentRunId: optionalString(parsed.flags["parent-run-id"]) ?? null,
          runId: requiredFlag(parsed.flags, "run-id"),
          taskId: requiredFlag(parsed.flags, "task-id"),
        }),
      );
    if (action === "heartbeat")
      return toJsonValue(
        await coordinator.heartbeat(
          requiredFlag(parsed.flags, "run-id"),
          requiredFlag(parsed.flags, "harness-id"),
        ),
      );
    if (action === "complete")
      return toJsonValue(
        await coordinator.complete(
          requiredFlag(parsed.flags, "run-id"),
          requiredFlag(parsed.flags, "harness-id"),
          requiredFlag(parsed.flags, "outcome"),
        ),
      );
    if (action === "fail")
      return toJsonValue(
        await coordinator.fail(
          requiredFlag(parsed.flags, "run-id"),
          requiredFlag(parsed.flags, "harness-id"),
          requiredFlag(parsed.flags, "summary"),
        ),
      );
    if (action === "sweep") return toJsonValue(await coordinator.sweep());
    if (action === "restart")
      return toJsonValue(
        await coordinator.restart({
          restartOfRunId: requiredFlag(parsed.flags, "restart-of-run-id"),
          harnessId: requiredFlag(parsed.flags, "harness-id"),
          runId: requiredFlag(parsed.flags, "run-id"),
        }),
      );
  }
  if (family === "error") {
    if (action === "list") return toJsonValue(await provider.listErrors());
    if (action === "get")
      return toJsonValue(
        await provider.getErrorByKey(requiredFlag(parsed.flags, "key")),
      );
    if (action === "report")
      return toJsonValue(
        await coordinator.reportError(
          await readErrorInput(requiredFlag(parsed.flags, "input")),
        ),
      );
    if (action === "resolve")
      return toJsonValue(
        await coordinator.resolveError(
          requiredFlag(parsed.flags, "key"),
          requiredFlag(parsed.flags, "resolution"),
        ),
      );
  }
  throw new Error(`Unknown command: ${parsed.positionals.join(" ")}`);
}

interface ParsedArguments {
  readonly commandArguments: readonly string[];
  readonly flags: Readonly<Record<string, boolean | string>>;
  readonly positionals: readonly string[];
}
function validateFlags(
  command: string,
  flags: Readonly<Record<string, boolean | string>>,
): void {
  const spec = COMMAND_SPEC_BY_NAME.get(command);
  if (spec === undefined) throw new Error(`Unknown command: ${command}`);
  const allowed = new Set([...GLOBAL_FLAGS, ...spec.flags]);
  for (const name of Object.keys(flags))
    if (!allowed.has(name))
      throw new Error(`Flag --${name} is not allowed for ${command}`);
}
function parseArguments(argv: readonly string[]): ParsedArguments {
  const flags: Record<string, boolean | string> = {};
  const positionals: string[] = [];
  let commandArguments: readonly string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--") {
      commandArguments = argv.slice(index + 1);
      break;
    }
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals !== -1) {
      const name = value.slice(2, equals);
      if (BOOLEAN_FLAGS.has(name))
        throw new Error(`Boolean flag --${name} does not accept a value`);
      flags[name] = value.slice(equals + 1);
      continue;
    }
    const name = value.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else flags[name] = true;
  }
  return { commandArguments, flags, positionals };
}
async function loadEnvironment(
  flag: boolean | string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<EnvironmentConfig> {
  const path =
    optionalString(flag) ??
    env.AGENT_TASK_MANAGER_ENVIRONMENT ??
    "agent-task-manager.environment.json";
  return parseEnvironmentConfig(
    toJsonValue(JSON.parse(await readFile(path, "utf8")) as unknown),
  );
}
function providerFor(
  configuration: EnvironmentConfig,
  env: NodeJS.ProcessEnv,
): AgentTaskProvider {
  if (configuration.provider.type !== "notion")
    throw new Error(`Unsupported provider: ${configuration.provider.type}`);
  const tokenVariable =
    typeof configuration.provider.connection.tokenEnv === "string"
      ? configuration.provider.connection.tokenEnv
      : "NOTION_TOKEN";
  const token = env[tokenVariable];
  if (token === undefined || token.trim() === "")
    throw new Error(`Missing Notion token in ${tokenVariable}`);
  return new NotionProvider(
    configuration.provider,
    new NotionHttpTransport({ token }),
  );
}
async function readErrorInput(path: string): Promise<ReportErrorInput> {
  const raw = path === "-" ? await readStdin() : await readFile(path, "utf8");
  const value = toJsonValue(JSON.parse(raw) as unknown);
  return parseReportErrorInput(value);
}
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
function requiredFlag(
  flags: Readonly<Record<string, boolean | string>>,
  name: string,
): string {
  const value = optionalString(flags[name]);
  if (value === undefined || value === "") throw new Error(`Missing --${name}`);
  return value;
}
function optionalString(
  value: boolean | string | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      const exitCode = proxyExitCode(result);
      if (exitCode !== null) process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}

/** Returns the child exit status when the CLI result came from the proxy. */
function proxyExitCode(result: JsonValue): number | null {
  if (
    result === null ||
    Array.isArray(result) ||
    typeof result !== "object" ||
    typeof result.exitCode !== "number"
  )
    return null;
  return result.exitCode;
}
