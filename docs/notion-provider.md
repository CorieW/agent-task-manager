# Notion provider

## Record mapping

The Notion provider maps the five provider-neutral record families to five data sources. Page bodies hold Task descriptions, Agent definitions, Resource instructions, and Error description/resolution text. Active Agents hold metadata only. Scoped Task-description updates use Notion's exact `update_content` operation with the previously observed complete Markdown, so concurrent edits fail instead of being overwritten and unrelated Task content is preserved. While a run is running, its `Task` relation supplies the Task's reciprocal `Active Agents` membership. Every terminal transition clears that relation; the separate immutable `Task ID` field preserves historical and restart identity without leaving completed, failed, stale, or stopped runs attached to the Task. `Working Directory` persists the generic execution directory resolved for the run so replays and command authorization fail closed on configuration drift.

## Agent definitions

Each Agents row has only the `Name` title property. Its page body is the authoritative configuration and must contain an `## Agent definition` heading followed by a fenced `json` object. The `agent-definition-v1` object supplies `id`, `enabled`, `model`, `reasoning`, `commands`, `allowedTaskTypes`, `allowedStatuses`, `inputResourceSelectors`, `promptResources`, and `transitions`, as on the Code Reviewer page. Optional `calledBy`, `notes`, `lifecycleCommands`, and `taskDescription` fields are also exposed by the provider.

`taskDescription.writableSections` authorizes only named level-two Task sections; `requiredSectionsByOutcome` maps declared outcomes to non-empty sections required at completion. Lifecycle commands, Task-description boundaries, and the optional working-directory template belong to that Agent and are included in its body-bound version.

The allowed Task types and statuses are exact, user-defined assignment inputs; they define where the Agent may work, not the destination statuses it may set through declared transitions. The manager does not impose a global enum. `commands` must contain exactly one `inclusion` or `exclusion` string array. No other Agent-definition schema version is accepted.

`prompt/*` and `policy/*` selectors are resolved to current Resources by key; schema, query, schedule, and other selectors remain in the definition for the external harness. New Active Agents pin a body-bound SHA-256 Agent version. A run created by the immediately preceding timestamp-version build must be failed or swept before its exact Notion timestamp alias can rebase a restart; the replacement attempt pins the body-bound version.
