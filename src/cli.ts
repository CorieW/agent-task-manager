#!/usr/bin/env node

/** Implements the bounded CLI for workspace management, external harness assignments, inspection, and recovery. */
import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseEnvironmentConfig,
  type EnvironmentConfig,
} from "./config/environment.js";
import { canonicalize } from "./core/canonical-json.js";
import { sha256 } from "./core/digest.js";
import { assertAuthorizedPlan } from "./core/migration-plan.js";
import { toJsonValue, type JsonObject, type JsonValue } from "./domain/json.js";
import type { TableKind } from "./domain/provider.js";
import {
  completeHarnessAssignment,
  parseHarnessAssignmentCompletion,
  prepareHarnessAssignment,
  prepareHarnessSelection,
} from "./harness/assignment-session.js";
import {
  inspectHumanRecovery,
  inspectLease,
  inspectAgentActivity,
  reconcileActivity,
  reconcileHumanResponse,
  reconcileLease,
} from "./human/inspection.js";
import { NotionProvider } from "./provider/notion/notion-provider.js";
import { createNotionWorkspaceSchema } from "./provider/notion/notion-schema.js";
import { NotionHttpTransport } from "./provider/notion/notion-transport.js";

/** Command-line usage and safety guidance. */
const HELP = `Agent Task Manager

Usage:
  agent-task-manager validate [--json] [--config <path>]
  agent-task-manager init --plan [--json] [--config <path>]
  agent-task-manager init --apply --expected-plan-digest <sha256> [--write-environment] [--config <path>]
  agent-task-manager migrate --plan [--json] [--config <path>]
  agent-task-manager migrate --apply --expected-plan-digest <sha256> [--write-environment] [--config <path>]
  agent-task-manager inspect (--task <task-id> | --agent <definition-id> | --lease <lease-id>) [--json] [--config <path>]
  agent-task-manager candidates --agent <definition-id> [--json] [--config <path>]
  agent-task-manager assignment prepare --agent <definition-id> --task <task-id> --operation-key <stable-key> [--expires-at <iso-timestamp>] [--depth <integer>] [--input <json-path>] [--json] [--config <path>]
  agent-task-manager assignment complete --operation-key <stable-key> --completion <json-path|-> [--json] [--config <path>]
  agent-task-manager reconcile activity --agent <definition-id> [--json] [--config <path>]
  agent-task-manager reconcile human --task <task-id> --slot <sha256> [--json] [--config <path>]
  agent-task-manager reconcile lease --lease <lease-id> --owner <owner-id> --expected-version <sha256> [--json] [--config <path>]
  agent-task-manager providers

Planning and validation are read-only. Schema apply is human-only and requires
the exact digest of a freshly recomputed plan. Inspect is read-only; reconcile
performs only the explicitly named recovery operation.
Candidates is a read-only provider-defined selection snapshot. Assignment
prepare emits immutable context for an external harness; assignment complete
validates the returned result and attestations without invoking a model.
`;

/** Returns the configured environment path or its conventional default. */
function configPath(args: readonly string[]): string {
  /** Position of the config flag in the argument vector. */
  const index = args.indexOf("--config");
  if (index === -1) return "agent-task-manager.environment.json";
  /** Path supplied immediately after the config flag. */
  const value = args[index + 1];
  if (value === undefined) throw new Error("--config requires a path");
  return value;
}

/** Reads and validates an environment configuration file. */
async function loadConfig(
  path: string,
): Promise<ReturnType<typeof parseEnvironmentConfig>> {
  /** Serialized environment file content. */
  const raw = await readFile(path, "utf8");
  return parseEnvironmentConfig(JSON.parse(raw) as JsonValue);
}

