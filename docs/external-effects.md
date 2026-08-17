# External-effect brokers

`ExternalEffectBroker` turns authorized `agent-result-v1.proposedIntents` into
deterministic, crash-reconcilable operations. Environment configuration maps
each intent kind to an installed handler under `effects.handlers`; validated
adapter-specific settings belong under `effects.settings`.

Provider content can select logical IDs. It cannot introduce filesystem paths,
executables, repositories, remotes, network origins, credentials, or handler
implementations.

## Intent kinds

- `workspace.provision` and `workspace.release`
- `git.observe`, `git.branch`, `git.commit`, and `git.push`
- `publication.draft_pr` and `publication.pr_comment`
- `command.run`
- `browser.run`
- `child_agent.wave`

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

## Durable execution and recovery

Before calling a handler, the broker:

1. revalidates assignment, leases, Task, role, Resource, and intent authority;
2. stores canonical `external-effect-intent-v2` in Operations;
3. acquires a provider-backed effect claim; and
4. enables durable automatic-replay blocking immediately before `apply`.

An `applied` or known `failed` observation receives an
`external-effect-receipt-v1`. `not_applied` permits execution only before
write-ahead quarantine. An indeterminate result blocks replay until explicit
reconciliation proves the outcome. Only a durably stored terminal observation
clears replay blocking.

Workspace ownership is a provider-backed `workspace-ownership-v1` Operation
serialized by a provider lease. Local sidecars are never authoritative. If
deadline cancellation is not acknowledged, the effect claim remains
quarantined until expiry while the durable replay block remains active.

Child waves additionally store one `child-agent-node-intent-v1` Operation per
node. Nodes receive only their immutable context Resource and declared
dependency receipts. Completed nodes are reused after restart.

## Git and commands

`LocalGitEffects` derives workspace paths under the configured runtime root and
verifies a pinned Git executable, empty hooks, configured repository identity,
full revisions, changed paths, commit parent/message, local/remote heads, and
remote names. Every Git invocation disables system/global configuration,
optional locks, prompts, credential helpers, fsmonitor, and repository hooks.

```ts
const ownership = new ProviderWorkspaceOwnershipStore(provider);
const git = await LocalGitEffects.create(gitConfig, { ownership });
```

Push credentials come from a trusted `GitCredentialBroker`, never an agent
payload.

`ConfiguredCommandEffects` accepts a logical command key whose absolute
executable, digest, argument prefix, deadline, output bound, and replay-safe
declaration are environment owned. Commands run without a shell or inherited
environment. Non-repeatable commands must not be registered.

Browser and publication transports are deployment-supplied interfaces. They
remain unavailable until the host registers drivers that enforce disposable
browser isolation/origin bounds or exact draft publication targets.

## Draft pull requests

A successful Coder result for a repository change uses the ordered intent
sequence `git.commit`, `git.push`, then `publication.draft_pr`. The manager must
obtain a durable `applied` receipt for each effect before it routes the Task to
review.

The publication driver treats `publicationTarget`, `repositoryId`,
`baseBranch`, and `headBranch` as the stable Draft PR identity. It creates a
Draft PR when none exists and updates that same open Draft PR after later
pushes; it must not create a second PR for the same identity. The body is
refreshed after every pushed change and uses the project-standard sections
`Why`, `Changes`, `Testing`, `Risks`, `Evidence`, and `Links`. The conventional
title describes the primary change and is updated only when that primary scope
changes.

The driver must preserve draft state and human review state. It fails closed
if the matching PR is closed, merged, no longer a draft, points at an
unexpected head, or cannot be reconciled without overwriting human-controlled
state. Coder never merges, marks ready, approves, or closes the PR.

Reviewer and Tester publish bounded Markdown through
`publication.pr_comment`. The payload identifies the configured publication
target, repository, and pull-request number. These comments report findings or
verification only; they do not approve, merge, close, or change draft state.

## Closed payloads

| Kind                     | Required fields                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.provision`    | `mode`, `repositoryId`, `sourceRevision`, `workspaceKey`                                                                                                               |
| `workspace.release`      | `repositoryId`, `workspaceKey`                                                                                                                                         |
| `git.observe`            | `repositoryId`, `revision`, `workspaceKey`                                                                                                                             |
| `git.branch`             | `branch`, `expectedHead`, `repositoryId`, `workspaceKey`                                                                                                               |
| `git.commit`             | `expectedHead`, `message`, nonempty repository-relative `paths`, `repositoryId`, `workspaceKey`                                                                        |
| `git.push`               | `branch`, `expectedLocalHead`, nullable `expectedRemoteHead`, configured `remote`, `repositoryId`, `workspaceKey`                                                      |
| `publication.draft_pr`   | `baseBranch`, bounded `body`, `expectedHead`, `headBranch`, `publicationTarget`, `repositoryId`, bounded `title`                                                       |
| `publication.pr_comment` | bounded `body`, `publicationTarget`, positive integer `pullRequestNumber`, `repositoryId`                                                                              |
| `command.run`            | bounded `arguments`, configured `commandKey`, `repositoryId`, `workspaceKey`                                                                                           |
| `browser.run`            | configured `environmentKey`, `repositoryId`, `scenarioResource`, `workspaceKey`                                                                                        |
| `child_agent.wave`       | `maxConcurrency` (1–32) and an acyclic `nodes` array; every node pins `contextResource`, `contextVersion`, `contextDigest`, `definitionId`, `dependsOn`, and `nodeKey` |
