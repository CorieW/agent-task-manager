# Notion provider

Notion is the first concrete `AgentTaskProvider`. It maps authoritative state
to five data sources. Resources contain reusable content; Operations contain
manager-owned journals, leases, receipts, bootstrap state, and recovery state.
No local database is authoritative.

## Managed schema

Extra properties are tolerated. A missing compatible property can be added
only by a digest-authorized workspace apply; incompatible or destructive drift
fails closed.

| Table      | Required properties                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks      | `Task` title; provider-defined `Status` select; adapter-internal `Manager Mutation` rich text; self-relation `Dependencies`; optional numeric `Priority` |
| Agents     | `Name` title; `Enabled` checkbox; numeric `Revision`; `Model` rich text; `Status` select; `Working On` Tasks relation; `Last Run` last-edited time       |
| Errors     | `Error` title; `Error Key` rich text; `Severity` and `Status` selects; `Task` and `Agent` relations; optional `Run ID`                                   |
| Resources  | `Resource` title; `Kind` and `State` selects; `Version`, `Digest`, and `Dependencies` rich text                                                          |
| Operations | `Operation` title; `Kind`, `Version`, `Digest`, and `Dependencies` rich text; `State` select                                                             |

Notion presents provider-owned select values as human-readable labels. Resource
`Kind` uses labels such as `Policy`, `Prompt`, `Task Query`, `JSON Schema`, and
`Agent / Context`. These are the only Resource categories; operational records
never appear in the Resources table. Resource and Operation `State` use `Active`,
`Draft`, and `Retired`, while Error `Severity` uses `Critical`, `High`,
`Medium`, and `Low`. The adapter maps these labels to stable lowercase
provider-neutral values internally. Option labels are exact and must not be
renamed independently in Notion.

Project-specific columns are additive and remain provider data rather than core
role logic. The Perfect Project v4 workspace additionally uses Task governance
fields (`Type`, `Scope`, `Acceptance Criteria`, `GitHub Links`, `Owner`,
`Required Approval`, `Review Round`, `Review Finding Keys`,
`Review Findings Digest`, `Review Repeat Count`, `Test Round`,
`Test Failure Keys`, `Test Failures Digest`, `Test Repeat Count`,
`Remediation Source`, `Created At`, and `Closed At`), Error
ownership/fix tracking, and Resource ownership/source/review tracking. Its Task
`Status` select carries both active workflow states and terminal outcomes:
`Completed`, `Cancelled`, `Duplicate`, `Not reproducible`, and `Superseded`.
Agent responsibilities and boundaries belong in prompt Resources instead
of duplicate table properties. The adapter tolerates and can round-trip these
extra properties without imposing them on another project.

The Task page body preserves the initial description. When a Task reaches a
terminal status, the responsible role proposes a concise
`## Outcome Summary`; the manager appends it through the accepted Task
mutation without replacing the description or using a separate property.
Error evidence, including relevant GitHub links, belongs in the managed Error
description or resolution body instead of a dedicated property.

Provider-managed page bodies use exact level-two headings:

- Agent definitions: `## Agent definition`
- Prompt and policy Resources: native enhanced Markdown beginning with
  `## Resource body`
- Machine-oriented Resources: `## Resource body`, followed by one code block
- Operations: `## Operation body`, followed by one code block
- Errors: `## Error Description` and `## Error Resolution`

Readable Resource Markdown is the sole authoritative body, not a rendered copy
of a hidden payload. The adapter reads and replaces prompt and policy Resources
through Notion's native
enhanced-Markdown endpoints, removes the exact managed heading, normalizes line
endings and Unicode, and verifies the Resource `Digest` against the resulting
canonical body. Top-level blocks are separated by one line; use `<br>` for a
line break inside one block and `<empty-block/>` for an intentional empty
block.

The accepted readable subset covers text, headings, lists, to-do items,
quotes, dividers, fenced code, inline formatting, links, and equations. It
rejects truncated responses, unknown blocks, nested pages or databases,
attachments, embeds, mentions, images, synced blocks, tables, columns, and
other identity-bearing or externally resolved Notion markup. Legacy
whole-body `plain text` code blocks remain readable only when their unwrapped
body matches the pinned Resource digest; the next authorized write replaces
that representation with native Markdown. Machine-oriented JSON and schemas,
Operation journals, and Error bodies retain code blocks because exact byte-oriented
editing is more useful than rich presentation for those records.

Every Resource write canonicalizes its target body and verifies the supplied
digest before creating a durable intent or changing Notion. Representation
changes rebuild the complete manager-owned body, while interrupted
property-first writes resume only when the raw staged metadata exactly matches
the frozen target.

`Status` accepts `Not Fixed`, `Fixing`, and `Fixed`. Built-in failure paths
create `Not Fixed`; a later write for the same `Error Key`, using a new
idempotency key bound to the changed payload, may set `Fixing` or `Fixed`.
Humans may apply the same values directly in Notion. Status is part of the
exact write target and crash-reconciliation check.

Human requests and responses are embedded in their Task body. Their
exactly-once consumption and recovery journal is operational state, so it is
stored in Operations rather than Resources.

## Activity projection

`Status` and `Working On` are independent:

- `Status` is `Online` exactly when the Agent owns an active run lease.
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
Prompt and policy Resources use the version-pinned page Markdown create,
retrieve, and update endpoints through this same transport.

## Deployment constraint

NotionProvider v1 supports one host. Its in-process queue serializes local
operations, while an exclusive lock file rejects a live writer in another
process sharing the same lock directory and identity and clears a verifiably
stale owner. It does not coordinate across hosts. Deploy one manager host per
environment until a provider-backed distributed run lock with atomic
acquisition is implemented.
