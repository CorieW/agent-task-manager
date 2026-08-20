# Configuration and CLI

Copy `agent-task-manager.environment.example.json` to the ignored `agent-task-manager.environment.json`. Use schema `agent-task-manager-environment-v3`; configure the Management page and the data-source IDs for `tasks`, `agents`, `activeAgents`, `errors`, and `resources`.

Set `worktree` to `null` to disable Agent command execution. To bind commands to a repository and enforce a new worktree for every Coder run, configure absolute, non-overlapping paths:

```json
{
  "worktree": {
    "baseRef": "main",
    "branchPrefix": "atm/",
    "repository": "A:\\Projects\\project",
    "requiredAgentKeys": ["coder"],
    "root": "A:\\Projects\\.agent-task-manager-worktrees\\project"
  }
}
```

The repository must be a Git worktree root and `baseRef` must resolve to a committed revision. Runs not listed in `requiredAgentKeys` are command-bound to that repository. Each required run gets a deterministic unique branch and linked-worktree path. Primary-checkout changes that are not committed are intentionally absent. Worktrees remain after terminal outcomes for inspection and explicit cleanup.

Run `validate` before starting work. `init --plan` emits a deterministic digest. Apply only the still-current plan with `init --apply --expected-plan-digest <digest>`.

The harness starts a run with caller-supplied Run and Harness IDs, sends heartbeats, and then calls `complete` or `fail`. Reusing the same Run ID with identical start parameters replays the existing run. Use `sweep` to mark expired runs stale and `restart` to start a failed subtree again.

Errors can be reported from a JSON file or standard input with `error report --input FILE|-`, and a human can unblock an exhausted retry chain with `error resolve`.
