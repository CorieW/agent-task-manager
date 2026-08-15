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
pnpm exec agent-task-manager --help
```

Node.js 22 or newer and pnpm 11 are required.