/** Returns the value following a required named command-line option. */
function option(args: readonly string[], name: string): string {
  /** Position of the requested option in the argument vector. */
  const index = args.indexOf(name);
  /** Argument supplied immediately after the requested option. */
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

/** Returns the value following an optional named command-line option. */
function optionalOption(
  args: readonly string[],
  name: string,
): string | undefined {
  return args.includes(name) ? option(args, name) : undefined;
}

/** Creates the configured Notion provider using its environment token. */
function notionProvider(config: EnvironmentConfig): NotionProvider {
  if (config.provider.type !== "notion")
    throw new Error(
      `Command requires the notion provider, received ${config.provider.type}`,
    );
  /** Environment-variable name configured to hold the Notion token. */
  const variable = config.provider.connection.authEnvironmentVariable;
  if (typeof variable !== "string" || variable.trim() === "")
    throw new Error(
      "provider.connection.authEnvironmentVariable must name the Notion token environment variable",
    );
  /** Notion authentication token read from the configured environment variable. */
  const token = process.env[variable];
  if (token === undefined || token === "")
    throw new Error(`Required environment variable is not set: ${variable}`);
  return new NotionProvider({
    environment: config.provider,
    environmentId: config.environmentId,
    target: createNotionWorkspaceSchema(),
    transport: new NotionHttpTransport({ token }),
  });
}

/** Executes one command-line operation and returns its process exit code. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  /** Command name selected by the first argument. */
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "providers") {
    process.stdout.write("memory\nnotion\n");
    return 0;
  }

  if (command === "candidates") {
    /** Agent whose provider-defined Task query bounds the candidate set. */
    const agentId = option(args, "--agent");
    /** Environment and provider loaded only after argument validation. */
    const config = await loadConfig(configPath(args));
    /** Ready Notion boundary used for the candidate snapshot. */
    const provider = await readyNotionProvider(config);
    /** Immutable candidate basis returned to the external Task Master harness. */
    const preparation = await prepareHarnessSelection(provider, agentId);
    writeCommandOutput(
      preparation,
      args.includes("--json"),
      `Prepared ${preparation.selection.candidateSet.summaries.length} candidate(s) for ${agentId}.`,
    );
    return 0;
  }

  if (command === "assignment") {
    return assignmentCommand(args);
  }

  if (command === "validate") {
    /** Validated configuration for the environment check. */
    const config = await loadConfig(configPath(args));
    if (config.provider.type !== "notion") {
      /** Provider-neutral validation summary. */
      const output = {
        environmentId: config.environmentId,
        provider: config.provider.type,
      };
      if (args.includes("--json"))
        process.stdout.write(`${JSON.stringify(output)}\n`);
      else
        process.stdout.write(
          `Environment ${output.environmentId} uses ${output.provider}.\n`,
        );
      return 0;
    }
    /** Notion provider used for live validation. */
    const provider = notionProvider(config);
    /** Provider-environment validation result. */
    const environment = await provider.validateEnvironment(config.provider);
    if (!environment.valid)
      throw new Error(
        environment.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("\n"),
      );
    /** Current table-schema validation report. */
    const report = await provider.validateTables();
    /** Canonical JSON validation response. */
    const output = {
      differences: report.differences,
      environmentId: config.environmentId,
      observedSchemaDigest: report.observed.digest,
      provider: config.provider.type,
      providerIdentity: report.observed.providerIdentity,
      state: report.state,
      targetSchemaDigest: report.target.digest,
      targetSchemaVersion: report.target.version,
    };
    if (args.includes("--json"))
      process.stdout.write(`${JSON.stringify(output)}\n`);
    else
      process.stdout.write(
        `Workspace ${output.state}; observed ${output.observedSchemaDigest}; target ${output.targetSchemaDigest}.\n`,
      );
    return report.state === "ready" ? 0 : 1;
  }

  if (command === "inspect") {
    /** Validated configuration for human inspection. */
    const config = await loadConfig(configPath(args));
    /** Notion provider queried by the inspection command. */
    const provider = notionProvider(config);
    /** Whether the Task inspection option was supplied. */
    const hasTask = args.includes("--task");
    /** Whether the agent inspection option was supplied. */
    const hasAgent = args.includes("--agent");
    /** Whether the lease inspection option was supplied. */
    const hasLease = args.includes("--lease");
    if ([hasTask, hasAgent, hasLease].filter(Boolean).length !== 1)
      throw new Error(
        "inspect requires exactly one of --task, --agent, or --lease",
      );
    /** Requested Task, agent, or lease inspection. */
    let inspection;
    if (hasTask) {
      inspection = await inspectHumanRecovery(provider, option(args, "--task"));
    } else if (hasAgent) {
      inspection = await inspectAgentActivity(
        provider,
        option(args, "--agent"),
      );
    } else {
      inspection = await inspectLease(provider, option(args, "--lease"));
    }

    /** Human-readable summary of the inspection result. */
    let summary: string;
    if (inspection === null) {
      summary = "Lease was not found.";
    } else if ("slots" in inspection) {
      summary = `Task ${inspection.taskId} is ${inspection.status}; ${inspection.slots.length} human slot(s).`;
    } else if ("agentId" in inspection && "activity" in inspection) {
      summary = `Agent ${inspection.agentId} activity inspected.`;
    } else {
      summary = `Lease ${inspection.leaseId} inspected.`;
    }
    /** JSON or human-readable inspection response. */
    const output = args.includes("--json")
      ? canonicalize(toJsonValue(inspection))
      : summary;
    process.stdout.write(`${output}\n`);
    return 0;
  }

  if (command === "reconcile") {
    /** Validated configuration for reconciliation. */
    const config = await loadConfig(configPath(args));
    /** Notion provider mutated by the named recovery operation. */
    const provider = notionProvider(config);
    /** Recovery operation selected by the second argument. */
    const operation = args[1];
    /** Result produced by main. */
    let result;
    if (operation === "activity") {
      result = await reconcileActivity(provider, option(args, "--agent"));
    } else if (operation === "human") {
      result = await reconcileHumanResponse(
        provider,
        option(args, "--task"),
        option(args, "--slot"),
      );
    } else if (operation === "lease") {
      result = await reconcileLease(
        provider,
        option(args, "--lease"),
        option(args, "--owner"),
        option(args, "--expected-version"),
      );
    } else {
      throw new Error("reconcile requires activity, human, or lease");
    }
    /** JSON or human-readable reconciliation response. */
    const output = args.includes("--json")
      ? canonicalize(toJsonValue(result))
      : `Reconciliation ${"state" in result ? String(result.state) : "complete"}.`;
    process.stdout.write(`${output}\n`);
    return 0;
  }

  if (command === "init" || command === "migrate") {
    /** Whether the command requests a read-only migration plan. */
    const planning = args.includes("--plan");
    /** Whether the command requests application of an authorized plan. */
    const applying = args.includes("--apply");
    if (planning === applying)
      throw new Error(`${command} requires exactly one of --plan or --apply`);
    /** Environment file used for workspace planning and optional patching. */
    const path = configPath(args);
    /** Original environment file retained for concurrent-change detection. */
    const raw = await readFile(path, "utf8");
    /** JSON-decoded input before structural validation. */
    const config = parseEnvironmentConfig(JSON.parse(raw) as JsonValue);
    /** Notion provider whose workspace schema is being managed. */
    const provider = notionProvider(config);
    /** Canonical Notion workspace schema requested by this version. */
    const target = createNotionWorkspaceSchema();
    /** Bootstrap or migration mode selected by the command name. */
    const mode = command === "init" ? "bootstrap" : "migration";
    /** Workspace manager responsible for durable plan progress. */
    const manager = provider.workspaceManager();
    /** Previously recorded bootstrap or migration session, when present. */
    const session = await manager.readBootstrapSession(mode);
    if (
      session !== null &&
      (session.plan.environmentId !== config.environmentId ||
        session.plan.targetSchemaDigest !== target.digest)
    ) {
      throw new Error(
        "Active workspace session does not match this command or environment",
      );
    }
    /** Provider schema captured before planning or applying changes. */
    const observed = await provider.inspectWorkspaceSchema();
    /** Plan digest supplied by the human for apply authorization. */
    const expectedDigest = applying
      ? option(args, "--expected-plan-digest")
      : null;
    /** Reused or freshly computed workspace migration plan. */
    const plan =
      applying && session?.plan.digest === expectedDigest
        ? session.plan
        : await provider.planWorkspaceChanges({
            environmentId: config.environmentId,
            mode,
            observed,
            target,
          });
    if (planning) {
      process.stdout.write(
        `${args.includes("--json") ? `${canonicalize(toJsonValue(plan))}\n` : `Plan ${plan.digest}\n${plan.steps.map((step) => `- ${step.kind}: ${step.id}`).join("\n")}\n`}`,
      );
      return 0;
    }
    assertAuthorizedPlan(plan, expectedDigest ?? "");
    /** Migration step IDs already recorded as complete. */
    const completed = new Set(
      session?.plan.digest === plan.digest ? session.completedStepIds : [],
    );
    if (
      (await manager.resolveTableIds()).resources !== undefined &&
      completed.size === 0
    ) {
      await manager.recordBootstrapSession(plan, []);
    }
    for (const step of plan.steps) {
      await provider.applyWorkspaceStep(step);
      completed.add(step.id);
      await manager.recordBootstrapSession(plan, [...completed]);
    }
    /** Post-apply table validation report. */
    const verified = await provider.validateTables();
    if (verified.state !== "ready")
      throw new Error(
        `Authorized ${command} did not converge: ${verified.state}`,
      );
    /** Canonical digest of starting file. */
    const startingFileDigest = sha256(raw);
    /** Provider table IDs to merge into the environment file. */
    const tablePatch = manager.configuredTablePatch();
    await manager.recordEnvironmentPatch(startingFileDigest, "pending_human");
    if (args.includes("--write-environment")) {
      await writeEnvironmentPatch(path, raw, config.raw, tablePatch);
      await manager.recordEnvironmentPatch(startingFileDigest, "applied");
    }
    process.stdout.write(
      `${canonicalize(toJsonValue({ environmentPatch: { provider: { tables: tablePatch } }, planDigest: plan.digest, state: "ready" }))}\n`,
    );
    return 0;
  }

  process.stderr.write(`Command is not implemented yet: ${command}\n`);
  return 2;
}

