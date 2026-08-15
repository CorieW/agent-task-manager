# Notion provider

Notion is the first concrete `AgentTaskProvider`. It maps authoritative state
to four data sources and uses Resources for durable intents, leases, receipts,
bootstrap sessions, and recovery records. No local database is authoritative.

## Managed schema

Extra properties are tolerated. A missing compatible property can be added
only by a digest-authorized workspace apply; incompatible or destructive drift
fails closed.

| Table | Required properties |
| --- | --- |
| Tasks | `Task` title; provider-defined `Status` select; adapter-internal `Manager Mutation` rich text; self-relation `Dependencies`; optional numeric `Priority` |
| Sub-agents | `Name` title; `Enabled` checkbox; numeric `Revision`; `Model` rich text; `Status` select; `Working On` Tasks relation; `Last Run` last-edited time |
| Errors | `Error` title; `Error Key` rich text; `Severity` and `Status` selects; `Task` and `Sub-agent` relations; optional `Run ID` |
| Resources | `Resource` title; `Kind` and `State` selects; `Version`, `Digest`, and `Dependencies` rich text |

Project-specific columns are additive and remain provider data rather than core
role logic. The Perfect Project v4 workspace additionally uses Task governance
fields (`Type`, `Scope`, `Acceptance Criteria`, `GitHub Links`, `Owner`,
`Required Approval`, `Created At`, and `Closed At`), Error
ownership/fix tracking, and Resource ownership/source/review tracking. Its Task
`Status` select carries both active workflow states and terminal outcomes:
`Completed`, `Cancelled`, `Duplicate`, `Not reproducible`, and `Superseded`.
Sub-agent responsibilities and boundaries belong in prompt Resources instead
of duplicate table properties. The adapter tolerates and can round-trip these
extra properties without imposing them on another project.

The Task page body preserves the initial description. When a Task reaches a
terminal status, the responsible role proposes a concise
`## Outcome Summary`; the manager appends it through the accepted Task
mutation without replacing the description or using a separate property.
Error evidence, including relevant GitHub links, belongs in the managed Error
description or resolution body instead of a dedicated property.

Provider-managed page bodies use exact level-two headings:

- Sub-agent definitions: `## Sub-agent definition`
- Resources and internal journals: `## Resource body`
- Errors: `## Error Description` and `## Error Resolution`

`Status` accepts `Not Fixed`, `Fixing`, and `Fixed`. Built-in failure paths
create `Not Fixed`; a later write for the same `Error Key`, using a new
idempotency key bound to the changed payload, may set `Fixing` or `Fixed`.
Humans may apply the same values directly in Notion. Status is part of the
exact write target and crash-reconciliation check.

Resource keys beginning with `system/` are reserved for manager-owned schema,
intent, lease, bootstrap-session, and recovery records.

## Activity projection

`Status` and `Working On` are independent:

- `Status` is `Online` exactly when the Sub-agent owns an active run lease.
- `Working On` contains exactly its active task-assignment leases.

The provider exhausts paginated relation values before comparing or replacing
either projection. `Last Run` is provider-managed metadata, never a lease
timestamp.

## Content and mutation recovery

Notion uses optimistic, verified writes. Task-body changes append immutable,
mutation-digest-marked Markdown generations. The newest valid generation is
authoritative. The adapter-internal `Manager Mutation` property lets recovery
finish an interrupted body-first/property-second update only when the exact
target or original precondition is still visible.

## Transport behavior

`NotionHttpTransport` performs one HTTP request per call and defaults to a
30-second deadline. It does not retry automatically. HTTP failures, caller
aborts, and deadline expiry surface as `NotionApiError`; hosts decide whether
and when to retry using its status, code, and `retryAfterSeconds` evidence.

## Deployment constraint

NotionProvider v1 supports one host. Its in-process queue serializes local
operations, while an exclusive lock file rejects a live writer in another
process sharing the same lock directory and identity and clears a verifiably
stale owner. It does not coordinate across hosts. Deploy one manager host per
environment until a provider-backed distributed run lock with atomic
acquisition is implemented.
