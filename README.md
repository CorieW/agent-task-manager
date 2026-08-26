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

## Installation

Node.js 22 or newer is required. Install the CLI globally:

```powershell
npm install --global @corie_w/agent-task-manager
agent-task-manager help
```

Install the package locally instead when using its exported coordinator and
provider APIs:

```powershell
npm install @corie_w/agent-task-manager
```

## Configuration

Create `agent-task-manager.environment.json` from the included
[`agent-task-manager.environment.example.json`](agent-task-manager.environment.example.json).
Each environment selects an importable provider module and passes it opaque
JSON options. Set `AGENT_TASK_MANAGER_ENVIRONMENT` to use a configuration file
outside the default location. The example selects the bundled Notion adapter;
replace its module and options to use any adapter implementing the provider
module contract.

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

Every command emits JSON. Run `agent-task-manager help` for complete usage.

See the [documentation index](docs/README.md) for configuration, provider-module
development, lifecycle, security, and adapter details.

## Contributing

Found a bug or have a feature request? Open a
[GitHub issue](https://github.com/CorieW/agent-task-manager/issues).
Contributions are welcome.
