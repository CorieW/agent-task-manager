# Agent Task Manager

Agent Task Manager is a provider-neutral orchestration service for task-driven
AI sub-agents. Deterministic code owns provider access, leases, validation,
side effects, and recovery; sub-agents receive bounded context and return typed
proposals.

The initial implementation is under active development. Its durable model is
restricted to four provider table types: Tasks, Sub-agents, Errors, and
Resources. Local files are configuration or disposable runtime artifacts, not
authoritative workflow storage.

## Development

```powershell
pnpm install
pnpm check
pnpm build
node dist/src/cli.js --help
```

Node.js 22 or newer and pnpm 11 are required.

## Environment configuration

The CLI reads `agent-task-manager.environment.json` by default, or another path
passed with `--config`. Copy the tracked
`agent-task-manager.environment.example.json` to begin. The four table values
may be `null` only while a provider workspace is awaiting bootstrap; runtime
execution requires stable IDs for all four tables.

```powershell
Copy-Item agent-task-manager.environment.example.json agent-task-manager.environment.json
node dist/src/cli.js validate
node dist/src/cli.js validate --json --config agent-task-manager.environment.json
```

Configuration describes the environment only. Keep credentials in environment
variables or an external secret store and put only variable names or secret
references in `provider.connection`. The real default configuration file is
ignored by Git and must never contain committed credentials.
