# Agent Task Manager

Provider-neutral infrastructure for task-driven AI agents. Deterministic
code owns provider access, leases, validation, side effects, and recovery;
agents receive bounded context and return typed proposals.

Authoritative workflow data is restricted to four provider table types:
Tasks, Agents, Errors, and Resources. Configuration describes only the
environment, and local runtime artifacts are disposable. Notion is the first
concrete provider.

## Requirements

- Node.js 22 or newer
- pnpm 11

## Development

```powershell
pnpm install
pnpm check
pnpm build
node dist/src/cli.js --help
```

## Documentation

- [Getting started and CLI](docs/getting-started.md)
- [Notion provider](docs/notion-provider.md)
- [Agent definitions](docs/agent-definitions.md)
- [Runtime security](docs/runtime-security.md)
- [External-effect brokers](docs/external-effects.md)
- [Human interaction and recovery](docs/human-recovery.md)
- [Provider conformance and identification trials](docs/provider-conformance.md)
- [Public API](docs/public-api.md)

See the [documentation index](docs/README.md) for the complete guide set.
