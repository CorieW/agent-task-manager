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
| Tasks | `Task` title; `Status`, `Resolution`, and `Type` selects; adapter-internal `Manager Mutation`; numeric `Priority`; `Scope`, `Acceptance Criteria`, `GitHub Links`, `Required Approval`, and `Outcome Summary` text; self-relation `Dependencies`; `Owner` people; `Created At` and `Closed At` timestamps |
| Sub-agents | `Name` title; `Enabled` checkbox; `Revision`, `Model`, `Responsibilities`, and `Boundaries` text; `Status` select; `Working On` Tasks relation; `Last Run` last-edited time |
| Errors | `Error` title; `Error Key` rich text; `Severity` and `Status` selects; `Task` and `Sub-agent` relations; optional `Run ID`; `Owner`, `GitHub Links`, `Created At`, and `Fixed At` tracking |
| Resources | `Resource` title; `Kind`, `State` select; `Version`, `Digest`, `Dependencies`; `Owner`, `Source`, and `Review Date` tracking |

Provider-managed page bodies use exact level-two headings:

- Sub-agent definitions: `## Sub-agent definition`
- Resources and internal journals: `## Resource body`
- Errors: `## Error Description` and `## Error Resolution`

Every manager-created Error begins as `Not Fixed`. An idempotent update for
the same `Error Key` may move it to `Fixing` or `Fixed`; humans may apply those
same values directly in Notion. Status is part of the exact write target and
crash-reconciliation check.

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

## Deployment constraint

NotionProvider v1 is single-host. Its local mutex prevents overlap only inside
one Node.js process. Deploy exactly one manager instance per environment until
a provider-backed distributed run lock with atomic acquisition is implemented.