/** Executes the external-harness assignment handshake. */
async function assignmentCommand(args: readonly string[]): Promise<number> {
  /** Assignment phase selected by the external harness. */
  const action = args[1];
  if (action !== "prepare" && action !== "complete")
    throw new Error("assignment requires prepare or complete");
  /** Stable logical key shared by preparation and completion. */
  const operationKey = option(args, "--operation-key");

  if (action === "prepare") {
    /** Agent and Task selected by the external Task Master harness. */
    const agentId = option(args, "--agent");
    /** Exact eligible Task selected by the external Task Master harness. */
    const taskId = option(args, "--task");
    /** Canonical lease expiry supplied explicitly or bounded to two hours. */
    const expiresAt =
      optionalOption(args, "--expires-at") ??
      new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
    assertCanonicalFutureTimestamp(expiresAt, "--expires-at");
    /** Assignment depth propagated by a parent harness, or zero at the root. */
    const depth = Number(optionalOption(args, "--depth") ?? "0");
    if (!Number.isSafeInteger(depth) || depth < 0)
      throw new TypeError("--depth must be a non-negative integer");
    /** Optional trusted input loaded before provider mutation. */
    const inputPath = optionalOption(args, "--input");
    /** Closed JSON input included in the immutable Agent context. */
    const input =
      inputPath === undefined
        ? {}
        : jsonObject(await readJson(inputPath), "assignment input");
    /** Environment and ready provider loaded after all local input validation. */
    const config = await loadConfig(configPath(args));
    /** Validated Notion boundary that owns the assignment lifecycle. */
    const provider = await readyNotionProvider(config);
    /** Prepared assignment or terminal replay returned to the harness. */
    const preparation = await prepareHarnessAssignment({
      agentId,
      assignmentDepth: depth,
      environmentId: config.environmentId,
      expiresAt,
      input,
      operationKey,
      provider,
      taskId,
    });
    writeCommandOutput(
      preparation,
      args.includes("--json"),
      preparation.state === "prepared"
        ? `Prepared ${agentId} assignment for Task ${taskId}.`
        : `Assignment ${operationKey} is already complete.`,
    );
    return 0;
  }

  /** Completion envelope produced after the external harness runs the role. */
  const completion = parseHarnessAssignmentCompletion(
    await readJson(option(args, "--completion")),
  );
  /** Environment and ready provider loaded after completion validation. */
  const config = await loadConfig(configPath(args));
  /** Validated Notion boundary that owns the prepared assignment. */
  const provider = await readyNotionProvider(config);
  /** Terminal provider report after outcome routing and lease cleanup. */
  const report = await completeHarnessAssignment({
    completion,
    environmentId: config.environmentId,
    operationKey,
    provider,
  });
  writeCommandOutput(
    report,
    args.includes("--json"),
    `Completed ${report.agentId} outcome ${report.outcome} for Task ${report.taskId}.`,
  );
  return 0;
}

