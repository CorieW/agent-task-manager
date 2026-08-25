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
Set `AGENT_TASK_MANAGER_ENVIRONMENT` to use a configuration file outside the
default `agent-task-manager.environment.json`. The example configuration names
`NOTION_TOKEN` as the Notion integration-token environment variable; a token is
required when using the Notion provider.

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

See the [documentation index](docs/README.md) for configuration, lifecycle,
security, and provider details.

## Development

Development requires pnpm 11 in addition to Node.js 22 or newer.

```powershell
pnpm install
pnpm check
pnpm build
```

## Releasing

For a user-facing change, run `pnpm changeset`, choose the semantic version
bump, and commit the generated file. When changesets reach `main`, [the release
workflow](.github/workflows/release.yml) opens or updates a version pull request.
Merging that pull request runs all checks, publishes the package, creates its
Git tag and GitHub Release, and updates its changelog.

Publishing uses npm trusted publishing with GitHub OIDC instead of an npm token;
npm generates provenance automatically. The `id-token: write` permission is
limited to the publish job.

npm requires a package to exist before a trusted publisher can be attached, so
the initial version must be bootstrapped once from a clean `main` checkout by a
maintainer using 2FA. Then configure the publisher with npm 11.15 or newer:

```powershell
npm trust github @corie_w/agent-task-manager `
  --repo CorieW/agent-task-manager `
  --file release.yml `
  --env npm `
  --allow-publish
```

After verifying the first automated release, disallow token-based publishing in
the package settings on npm.

## Contributing

Contributions are welcome. For substantial or breaking changes, open an issue
first to agree on the approach. Keep pull requests focused, add or update tests,
run `pnpm changeset` for user-facing changes, and run `pnpm check` before
submitting.
