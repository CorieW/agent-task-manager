# Documentation

Agent Task Manager separates deterministic orchestration from provider-defined
workflow and agent behavior.

## Guides

- [External harness workflow](external-harness.md) — candidate discovery,
  assignment preparation, external execution, and validated completion.

- [Getting started and CLI](getting-started.md) — installation, Notion
  onboarding, workspace planning, inspection, and reconciliation commands.
- [Notion provider](notion-provider.md) — managed tables, page ranges, activity
  projection, and single-host constraints.
- [Agent definitions](agent-definitions.md) — provider-owned role
  manifests, Resources, queries, schemas, and activation rules.
- [Runtime security](runtime-security.md) — adapter boundaries, capability
  grants, dispatch, wire contracts, and failure handling.
- [External-effect brokers](external-effects.md) — durable intent handling for
  Git, commands, browser operations, publication, and child-agent waves.
- [Human interaction and recovery](human-recovery.md) — canonical slots,
  allowed-delta consumption, inspection, and manual recovery.
- [Review and test cycle guards](review-cycles.md) — bounded remediation rounds,
  canonical evidence identities, and human-resolution escalation.
- [Provider conformance and identification trials](provider-conformance.md) —
  emulator coverage and the read-only ten-Task trial harness.
- [Public API](public-api.md) — package-root exports and host integration entry
  points.

The root [README](../README.md) intentionally contains only the project
specifics, development commands, and links into these focused guides.