/** Validates the configured Notion workspace before an operational command. */
async function readyNotionProvider(
  config: EnvironmentConfig,
): Promise<NotionProvider> {
  /** Configured provider initialized without model or harness credentials. */
  const provider = notionProvider(config);
  /** Live provider identity and access validation result. */
  const environment = await provider.validateEnvironment(config.provider);
  if (!environment.valid)
    throw new Error(
      environment.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("\n"),
    );
  /** Required managed-table schema validation result. */
  const tables = await provider.validateTables();
  if (tables.state !== "ready")
    throw new Error(`Workspace is not ready: ${tables.state}`);
  return provider;
}

/** Reads one JSON value from a file, or standard input when the path is `-`. */
async function readJson(path: string): Promise<JsonValue> {
  /** Complete serialized value collected from the selected local input. */
  let raw: string;
  if (path === "-") {
    raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) raw += chunk;
  } else {
    raw = await readFile(path, "utf8");
  }
  return JSON.parse(raw) as JsonValue;
}

/** Writes canonical JSON or a concise human-readable command summary. */
function writeCommandOutput(
  value: unknown,
  json: boolean,
  summary: string,
): void {
  process.stdout.write(
    `${json ? canonicalize(toJsonValue(value)) : summary}\n`,
  );
}

/** Rejects noncanonical or expired timestamps before provider access. */
function assertCanonicalFutureTimestamp(value: string, label: string): void {
  /** Parsed timestamp used for canonical-form and future-bound checks. */
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value ||
    milliseconds <= Date.now()
  )
    throw new TypeError(`${label} must be a canonical future UTC timestamp`);
}

/** Atomically writes provider table IDs into an unchanged environment file. */
async function writeEnvironmentPatch(
  path: string,
  startingRaw: string,
  rawConfig: JsonObject,
  tables: Readonly<Record<TableKind, string>>,
): Promise<void> {
  /** Absolute path of the environment file being patched. */
  const absolute = resolve(path);
  if (sha256(await readFile(absolute, "utf8")) !== sha256(startingRaw))
    throw new Error("Environment file changed after planning");
  /** Existing provider configuration preserved by the patch. */
  const provider = jsonObject(rawConfig.provider, "provider");
  /** Updated environment object containing the discovered table IDs. */
  const next = { ...rawConfig, provider: { ...provider, tables } };
  /** Sibling temporary file used for the atomic replacement. */
  const temporary = resolve(
    dirname(absolute),
    `.agent-task-manager-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Requires a named value to be a non-array JSON object. */
function jsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new TypeError(`${label} must be an object`);
  return value;
}

/** Reports whether this module is the process entry point. */
async function isMainModule(): Promise<boolean> {
  if (process.argv[1] === undefined) return false;
  try {
    return (
      (await realpath(process.argv[1])) ===
      (await realpath(fileURLToPath(import.meta.url)))
    );
  } catch {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  }
}

if (await isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
