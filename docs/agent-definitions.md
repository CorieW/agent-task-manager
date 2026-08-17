# Agent definitions

Each row in Agents is authoritative for one logical role. Its page contains
exactly one `## Agent definition` heading followed by one JSON code block.
The JSON is a closed `agent-definition-v1` manifest; its logical `id` is
independent of the provider row ID. `Name`, `Enabled`, `Revision`, and `Model`
must match their row properties.

Role responsibilities and operational boundaries belong in the prompt
Resources referenced by `promptResources`. Do not duplicate them in Agent
table properties: prompt bodies are the digest-bound authority supplied to the
model at dispatch. In Notion, prompt Resources are native enhanced Markdown
beginning with `## Resource body`; the adapter validates a safe readable
subset and reconstructs the same canonical text used by the Resource digest.

```json
{
  "schema": "agent-definition-v1",
  "id": "security-auditor",
  "name": "Security Auditor",
  "enabled": true,
  "humanResolutionOutcomes": ["blocked"],
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
  "requiredProviderCapabilities": ["stableRecordIds"],
  "allowedIntents": ["error.upsert", "task.status.transition"],
  "transitions": {
    "succeeded": "Security Review Complete",
    "blocked": "Needs Human Resolution"
  },
  "retry": { "maxAttempts": 1, "noVerdict": "block" }
}
```

## Invocation, selection, and transitions

Invocation modes are `manual`, `event`, and `scheduled`. Scheduled definitions
must reference an `invocation-schedule-v1` Resource.

Selection mode is `coordinator`, `self`, or `explicit`. Coordinators require
`dispatch.coordinate`. Accepted assignment sources are `coordinator`, `self`,
and `explicit`; `no_work` is a selection result, not a role or selection mode.
Transitions contain provider-defined Task statuses or `$current`.

`humanResolutionOutcomes` lists outcomes that must create a durable Error and
resolution slot before transition. The manager never infers this authority
from a role or status name.

The optional `requiredIntentSequenceByOutcome` field binds selected outcomes
to ordered intent subsequences. Each key must name a declared transition
outcome, and every listed intent must also appear in `allowedIntents`. A result
for that outcome is invalid unless its proposed intents contain the configured
sequence in order. Other authorized intents may appear before, between, or
after the required intents.

For example, a Coder that must publish every successful repository change can
declare:

```json
{
  "schema": "agent-definition-v1",
  "requiredIntentSequenceByOutcome": {
    "succeeded": [
      "git.commit",
      "git.push",
      "publication.draft_pr",
      "task.github_link.record"
    ]
  }
}
```

The external harness executes proposed external effects in order and submits
one `applied` attestation for each before asking the CLI to route the outcome.
Manager-owned `task.plan.publish` and `task.github_link.record` intents are
applied to the Task during routing and receive no external attestation. A
missing or out-of-order required intent or external attestation leaves the Task
in its current state.

Provider capability requirements use exact `ProviderCapabilities` property
names. A bare name, such as `stableRecordIds`, requires that boolean
capability to be `true`. A `name=value` requirement performs exact string
matching, such as `leases=advisory`; unknown names fail activation. Supported
names are `archive`, `attachments`, `conditionalWrites`,
`deterministicPagination`, `idempotencyLookup`, `leases`,
`managedContent`, `relations`, `schemaDiscovery`, `schemaMutation`, and
`stableRecordIds`. The exact enum values are defined by
`ProviderCapabilities`.

## Task query Resources

A referenced query has kind `task-query` and a closed `task-query-v1` body:

```json
{
  "schema": "task-query-v1",
  "predicate": { "status": "Security Review" },
  "dependencySatisfiedStatuses": ["Done"],
  "limit": 25
}
```

Predicate fields use exact scalar equality. `status` additionally accepts a
non-empty list of up to 20 unique status names, which matches a Task whose
status is any listed value. This lets a coordinator cover several authorized
workflow stages without making unapproved stages eligible.

Selection and output Resources have kind `json-schema` and recursively closed
object schemas. Prompt, input, query, schedule, and schema dependencies resolve
transitively and are digest-bound.

## Bounds and activation

- Candidate limits cannot exceed 100.
- Resolved context cannot exceed 10 MB or `contextBudgetBytes`, whichever is
  lower.
- Retry attempts cannot exceed five.
- Deadlines cannot exceed 86,400 seconds.
- Output schemas support the closed object/array/string/number/integer/boolean/
  null subset with const, enum, bounded constraints, and
  `allOf`/`anyOf`/`oneOf`.
- Regex patterns, references, formats, and unknown schema keywords are rejected.

Activation verifies the runner, model/reasoning pair, provider capabilities,
role capabilities, intents, Resources, query, schedule, and every transition
status. A coordinator can target only definitions in the immutable activated
catalog supplied for that selection turn.
