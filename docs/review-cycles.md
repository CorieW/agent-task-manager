# Review and test cycle guards

Review changes and test failures can legitimately return a Task to
implementation, but unlimited lifecycle routes can repeat forever. Agent Task
Manager stores both guard states in ordinary provider-owned Task properties; it
does not use a local database.

`advanceReviewCycle` canonicalizes stable confirmed-finding keys, while
`advanceTestCycle` canonicalizes stable confirmed-failure keys. Each function
hashes the complete set and prepares replacement Task properties.
`OutcomeTransitionBroker` can apply one guard atomically with its corresponding
provider-defined status transition through `reviewCycle` or `testCycle` on an
ordinary transition input.

The default review property contract is:

| Property                 | Meaning                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `Review Round`           | Completed `changes_requested` transitions                   |
| `Review Finding Keys`    | Canonical JSON array of stable confirmed-finding identities |
| `Review Findings Digest` | SHA-256 digest of the canonical finding-key array           |
| `Review Repeat Count`    | Consecutive appearances of the same complete finding set    |

The default test property contract is:

| Property               | Meaning                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `Test Round`           | Completed failed-test transitions                           |
| `Test Failure Keys`    | Canonical JSON array of stable confirmed-failure identities |
| `Test Failures Digest` | SHA-256 digest of the canonical failure-key array           |
| `Test Repeat Count`    | Consecutive appearances of the same complete failure set    |

Both guards also write `Remediation Source` as `Review` or `Test`. Coder uses
that manager-owned value to select the active evidence set when both historical
cycle states exist on the Task.

Each default policy permits three failed transitions. A fourth is rejected. It
also rejects the second consecutive occurrence of the same complete evidence
set. `ReviewCycleLimitError` and `TestCycleLimitError` leave the Task unchanged;
the trusted host must route either condition through the existing durable
human-resolution path.

Evidence keys should identify the procedure or gate, failure class, normalized
location, and violated invariant. They must not depend on prose wording or
process/run IDs. For example:

```text
branch-audit:authorization:src/api.ts:authorize:owner-check
unit:test-failure:test/api.test.ts:rejects-invalid-owner
```

The first review runs the complete configured review workflow. Later reviews
use persisted finding keys as the remediation scope and inspect the remediation
diff for regressions. A later test pass reruns the required verification matrix
while explicitly checking every persisted failure key. Neither stage should
introduce unrelated cleanup or scope expansion.

Hosts may supply different `ReviewCyclePolicy` and `TestCyclePolicy` objects
when a provider uses different property names or limits. All configured
properties, including the remediation-source property, must exist as
compatible, writable fields in that provider workspace.
