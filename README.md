# Agent Task Manager

Agent Task Manager is provider-neutral infrastructure for task-driven AI
sub-agents. Deterministic code owns provider access, leases, validation, side
effects, and recovery; sub-agents receive bounded context and return typed
proposals.

Authoritative data is restricted to four provider table types: Tasks,
Sub-agents, Errors, and Resources. Local files are environment configuration or
disposable runtime artifacts—not workflow storage. Notion is the first concrete
provider.

## Development

```powershell
pnpm install
pnpm check
pnpm build
node dist/src/cli.js --help
```

Node.js 22 or newer and pnpm 11 are required.

## Notion setup

1. Create a Notion internal integration and copy its token into a local
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
Git and must never contain credentials.

## Workspace commands

Planning is read-only. Applying an initialization or additive migration is a
human-authorized operation and requires the exact SHA-256 digest returned by a
fresh plan.

```powershell
node dist/src/cli.js init --plan --json [--config <path>]
node dist/src/cli.js init --apply --expected-plan-digest <sha256> [--write-environment] [--config <path>]
node dist/src/cli.js migrate --plan --json [--config <path>]
node dist/src/cli.js migrate --apply --expected-plan-digest <sha256> [--write-environment] [--config <path>]
```

Apply writes provider-backed step intents and receipts before and after each
mutation. Once Resources exists, it also records the full authorized bootstrap
session so the same digest can resume after interruption. `--write-environment`
atomically fills the four table IDs in the local environment file after the
provider schema verifies ready; without it, the proposed patch is printed and
recorded for a human to apply.

The v1 Notion adapter is a single-host implementation. Its local mutex prevents
overlap only inside one Node.js process; deploy exactly one manager instance per
environment until a provider-backed distributed run lock is implemented.

## Managed Notion schema

The manager validates these provider-owned names and types. Extra properties
are tolerated; a missing compatible property can be added only by an authorized
workspace apply, while incompatible or destructive drift fails closed.

| Table | Required properties |
| --- | --- |
| Tasks | `Task` title; `Status` select; optional managed `Priority` number, self-relation `Blocked By`, and `Issue / PR` URL |
| Sub-agents | `Name` title; `Enabled` checkbox; `Revision`, `Model` rich text; `Status` select; `Working On` Tasks relation; `Last Run` last-edited time |
| Errors | `Error` title; `Error Key` rich text; `Severity` select; `Task` and `Sub-agent` relations; optional `Run ID` rich text |
| Resources | `Resource` title; `Kind`, `State` select; `Version`, `Digest`, `Dependencies` rich text |

Provider-managed page bodies use exact level-two headings:

- Sub-agent definitions: `## Sub-agent definition`
- Resources and internal journals: `## Resource body`
- Errors: `## Error Description` and `## Error Resolution`

Resource keys beginning with `system/` are reserved for manager-owned schema,
intent, lease, bootstrap-session, and recovery records. User resources must not
use that namespace.

`Status` and `Working On` are independent projections: `Status` is `Online` if
and only if the sub-agent owns an active run lease, while `Working On` contains
exactly its active task leases. The manager exhausts paginated relation values
before comparing or replacing either projection.

## Authoring Sub-agent definitions

Each Sub-agents row is authoritative for one logical role. Its page contains
exactly one `## Sub-agent definition` heading followed by one JSON code block.
The JSON is a closed `sub-agent-definition-v1` manifest; the logical `id` is
independent of the provider row ID. `Name`, `Enabled`, `Revision`, and `Model`
must exactly match their row properties.

