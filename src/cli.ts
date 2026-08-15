#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseEnvironmentConfig, type EnvironmentConfig } from "./config/environment.js";
import { canonicalize } from "./core/canonical-json.js";
import { sha256 } from "./core/digest.js";
import { assertAuthorizedPlan } from "./core/migration-plan.js";
import { toJsonValue, type JsonObject, type JsonValue } from "./domain/json.js";
import type { TableKind } from "./domain/provider.js";
import { NotionProvider } from "./provider/notion/notion-provider.js";
import { createNotionWorkspaceSchema } from "./provider/notion/notion-schema.js";
import { NotionHttpTransport } from "./provider/notion/notion-transport.js";

const HELP = `Agent Task Manager

Usage:
  agent-task-manager validate [--json] [--config <path>]
  agent-task-manager init --plan [--json] [--config <path>]
  agent-task-manager init --apply --expected-plan-digest <sha256> [--write-environment]
  agent-task-manager migrate --plan [--json] [--config <path>]
  agent-task-manager migrate --apply --expected-plan-digest <sha256> [--write-environment]
  agent-task-manager providers

Planning and validation are read-only. Schema apply is human-only and requires
the exact digest of a freshly recomputed plan.
`;

function configPath(args: readonly string[]): string {
  const index = args.indexOf("--config");
  if (index === -1) return "agent-task-manager.environment.json";
  const value = args[index + 1];
  if (value === undefined) throw new Error("--config requires a path");
  return value;
}

async function loadConfig(path: string): Promise<ReturnType<typeof parseEnvironmentConfig>> {
  const raw = await readFile(path, "utf8");
  return parseEnvironmentConfig(JSON.parse(raw) as JsonValue);
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function notionProvider(config: EnvironmentConfig): NotionProvider {
  if (config.provider.type !== "notion") throw new Error(`Command requires the notion provider, received ${config.provider.type}`);
  const variable = config.provider.connection.authEnvironmentVariable;
  if (typeof variable !== "string" || variable.trim() === "") throw new Error("provider.connection.authEnvironmentVariable must name the Notion token environment variable");
  const token = process.env[variable];
  if (token === undefined || token === "") throw new Error(`Required environment variable is not set: ${variable}`);
  return new NotionProvider({
    environment: config.provider,
    environmentId: config.environmentId,
    target: createNotionWorkspaceSchema(),
    transport: new NotionHttpTransport({ token }),
  });
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "providers") {
    process.stdout.write("memory\nnotion\n");
    return 0;
  }

  if (command === "validate") {
    const config = await loadConfig(configPath(args));
    if (config.provider.type !== "notion") {
      const output = { environmentId: config.environmentId, provider: config.provider.type };
      if (args.includes("--json")) process.stdout.write(`${JSON.stringify(output)}\n`);
      else process.stdout.write(`Environment ${output.environmentId} uses ${output.provider}.\n`);
      return 0;
    }
    const provider = notionProvider(config);
    const environment = await provider.validateEnvironment(config.provider);
    if (!environment.valid) throw new Error(environment.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    const report = await provider.validateTables();
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
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(output)}\n`);
    else process.stdout.write(`Workspace ${output.state}; observed ${output.observedSchemaDigest}; target ${output.targetSchemaDigest}.\n`);
    return report.state === "ready" ? 0 : 1;
  }

  if (command === "init" || command === "migrate") {
    const planning = args.includes("--plan");
    const applying = args.includes("--apply");
    if (planning === applying) throw new Error(`${command} requires exactly one of --plan or --apply`);
    const path = configPath(args);
    const raw = await readFile(path, "utf8");
    const config = parseEnvironmentConfig(JSON.parse(raw) as JsonValue);
    const provider = notionProvider(config);
    const target = createNotionWorkspaceSchema();
    const observed = await provider.inspectWorkspaceSchema();
    const mode = command === "init" ? "bootstrap" : "migration";
    const plan = await provider.planWorkspaceChanges({ environmentId: config.environmentId, mode, observed, target });
    if (planning) {
      process.stdout.write(`${args.includes("--json") ? `${canonicalize(toJsonValue(plan))}\n` : `Plan ${plan.digest}\n${plan.steps.map((step) => `- ${step.kind}: ${step.id}`).join("\n")}\n`}`);
      return 0;
    }
    const expectedDigest = option(args, "--expected-plan-digest");
    assertAuthorizedPlan(plan, expectedDigest);
    for (const step of plan.steps) await provider.applyWorkspaceStep(step);
    const verified = await provider.validateTables();
    if (verified.state !== "ready") throw new Error(`Authorized ${command} did not converge: ${verified.state}`);
    const startingFileDigest = sha256(raw);
    const tablePatch = provider.workspaceManager().configuredTablePatch();
    await provider.workspaceManager().recordEnvironmentPatch(startingFileDigest, "pending_human");
    if (args.includes("--write-environment")) {
      await writeEnvironmentPatch(path, raw, config.raw, tablePatch);
      await provider.workspaceManager().recordEnvironmentPatch(startingFileDigest, "applied");
    }
    process.stdout.write(`${canonicalize(toJsonValue({ environmentPatch: { provider: { tables: tablePatch } }, planDigest: plan.digest, state: "ready" }))}\n`);
    return 0;
  }

  process.stderr.write(`Command is not implemented yet: ${command}\n`);
  return 2;
}

async function writeEnvironmentPatch(
  path: string,
  startingRaw: string,
  rawConfig: JsonObject,
  tables: Readonly<Record<TableKind, string>>,
): Promise<void> {
  const absolute = resolve(path);
  if (sha256(await readFile(absolute, "utf8")) !== sha256(startingRaw)) throw new Error("Environment file changed after planning");
  const provider = jsonObject(rawConfig.provider, "provider");
  const next = { ...rawConfig, provider: { ...provider, tables } };
  const temporary = resolve(dirname(absolute), `.agent-task-manager-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
}

function jsonObject(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
