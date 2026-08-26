# Notion provider

## Configuration

Select the bundled adapter through its package subpath. All Notion-specific configuration belongs under the opaque provider options:

```json
{
  "schema": "agent-task-manager-environment-v1",
  "environmentId": "management-v2",
  "provider": {
    "module": "@corie_w/agent-task-manager/providers/notion",
    "options": {
      "connection": { "tokenEnv": "NOTION_TOKEN" },
      "bootstrapParent": "NOTION_PAGE_ID",
      "tables": {
        "tasks": null,
        "agents": null,
        "activeAgents": null,
        "errors": null,
        "resources": null
      }
    }
  }
}
```

`tokenEnv` defaults to `NOTION_TOKEN`. The adapter—not the shared environment parser—validates the bootstrap parent and complete data-source mapping, resolves the token, owns Notion schema planning, and interprets its provider-owned workspace plans.

Programmatic consumers import Notion APIs from `@corie_w/agent-task-manager/providers/notion`; the provider-neutral package root no longer re-exports adapter-specific APIs.

## Record mapping

The Notion provider maps the five provider-neutral record families to five data sources. Page bodies hold Task descriptions, Agent definitions, Resource instructions, and Error description/resolution text. Active Agents hold metadata only. Scoped Task-description updates use Notion's exact `update_content` operation with the previously observed complete Markdown, so concurrent edits fail instead of being overwritten and unrelated Task content is preserved. While a run is running, its `Task` relation supplies the Task's reciprocal `Active Agents` membership. Every terminal transition clears that relation; the separate immutable `Task ID` field preserves historical and restart identity without leaving completed, failed, stale, or stopped runs attached to the Task. `Working Directory` persists the generic execution directory resolved for the run so replays and command authorization fail closed on configuration drift.

## Agent definitions

Each Agents row has only the `Name` title property. Its page body is the authoritative configuration and must contain an `## Agent definition` heading followed by a fenced `json` object. The `agent-definition-v1` object supplies `id`, `enabled`, `model`, `reasoning`, `commands`, `allowedTaskTypes`, `allowedStatuses`, `inputResourceSelectors`, `promptResources`, and `transitions`, as on the Code Reviewer page. Optional `calledBy`, `notes`, `lifecycleCommands`, and `taskDescription` fields are also exposed by the provider.

`taskDescription.writableSections` authorizes only named level-two Task sections; `requiredSectionsByOutcome` maps declared outcomes to non-empty sections required at completion. Lifecycle commands, Task-description boundaries, and the optional working-directory template belong to that Agent and are included in its body-bound version.

The allowed Task types and statuses are exact, user-defined assignment inputs; they define where the Agent may work, not the destination statuses it may set through declared transitions. The manager does not impose a global enum. `commands` must contain exactly one `inclusion` or `exclusion` string array. No other Agent-definition schema version is accepted.

Every `promptResources` and `inputResourceSelectors` entry is resolved to a current Resource by exact key and supplied in declared order, with duplicates removed. Prompt entries must use `prompt/*` keys and resolve to Kind `Prompt`; input selectors may use any key and any non-empty Resource Kind, including agent policy, schema, query, or schedule resources. New Active Agents pin a body-bound SHA-256 Agent version. A run created by the immediately preceding timestamp-version build must be failed or swept before its exact Notion timestamp alias can rebase a restart; the replacement attempt pins the body-bound version.