```json
{
  "schema": "sub-agent-definition-v1",
  "id": "security-auditor",
  "name": "Security Auditor",
  "enabled": true,
  "revision": 1,
  "model": "gpt-5.6-sol",
  "reasoning": "high",
  "runnerProfile": "read-only",
  "priority": 40,
  "maxConcurrency": 1,
  "maxAssignmentsPerRun": 1,
  "maxAssignmentDepth": 2,
  "deadlineSeconds": 1800,
  "contextBudgetBytes": 250000,
  "invocation": { "mode": "manual", "scheduleResource": null },
  "selection": {
    "mode": "self",
    "acceptsAssignmentsFrom": ["self", "explicit"],
    "taskQueryResource": "query/security-review",
    "resultSchema": "schema/task-selection-result-v1",
    "maxCandidateSummaries": 25
  },
  "promptResources": ["prompt/security-auditor"],
  "inputResourceSelectors": ["policy/security"],
  "outputSchema": "schema/security-audit-result-v1",
  "capabilities": ["repository.read"],
  "prohibitedCapabilities": ["repository.write"],
  "requiredProviderCapabilities": ["leases=atomic"],
  "allowedIntents": ["error.upsert", "task.status.transition"],
  "transitions": { "succeeded": "Security Review Complete", "blocked": "Needs Human Resolution" },
  "retry": { "maxAttempts": 1, "noVerdict": "block" }
}
```

Allowed invocation modes are `manual`, `event`, and `scheduled`; scheduled
definitions must reference an `invocation-schedule-v1` Resource. Selection mode
is `coordinator`, `self`, or `explicit`. Coordinators require
`dispatch.coordinate`. Assignment sources are `coordinator`, `self`, and
`explicit`; `no_work` is a selection result, not a role or selection mode.
Transitions use provider-defined Task status names or `$current`.

The referenced query Resource has kind `task-query` and a closed body such as:

```json
{
  "schema": "task-query-v1",
  "predicate": { "status": "Security Review" },
  "dependencySatisfiedStatuses": ["Done"],
  "limit": 25
}
```

Selection and output Resources have kind `json-schema` and must be recursively
closed object schemas. Prompt, input, query, schedule, and schema dependency
graphs are resolved transitively, digest-bound, and collectively limited by
`contextBudgetBytes`. Candidate limits cannot exceed 100, context cannot exceed
10 MB, and deadlines cannot exceed 86,400 seconds. The manager activates a
definition only when its runner, model/reasoning pair, capabilities, intents,
provider requirements, Resources, query, schedule, and transition statuses all
verify. A coordinator can target only definitions in the immutable activated
catalog supplied for that selection turn.

## Public API

The package root exports the provider-neutral contracts, deterministic planning
and scheduling primitives, and the complete Notion adapter surface:

- `AgentTaskProvider`, `ProviderRegistry`, and `InMemoryProvider`
- Definition APIs: `parseSubAgentDefinitionManifest`,
  `validateSubAgentDefinition`, `validateDefinitionSet`, `resolveDefinition`,
  `activateDefinitions`, and `compileCapabilityGrant`
- Selection APIs: task-query/candidate helpers, `prepareSelection`,
  `promoteSelection`, explicit-assignment helpers, and `routeOutcome`
- `runFoundationDryRun`, selection-result helpers, source-aware invocation
  scheduling, pagination, canonical JSON, migration plans, and schema comparison
- `NotionProvider`, `NotionHttpTransport`, `NotionWorkspaceReader`,
  `NotionWorkspaceManager`, `NotionPageStore`, `NotionRecordReader`, and
  `NotionStateStore`

```ts
import {
  InMemoryProvider,
  runFoundationDryRun,
  type ProviderEnvironment,
  type WorkspaceSchemaDescriptor,
} from "agent-task-manager";

declare const environment: ProviderEnvironment;
declare const target: WorkspaceSchemaDescriptor;

const provider = new InMemoryProvider(environment, target);
const report = await runFoundationDryRun({
  activeRuns: {},
  dueScheduledDefinitionIds: [],
  environment,
  environmentId: "local-demo",
  invocationSource: "manual",
  provider,
  scheduleLimit: 1,
  target,
});
```

The dry run is a library API. It may read provider state but does not apply
schema steps, mutate Tasks, or acquire leases.
