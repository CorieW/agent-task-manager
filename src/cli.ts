#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseEnvironmentConfig } from "./config/environment.js";
import type { JsonValue } from "./domain/json.js";

const HELP = `Agent Task Manager

Usage:
  agent-task-manager validate [--json] [--config <path>]
  agent-task-manager init --plan [--config <path>]
  agent-task-manager migrate --plan [--config <path>]
  agent-task-manager providers

The current foundation validates environment configuration. Provider commands
become available as their adapters are installed.
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

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "providers") {
    process.stdout.write("No external providers are installed yet.\n");
    return 0;
  }

  if (command === "validate") {
    const config = await loadConfig(configPath(args));
    const output = { environmentId: config.environmentId, provider: config.provider.type };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(output)}\n`);
    else process.stdout.write(`Environment ${output.environmentId} uses ${output.provider}.\n`);
    return 0;
  }

  process.stderr.write(`Command is not implemented yet: ${command}\n`);
  return 2;
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
