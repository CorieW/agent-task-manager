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
import { toJsonValue, type JsonValue } from "./domain/json.js";
import {
  parseReportErrorInput,
  type ReportErrorInput,
} from "./domain/records.js";
import type { AgentTaskProvider } from "./provider/agent-task-provider.js";
import { NotionProvider } from "./provider/notion/notion-provider.js";
import { NotionHttpTransport } from "./provider/notion/notion-transport.js";

const HELP = `agent-task-manager

Commands:
  task list [--status STATUS] | task get --id ID
  agent list | agent get --key KEY
  resource list | resource get --key KEY
  active-agent list | get --run-id ID
  active-agent start --run-id ID --agent-key KEY --task-id ID --harness-id ID [--parent-run-id ID]
  active-agent heartbeat --run-id ID --harness-id ID
  active-agent complete --run-id ID --harness-id ID --outcome OUTCOME
  active-agent fail --run-id ID --harness-id ID --summary TEXT
  active-agent sweep
  active-agent restart --failed-run-id ID --run-id ID --harness-id ID
  error list | get --key KEY
  error report --input FILE|- | resolve --key KEY --resolution TEXT
  validate
  init --plan | init --apply --expected-plan-digest SHA256
  providers

Global flags:
  --environment FILE   Configuration file (default: AGENT_TASK_MANAGER_ENVIRONMENT or agent-task-manager.environment.json)
  --json               Accepted for compatibility; output is always JSON.
`;

const GLOBAL_FLAGS = ["environment", "help", "json"] as const;
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  "active-agent complete": ["harness-id", "outcome", "run-id"],
  "active-agent fail": ["harness-id", "run-id", "summary"],
  "active-agent get": ["run-id"],
  "active-agent heartbeat": ["harness-id", "run-id"],
  "active-agent list": [],
  "active-agent restart": ["failed-run-id", "harness-id", "run-id"],
  "active-agent start": [
    "agent-key",
    "harness-id",
    "parent-run-id",
    "run-id",
    "task-id",
  ],
  "active-agent sweep": [],
  "agent get": ["key"],
  "agent list": [],
  "error get": ["key"],
  "error list": [],
  "error report": ["input"],
  "error resolve": ["key", "resolution"],
  help: [],
  init: ["apply", "expected-plan-digest", "plan"],
  providers: [],
  "resource get": ["key"],
  "resource list": [],
  "task get": ["id"],
  "task list": ["status"],
  validate: [],
};

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<JsonValue> {
  const parsed = parseArguments(argv);
  const [family, action] = parsed.positionals;
  validateFlags(
    family === undefined || family === "help" || parsed.flags.help === true
      ? "help"
      : [family, action].filter((value) => value !== undefined).join(" "),
    parsed.flags,
  );
  if (family === undefined || family === "help" || parsed.flags.help === true)
    return { help: HELP };
  if (family === "providers")
    return {
      providers: [{ connectionSecret: "NOTION_TOKEN", type: "notion" }],
    };

  const configuration = await loadEnvironment(parsed.flags.environment, env);
  const provider = providerFor(configuration, env);
  const coordinator = new AgentCoordinator(provider);

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
          failedRunId: requiredFlag(parsed.flags, "failed-run-id"),
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
  readonly flags: Readonly<Record<string, boolean | string>>;
  readonly positionals: readonly string[];
}
function validateFlags(
  command: string,
  flags: Readonly<Record<string, boolean | string>>,
): void {
  const commandFlags = COMMAND_FLAGS[command];
  if (commandFlags === undefined) return;
  const allowed = new Set([...GLOBAL_FLAGS, ...commandFlags]);
  for (const name of Object.keys(flags))
    if (!allowed.has(name))
      throw new Error(`Flag --${name} is not allowed for ${command}`);
}
function parseArguments(argv: readonly string[]): ParsedArguments {
  const flags: Record<string, boolean | string> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals !== -1) {
      flags[value.slice(2, equals)] = value.slice(equals + 1);
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else flags[name] = true;
  }
  return { flags, positionals };
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
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
