/** Declarative CLI syntax and argument parsing. */

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
export const HELP = `agent-task-manager

Commands:
${COMMAND_SPECS.map((spec) => `  ${spec.usage}`).join("\n")}

Global flags:
  --environment FILE   Configuration file (default: AGENT_TASK_MANAGER_ENVIRONMENT or agent-task-manager.environment.json)
  --json               Accepted for compatibility; output is always JSON.
`;

/** Parsed CLI tokens split by their dispatch role. */
export interface ParsedArguments {
  /** Executable and arguments passed unchanged to the command broker. */
  readonly commandArguments: readonly string[];
  /** Parsed long flags keyed without their leading `--`. */
  readonly flags: Readonly<Record<string, boolean | string>>;
  /** Positional tokens that identify the command family and action. */
  readonly positionals: readonly string[];
}

/** Rejects flags outside the selected command's allowlist. */
export function validateFlags(
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
export function parseArguments(argv: readonly string[]): ParsedArguments {
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
    if (
      positionals.length === 2 &&
      positionals[0] === "command" &&
      positionals[1] === "proxy" &&
      !value.startsWith("--")
    ) {
      commandArguments = argv.slice(index);
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
