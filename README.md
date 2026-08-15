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
Git and must never contain credentials. The tracked example's empty
`effects.settings` is illustrative and cannot run tool-enabled handlers until a
host supplies validated environment-specific settings.

## Runtime configuration and security boundary

Runtime fields become mandatory before dispatch. Adapter fields are registry
IDs, not package names: `agentRunner`, `modelTransport`, and `sandbox` must
already be registered by the host. The legacy `adapters.publication` field
remains inert; Phase 5 draft publication uses
`effects.handlers["publication.draft_pr"]` instead.

`runtime.root` and every read/write root must be absolute and must not be a
filesystem root. Write roots must be descendants of `runtime.root`. Replace the
tracked Windows placeholders with host paths; a Unix deployment might use
`/var/tmp/agent-task-manager/local-demo` with disposable worktrees beneath it.
`outputLimitBytes` bounds combined streamed output.
`terminationGraceMilliseconds` bounds graceful termination, while
`postKillReapMilliseconds` bounds hard-kill acknowledgement, output closure,
cleanup, cancellation acknowledgement, and session close.

Authority is compiled from environment boundaries and the activated role:

- `repository.read` exposes configured read roots.
- `repository.write` exposes configured read and write roots.
- `network.access` exposes configured HTTP(S) origins.
- `environment.read` exposes configured non-secret environment names.
- Without the corresponding capability, the policy contains no such authority.
  Secret-shaped environment names are rejected.

The core verifies adapter identity, run and policy digests, model/reasoning,
control-plane separation, credential non-exposure, and process-tree enforcement.
The configured `ToolIsolationAdapter` owns actual operating-system enforcement;
placeholder adapter IDs are not built-in adapters, and hosts must not register
adapters that merely assert receipts.

The package includes one concrete, deliberately limited stack:
`NoToolModelTransportAdapter`, `NoToolIsolationAdapter`, and
`NoToolAgentRunnerAdapter`. It supports `runnerProfile: "no-tools"` roles,
rejects all filesystem/environment/network authority, launches no child
process, and streams a trusted model client's result through the bounded
supervisor. Tool-enabled roles require an external enforcing adapter and fail
closed when it is absent.

## Workspace commands

Planning is read-only. Applying an initialization or additive migration is a
human-authorized operation and requires the exact SHA-256 digest returned by a
fresh plan.

