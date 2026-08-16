# Provider conformance and identification trials

## Provider implementation contract

A provider crosses a serialization boundary and must return detached,
JSON-compatible values. Summary pagination and ordering are deterministic;
unsupported predicates fail closed. Versions are opaque compare-and-set
tokens. Mutation idempotency identities bind both the operation and its
complete payload: exact replay returns the original result, while conflicting
reuse fails.

State-dependent operations first persist their complete canonical plan through
the provider operation-intent methods. Pending plans remain readable after a
restart, exact completion replays the original result, and a changed payload
under the same idempotency key fails before another mutation.

Leases are exclusive, expiry-aware, replayable, and released only against the
exact inspected version. Activity projection is conditionally replaced from
live leases. Resource reads enforce exact pins; Error entity identity remains
separate from mutation identity; operational records remain isolated from
content Resources; and workspace migration receipts form a
digest- and dependency-verified chain. Reconciliation reports durable observed
evidence without guessing or replaying an indeterminate write.

Every provider implementation must pass the shared conformance matrix. The
serialized emulator should also wrap seedable implementations to exercise the
JSON boundary, but it does not prove external durability.

## Serialized provider emulator

`SerializedProviderEmulator` is a test-only serialization boundary around a
`SeedableAgentTaskProvider`. Every defined request and response must be
JSON-compatible and is round-tripped through JSON serialization. Sparse
arrays, undefined or non-finite values, cycles, and non-plain objects fail
closed.

The shared provider conformance matrix runs unchanged against direct
`InMemoryProvider` access and the serialized wrapper. The emulator is not an
independent durable provider and does not replace a concrete adapter such as
Notion.

## Read-only identification trial

The identification-trial library prepares exactly ten Tasks without
dispatching a role or writing provider state.

`prepareIdentificationTrial`:

- requires ten unique Task IDs;
- loads enabled provider-defined roles when definition IDs are not supplied;
- resolves each role's complete Resource graph;
- stores provider identity;
- stores a digest over provider identity and physical table IDs;
- stores the provider-reported logical schema digest; and
- binds exact Task snapshots, definitions, and Resource pins into one plan
  digest.

`startIdentificationTrial` creates an in-memory report.
`recordIdentificationTrialObservation` re-reads and revalidates the complete
frozen basis before accepting each next Task observation. Every selected role
must have one explicit metrics row containing:

- `promptBytes`
- `retries`
- `providerCalls`
- `errors`
- `humanInterventions`

These values are caller supplied. The harness does not measure them or run
agents. The first blocker stops the report and returns a stable high-severity
`ErrorMutation` proposal. It does not persist the proposal, change a Task,
store the report, or continue to later Tasks.

There is no trial CLI command. A separately authorized host must supply real
observations and explicitly persist any report or Error proposal.
