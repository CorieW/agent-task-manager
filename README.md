# Agent Task Manager

Agent Task Manager is a provider-agnostic control boundary between an external
AI-agent harness and a task provider such as Notion. Its JSON CLI validates
which agents may work on which tasks, scopes their resources and commands,
records active runs, protects task updates, routes outcomes, and coordinates
recovery.

The harness owns models, conversations, tools, child processes, repositories,
and external effects. The provider remains the source of truth for Tasks,
Agent definitions, Resources, Active Agents, and Errors. Agent Task Manager
connects the two; it does not run models or execute agent tools.

```text
External harness  →  Agent Task Manager  ↔  Task provider
```

## Requirements

- Node.js 22 or newer
- pnpm 11
- A Notion integration token when using the Notion provider

## Getting started

```powershell
pnpm install
pnpm build
Copy-Item agent-task-manager.environment.example.json agent-task-manager.environment.json
node dist/src/cli.js validate
```

Set `AGENT_TASK_MANAGER_ENVIRONMENT` to use a configuration file outside the
default `agent-task-manager.environment.json`. The example configuration names
`NOTION_TOKEN` as the Notion integration-token environment variable.

The trusted harness must also provide:

- `AGENT_TASK_MANAGER_COORDINATION_DIRECTORY`: a protected absolute directory
  for manager lock files.
- `AGENT_TASK_MANAGER_COMMAND_BROKER`: an absolute path to the trusted sandbox
  broker used by `command proxy`.

## CLI

```text
task list|get
agent list|get
resource list|get
active-agent list|get|start|heartbeat|update-task-section|complete|fail|sweep|restart
command proxy -- COMMAND [ARGUMENT...]
error list|get|report|resolve
validate
init --plan|--apply
providers
```

Every command emits JSON. Run `node dist/src/cli.js help` for complete usage.

See the [documentation index](docs/README.md) for configuration, lifecycle,
security, and provider details.

## Development

```powershell
pnpm install
pnpm check
pnpm build
```

## Contributing

Contributions are welcome. For substantial or breaking changes, open an issue
first to agree on the approach. Keep pull requests focused, add or update tests,
and run `pnpm check` before submitting.