```powershell
node dist/src/cli.js init --plan --json [--config <path>]
node dist/src/cli.js init --apply --expected-plan-digest <sha256> [--write-environment] [--config <path>]
node dist/src/cli.js migrate --plan --json [--config <path>]
node dist/src/cli.js migrate --apply --expected-plan-digest <sha256> [--write-environment] [--config <path>]
node dist/src/cli.js inspect --task <task-id> --json [--config <path>]
node dist/src/cli.js inspect --sub-agent <definition-id> --json [--config <path>]
node dist/src/cli.js reconcile activity --sub-agent <definition-id> --json [--config <path>]
node dist/src/cli.js reconcile human --task <task-id> --slot <sha256> --json [--config <path>]
node dist/src/cli.js reconcile lease --lease <lease-id> --owner <owner-id> --json [--config <path>]
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

`inspect` is read-only. The two `reconcile` forms perform only the named
provider-backed repair: activity derives `Status` and `Working On` from live
leases, while human reconciliation consumes one already-completed slot. Neither
command discovers work or dispatches a sub-agent.
The Phase 6 recovery CLI currently supports Notion environments. Other
providers use the provider-neutral library APIs until CLI provider-registry
wiring is added. Lease release requires the exact lease and owner identities;
it never guesses that a live lease is stale.

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
10 MB, retry attempts cannot exceed five, and deadlines cannot exceed 86,400
seconds. Output schemas use the deliberately supported closed subset: object,
array, string, number, integer, boolean, null, const/enum, bounded collection/
string/number constraints, and `allOf`/`anyOf`/`oneOf`. Regex patterns,
references, formats, and unknown keywords are rejected. The manager activates a
definition only when its runner, model/reasoning pair, capabilities, intents,
provider requirements, Resources, query, schedule, and transition statuses all
verify. A coordinator can target only definitions in the immutable activated
catalog supplied for that selection turn.

## Human interaction and recovery

`HumanRecoveryManager` is the workflow helper for requesting or consuming human
authority. It supports provider-neutral `answer`, `resolution`, `review`, and
`testing` slots. Callers supply the provider-defined waiting status and an
action-to-status route map; the manager does not hardcode role names or workflow
statuses.

Each slot is a closed `human-interaction-slot-v1` JSON object inside an exact
`agent-task-manager:human-slot:<sha256>` marker pair in the Task body. Before
exposing a blank response field, the manager stores the immutable baseline as
`human-slot/<slotId>` in Resources. A resolution request additionally creates
or updates its stable Errors row before changing the Task to its waiting status.
Only `response.action` and `response.text` may differ from the baseline.

Consumption verifies the Task edit against that baseline, resolves the action
through the slot's frozen route map, writes a pending
`human-consumption/<slotId>` Resource, conditionally changes Task Status, and
then finalizes the consumption record. Replays return the applied record without
another transition. Pending Notion Task intents resume only when the exact
target is already visible or the original Task version is still current;
otherwise recovery fails closed rather than overwriting newer provider state.

For a response, replace the slot's `null` value with an object whose `action` is
one of its frozen `routes` keys:

```json
"response": {
  "action": "resume",
  "text": "Resolved by updating the required configuration."
}
```

Blank requests are created through `HumanRecoveryManager`; there is no CLI
request command. Workflow hosts must route exceptional blocked outcomes through
`requestResolution`, not directly mutate a waiting status, so the stable Error,
baseline, and blank resolution slot are durable before the status transition.

`inspectHumanRecovery` returns Task status/version/archive state and, for each
slot, its ID, kind, baseline-valid flag, response state, and consumption state.
It does not expose prompt, routes, or response text. Use
`reconcileHumanResponse`, `reconcileActivity`, and `reconcileLease` only as
explicit operator actions. The whole normalized Task body and property
projection are bound into the blank-slot baseline; consumption masks only the
selected response and rejects unrelated changes.

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
- Runtime APIs: `RuntimeAdapterRegistry`, adapter/session/process interfaces,
  `resolveRuntimeEnvironment`, `compileToolIsolationPolicy`, context/result/
  receipt helpers, `assertSupportedJsonSchema`, `superviseProcess`, and
  `dispatchActivatedAgent`
- Safe context-only adapters: `NoToolModelTransportAdapter`,
  `NoToolIsolationAdapter`, and `NoToolAgentRunnerAdapter`
- Effects APIs: `ExternalEffectBroker`, `ProviderEffectJournal`,
  `WorkspaceOwnershipStore`, `ProviderWorkspaceOwnershipStore`,
  `AssignmentEffectAuthority`, `resolveExternalEffectEnvironment`, typed
  handler factories, `LocalGitEffects`, `ConfiguredCommandEffects`,
  `DisposableBrowserEffects`, `DraftPublicationEffects`,
  `ProviderChildAgentWaveEffects`, and their driver contracts
- Human recovery APIs: `HumanRecoveryManager`, slot creation/parsing/rendering
  and allowed-delta verification, `inspectHumanRecovery`,
  `inspectSubAgentActivity`, `reconcileHumanResponse`, `reconcileActivity`, and
  `reconcileLease`

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

### Runtime host integration

Dispatch never accepts raw adapters or caller-authored tool policy. Resolve one
environment-bound runtime, then pass the completed `AssignmentPromotion` from
selection/promotion:

```ts
const runtime = resolveRuntimeEnvironment({
  config,
  modelTransports,
  runners,
  toolIsolations,
});

