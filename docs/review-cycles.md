# Review-cycle guards

Code review can legitimately return a Task to implementation, but an unlimited
`coding -> review -> coding` route can repeat forever. Agent Task Manager stores
the guard state in ordinary provider-owned Task properties; it does not use a
local database.

`advanceReviewCycle` canonicalizes stable confirmed-finding keys, hashes the
complete set, and prepares replacement Task properties. `OutcomeTransitionBroker`
can apply those properties atomically with the provider-defined
`changes_requested` status transition by receiving `reviewCycle` on an ordinary
transition input.

The default property contract is:

| Property                 | Meaning                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `Review Round`           | Completed `changes_requested` transitions                   |
| `Review Finding Keys`    | Canonical JSON array of stable confirmed-finding identities |
| `Review Findings Digest` | SHA-256 digest of the canonical finding-key array           |
| `Review Repeat Count`    | Consecutive appearances of the same complete finding set    |

The default policy permits three `changes_requested` transitions. A fourth is
rejected. It also rejects the second consecutive occurrence of the same complete
finding set. `ReviewCycleLimitError` leaves the Task unchanged; the trusted host
must route that condition through the existing durable human-resolution path.

Finding keys should identify the procedure, failure class, normalized location,
and violated invariant. They must not depend on prose wording or process/run IDs.
For example:

```text
branch-audit:authorization:src/api.ts:authorize:owner-check
```

The first review should run the complete configured review workflow. Later
reviews use the persisted finding keys as the remediation scope and inspect the
remediation diff for regressions. They should not introduce unrelated cleanup or
readability work.

Hosts may supply a different `ReviewCyclePolicy` when a provider uses different
property names or limits. All configured properties must exist as compatible,
writable fields in that provider workspace.
