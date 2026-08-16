# Getting started and CLI

## Install and build

Agent Task Manager requires Node.js 22 or newer and pnpm 11.

```powershell
pnpm install
pnpm check
pnpm build
node dist/src/cli.js --help
```

To expose the built CLI globally from this source checkout:

```powershell
pnpm link --global
agent-task-manager --help
```

The link targets `dist`; run `pnpm build` after source changes before using
the global command.

## Notion onboarding

1. Create a Notion internal integration and put its token in the local
   `NOTION_TOKEN` environment variable.
2. Create or choose one bootstrap parent page, then share that page and any
   existing managed databases with the integration.
3. Copy `agent-task-manager.environment.example.json` to
   `agent-task-manager.environment.json` and replace the placeholder
   `bootstrapParent` URL.
4. Leave table IDs `null` only for tables the authorized `init` command should
   create. Otherwise use stable Notion database or data-source IDs.
5. Validate or plan before authorizing any write.

```powershell
$env:NOTION_TOKEN = "..."
Copy-Item agent-task-manager.environment.example.json agent-task-manager.environment.json
pnpm build
node dist/src/cli.js validate --config agent-task-manager.environment.json
node dist/src/cli.js init --plan --json --config agent-task-manager.environment.json
```

Configuration describes the environment only. Keep credentials in environment
variables or an external secret store; `provider.connection` contains only the
environment-variable name. The real default configuration file is ignored by
Git and must never contain credentials. The tracked example's empty
`effects.settings` is illustrative and cannot run tool-enabled handlers until a
host supplies validated environment-specific settings.

## Workspace commands

Planning is read-only. Applying initialization or an additive migration is a
human-authorized operation requiring the exact SHA-256 digest returned by a
fresh plan.

```powershell
node dist/src/cli.js providers
node dist/src/cli.js validate [--json] [--config <path>]
node dist/src/cli.js init --plan --json [--config <path>]
node dist/src/cli.js init --apply --expected-plan-digest <sha256> [--write-environment] [--config <path>]
node dist/src/cli.js migrate --plan --json [--config <path>]
node dist/src/cli.js migrate --apply --expected-plan-digest <sha256> [--write-environment] [--config <path>]
node dist/src/cli.js inspect --task <task-id> --json [--config <path>]
node dist/src/cli.js inspect --agent <definition-id> --json [--config <path>]
node dist/src/cli.js inspect --lease <lease-id> --json [--config <path>]
node dist/src/cli.js candidates --agent <definition-id> --json [--config <path>]
node dist/src/cli.js assignment prepare --agent <definition-id> --task <task-id> --operation-key <stable-key> --json [--config <path>]
node dist/src/cli.js assignment complete --operation-key <stable-key> --completion <json-path|-> --json [--config <path>]
node dist/src/cli.js reconcile activity --agent <definition-id> --json [--config <path>]
node dist/src/cli.js reconcile human --task <task-id> --slot <sha256> --json [--config <path>]
node dist/src/cli.js reconcile lease --lease <lease-id> --owner <owner-id> --expected-version <sha256> --json [--config <path>]
```

`providers` is configuration-free and prints the built-in provider types
without contacting a provider. Commands that accept `--config` default to
`agent-task-manager.environment.json`.

Apply stores provider-backed step intents and receipts around every mutation.
Once Resources exists, the full authorized bootstrap session can resume after
interruption. `--write-environment` atomically fills only the four table IDs
after the provider schema verifies ready; otherwise the proposed patch is
printed and recorded for a human.

`inspect` is read-only. The three `reconcile` forms perform only the named
repair:

- activity derives `Status` and `Working On` from live leases;
- human reconciliation consumes one already-completed slot; and
- lease reconciliation releases one exact lease/owner/version tuple.

`candidates` is a read-only provider-defined Task selection snapshot.
`assignment prepare` acquires the exact Task and Agent leases and returns an
immutable, digest-bound context. A ChatGPT Scheduled Task or another external
harness performs the role, creates child agents when needed, and executes any
approved external effects. `assignment complete` validates the harness result
and ordered effect attestations, applies the provider-defined outcome, and
releases the leases. The CLI never calls a model endpoint.

Operational CLI commands currently support Notion environments. Provider-neutral
library APIs remain available for other provider integrations. See the
[external harness workflow](external-harness.md) for the complete handshake.

Inspect a lease before releasing it. A concurrent renewal changes its opaque
version and makes the compare-and-set fail. Released snapshots remain
inspectable until the same logical lease slot is reacquired, while active
projections always exclude released snapshots.