const result = await dispatchActivatedAgent({
  activated,
  activationRuntime,
  additionalInput: {},
  promotion,
  provider,
  runtime,
});
```

Immediately before launch, dispatch reactivates the definition and Resource
graph; verifies the active, digest-correct assignment intent; checks exact run
and task leases, `Status`, `Working On`, Task version/status, and dependencies;
and recompiles authority. One absolute deadline covers model/isolation
preparation, runner startup, retries, and execution. Only a nonzero process exit
classified as `process_no_verdict` may use the role's bounded retry policy.
Policy violations, invalid receipts/results, timeouts, and cleanup failures do
not retry.

The manager streams output under the configured byte limit and attempts
terminate, kill, reap, output closure, and cleanup on every path. Model and
isolation sessions close after partial preparation and normal completion. Agent
results are proposals only. External effects execute later through the Phase 5
brokers described below; the runtime process never receives provider, Git
publication, browser-control, or child-dispatch authority directly.

### Runtime wire contracts

- `run-context-v1` binds activation/definition digests, the exact Task snapshot,
  Resource bodies and pins, capability grant, input, run ID, and runtime receipt.
- `agent-result-v1` echoes context, definition, and run identities; uses an
  allowed outcome; satisfies the output schema; contains only allowed typed
  intents; and carries the digest of every other result field.
- `runtime-capability-receipt-v1` binds environment, policy, adapter,
  executable, model, reasoning, run, filesystem, network, and environment
  evidence.
- `process-telemetry-v2` reports duration, exit/termination state, byte counts,
  output digests, and a stable tool-violation code. It is trusted runtime
  evidence, not agent-authored output.

### Runtime failure troubleshooting

Failures create or update `agent-runtime:<runId>` in Errors with a stable code
and redacted description. Raw exceptions, paths, adapter output, and credentials
are intentionally not copied into provider content. Inspect trusted host
telemetry and receipts for details. Common classes are stale assignment or Task
basis, invalid adapter receipt, unauthorized tool activity, output limit,
deadline, unacknowledged cancellation, reap/cleanup failure, and invalid result
contract. If Error persistence also fails, the caller receives an
`AggregateError` preserving both failures.

## External-effect brokers

Phase 5 turns authorized `agent-result-v1.proposedIntents` into deterministic,
crash-reconcilable operations. The environment maps each supported intent kind
to one installed handler under `effects.handlers`; adapter-specific repository,
executable, command, browser, publication, and child-runner definitions belong
under `effects.settings`. The host must parse and validate those opaque settings
before constructing `installedHandlers`; `resolveExternalEffectEnvironment`
only binds the already-constructed handlers and hashes their settings. Provider
content can select logical IDs, but cannot introduce paths, executables,
remotes, origins, credentials, or handler implementations.

The built-in intent kinds are:

- `workspace.provision` and `workspace.release` for a configured isolated Git
  worktree or local mirror;
- `git.observe`, `git.branch`, `git.commit`, and `git.push` with immutable head
  preconditions;
- `publication.draft_pr` for an environment-authorized draft target;
- `command.run` for a hash-pinned, replay-safe command definition;
- `browser.run` for an isolated disposable environment with an exact origin
  allowlist; and
- `child_agent.wave` for a bounded acyclic graph of provider-defined child
  roles whose immutable contexts are Resources.

```ts
const effects = resolveExternalEffectEnvironment(config, installedHandlers);
const authority = new AssignmentEffectAuthority(
  activated,
  activationRuntime,
  promotion,
  provider,
);
const broker = new ExternalEffectBroker(
  effects,
  new ProviderEffectJournal(provider),
  authority,
);
const executions = await broker.executeResult(
  dispatchResult.result,
  Date.now() + 60_000,
);
```

Before invoking a handler, the broker stores the complete canonical
`external-effect-intent-v2` in Resources and acquires a provider-backed effect
claim. An `applied` or known `failed` observation receives an
`external-effect-receipt-v1`; `not_applied` authorizes the broker to call
`apply`. An indeterminate observation is persisted without a receipt and blocks
replay until reconciliation can prove the outcome. Live assignment, lease,
Task, role, and Resource authority is revalidated immediately before every
effect. Local files are never the durable journal.

Immediately before invoking `apply`, the broker durably enables automatic
replay blocking on the intent. Only a durably stored terminal `applied` or
`failed` observation clears it. This write-ahead quarantine remains effective
even if the provider becomes unavailable after external execution begins.

Workspace ownership is likewise stored as a provider-backed
`workspace-ownership-v1` Resource and serialized with a provider lease. The
runtime never uses a sidecar file as ownership authority. If a handler does not
acknowledge deadline cancellation, its effect claim remains quarantined until
the configured claim expiry instead of permitting an overlapping retry.

Child waves additionally store one `child-agent-node-intent-v1` Resource per
node. Each node receives only its own immutable context and the receipts of its
declared dependencies. Completed nodes are reused after restart; only missing
or externally reconcilable nodes run again.

### Local Git and command boundaries

`LocalGitEffects` derives workspace paths by hashing the logical workspace key
under the configured runtime root. It verifies a pinned Git executable, an
empty hooks directory, configured repository identities, full revisions, exact
changed paths, commit parent/message, local and remote heads, and configured
remote names. Every Git invocation disables system/global configuration,
optional locks, prompts, credential helpers, fsmonitor, and repository hooks.
Push credentials, if needed, come from a trusted `GitCredentialBroker` and are
never part of an agent payload.

The host must wire provider-backed ownership when it constructs this handler:

```ts
const ownership = new ProviderWorkspaceOwnershipStore(provider);
const git = await LocalGitEffects.create(gitConfig, { ownership });
```

`ConfiguredCommandEffects` accepts only a logical command key. The environment
owns its absolute executable, executable digest, argument prefix, deadline,
output bound, and replay-safe declaration. It launches without a shell or
inherited environment and records only exit status and output digests. Commands
that cannot safely be repeated after an unknown crash outcome must not be
registered.

Browser and publication drivers are provider/vendor-neutral interfaces because
their concrete transport depends on the deployment. A browser driver must
enforce disposable isolation and the configured origin set; a publication
driver must reconcile the exact draft target, repository, branches, and head.
Handlers are unavailable—and role activation must fail closed—until the host
registers those enforcing drivers.

### Intent payloads

All payloads are closed objects. Repository and workspace values are logical
environment IDs; revisions and digests are full immutable hashes.

| Kind | Required fields |
| --- | --- |
| `workspace.provision` | `mode`, `repositoryId`, `sourceRevision`, `workspaceKey` |
| `workspace.release` | `repositoryId`, `workspaceKey` |
| `git.observe` | `repositoryId`, `revision`, `workspaceKey` |
| `git.branch` | `branch`, `expectedHead`, `repositoryId`, `workspaceKey` |
| `git.commit` | `expectedHead`, `message`, nonempty repository-relative `paths`, `repositoryId`, `workspaceKey` |
| `git.push` | `branch`, `expectedLocalHead`, nullable `expectedRemoteHead`, configured `remote`, `repositoryId`, `workspaceKey` |
| `publication.draft_pr` | `baseBranch`, bounded `body`, `expectedHead`, `headBranch`, `publicationTarget`, `repositoryId`, bounded `title` |
| `command.run` | bounded `arguments`, configured `commandKey`, `repositoryId`, `workspaceKey` |
| `browser.run` | configured `environmentKey`, `repositoryId`, `scenarioResource`, `workspaceKey` |
| `child_agent.wave` | `maxConcurrency` (1–32) and an acyclic `nodes` array; every node pins `contextResource`, `contextVersion`, `contextDigest`, `definitionId`, `dependsOn`, and `nodeKey` |
