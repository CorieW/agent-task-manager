# Agent Task Manager

Single-host coordination for disposable, task-driven AI agents. Notion stores project Tasks, Agent definitions, reusable Prompt and Policy Resources, Active Agent metadata, and Errors. The external harness owns conversations, tools, commands, publications, effects, repeat safety, and child processes.

If a run fails, its failed subtree is restarted from the beginning. The manager deliberately stores no transcript, command history, lease, checkpoint, effect receipt, or resumable conversation state.

## Requirements

- Node.js 22 or newer
- pnpm 11
- A Notion integration token when using the Notion provider

## Commands

```text
task list|get
agent list|get
resource list|get
active-agent list|get|start|heartbeat|complete|fail|sweep|restart
command proxy -- COMMAND [ARGUMENT...]
error list|get|report|resolve
validate
init --plan|--apply
providers
```

Every command emits JSON. Set `AGENT_TASK_MANAGER_ENVIRONMENT` or pass `--environment`; the default is `agent-task-manager.environment.json`. For Notion, place the token in the environment variable named by `provider.connection.tokenEnv` (default `NOTION_TOKEN`).

Agent commands additionally require `AGENT_TASK_MANAGER_COMMAND_BROKER` to name an absolute trusted sandbox-broker executable. The trusted harness must inject the current run through `AGENT_TASK_MANAGER_COMMAND_RUN_ID` and `AGENT_TASK_MANAGER_COMMAND_HARNESS_ID`; these values must not be controllable by the Agent. The manager authorizes requests but never spawns Agent-requested executables directly.

## Development

```powershell
pnpm install
pnpm check
pnpm build
node dist/src/cli.js help
```

The tracked Management v2 migration is digest-authorized:

```powershell
pnpm migrate:management-v2 -- --plan
pnpm migrate:management-v2 -- --apply --expected-plan-digest <sha256>
```

The migration targets only [Management v2](https://app.notion.com/p/Management-v2-3bf9a6efcd5880eeaf0edef3125a1534) and aborts on inventory or schema drift. It intentionally creates no backup.

See [the documentation index](docs/README.md) for lifecycle and provider details.
