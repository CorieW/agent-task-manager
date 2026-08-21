# Configuration and CLI

Copy `agent-task-manager.environment.example.json` to the ignored `agent-task-manager.environment.json`. Use schema `agent-task-manager-environment-v3`; configure the Management page and the data-source IDs for `tasks`, `agents`, `activeAgents`, `errors`, and `resources`.

`lifecycleCommands` provides ordered trusted commands around Agent duties. This example creates an isolated Git worktree for Coder without embedding Git behavior in Agent Task Manager:

```json
{
  "lifecycleCommands": {
    "workingDirectories": {
      "coder": "A:\\Projects\\.agent-runs\\{{runId}}"
    },
    "beforeAgent": [
      {
        "agentKeys": ["coder"],
        "executable": "git",
        "arguments": [
          "worktree",
          "add",
          "-b",
          "atm/{{runId}}",
          "{{workingDirectory}}",
          "main"
        ],
        "workingDirectory": "A:\\Projects\\project",
        "environment": {},
        "inheritEnvironment": [],
        "timeoutMilliseconds": 120000
      }
    ],
    "afterAgent": []
  }
}
```

Set `agentKeys` to `null` to run a command for every Agent. Commands run sequentially without a shell. They receive only process-lookup/runtime variables, explicitly named `inheritEnvironment` variables, configured `environment` values, and manager-owned `AGENT_TASK_MANAGER_*` lifecycle variables; host secrets are not forwarded implicitly. Arguments, environment values, executables, command working directories, and per-Agent working-directory templates can use `{{environmentId}}`, `{{agentKey}}`, `{{runId}}`, `{{taskId}}`, `{{harnessId}}`, `{{parentRunId}}`, `{{workingDirectory}}`, `{{status}}`, `{{outcome}}`, and `{{failureSummary}}`. Per-Agent working directories may use only stable start-context values.

Before-command failure prevents Active Agent creation. After-command failure occurs before terminal Notion or Task mutations, leaving the run retryable. A process crash can still repeat an external command, so every configured command must be idempotent. Commands must finish and must not leave detached descendants. Lifecycle commands are trusted host automation and do not use the Agent's command inclusion/exclusion policy.

Run `validate` before starting work. `init --plan` emits a deterministic digest. Apply only the still-current plan with `init --apply --expected-plan-digest <digest>`.

The harness starts a run with caller-supplied Run and Harness IDs, sends heartbeats, and then calls `complete` or `fail`. Reusing the same Run ID with identical start parameters replays the existing run. Use `sweep` to mark expired runs stale and `restart` to start a failed subtree again.

Errors can be reported from a JSON file or standard input with `error report --input FILE|-`, and a human can unblock an exhausted retry chain with `error resolve`.
