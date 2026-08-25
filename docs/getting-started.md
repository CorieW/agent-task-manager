# Configuration and CLI

Copy `agent-task-manager.environment.example.json` to the ignored `agent-task-manager.environment.json`. Use schema `agent-task-manager-environment-v1`; configure the Management page and the data-source IDs for `tasks`, `agents`, `activeAgents`, `errors`, and `resources`.

An Agent definition's optional `lifecycleCommands` provides ordered trusted commands around that Agent's duties. This Coder fragment creates an isolated Git worktree without embedding Git behavior in Agent Task Manager:

```json
{
  "schema": "agent-definition-v1",
  "id": "coder",
  "lifecycleCommands": {
    "workingDirectory": "A:\\Projects\\.agent-runs\\{{runId}}",
    "beforeAgent": [
      {
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

Commands run sequentially without a shell and apply only to the Agent that declares them. They receive only process-lookup/runtime variables, explicitly named `inheritEnvironment` variables, configured `environment` values, and manager-owned `AGENT_TASK_MANAGER_*` lifecycle variables; host secrets are not forwarded implicitly. Arguments, environment values, executables, command working directories, and the Agent working-directory template can use `{{environmentId}}`, `{{agentKey}}`, `{{runId}}`, `{{taskId}}`, `{{harnessId}}`, `{{parentRunId}}`, `{{workingDirectory}}`, `{{status}}`, `{{outcome}}`, and `{{failureSummary}}`. The Agent working directory may use only stable start-context values. Omitting `lifecycleCommands` means no hooks and the host's default working directory. Programmatic hosts that do not install a lifecycle executor fail closed when an Agent declares non-empty lifecycle configuration.

An Agent may also receive a scoped Task-description capability from its own definition:

```json
{
  "schema": "agent-definition-v1",
  "id": "task-planner",
  "taskDescription": {
    "writableSections": ["Planning"],
    "requiredSectionsByOutcome": {
      "succeeded": ["Planning"],
      "needs_human": ["Planning"]
    }
  }
}
```

The trusted harness supplies the complete section body through `active-agent update-task-section --run-id ID --harness-id ID --section Planning --input FILE|-`. The manager verifies run ownership, the pinned Agent definition, current Task eligibility, and the configured section allowlist. It then performs an exact-body compare-and-swap update that preserves all other Task content. Section bodies may contain nested headings but cannot introduce level-one or level-two headings. Completion fails closed when an outcome's required section is absent or empty.

Before-command failure prevents Active Agent creation. After-command failure occurs before terminal Notion or Task mutations, leaving the run retryable. A process crash can still repeat an external command, so every configured command must be idempotent. Commands must finish and must not leave detached descendants. Lifecycle commands are trusted host automation and do not use the Agent's command inclusion/exclusion policy.

Run `validate` before starting work. `init --plan` emits a deterministic digest. Apply only the still-current plan with `init --apply --expected-plan-digest <digest>`.

The harness starts a run with caller-supplied Run and Harness IDs, sends heartbeats, and then calls `complete` or `fail`. Reusing the same Run ID with identical start parameters replays the existing run. Use `sweep` to mark expired runs stale and `restart` to start a failed subtree again.

Errors can be reported from a JSON file or standard input with `error report --input FILE|-`, and a human can unblock an exhausted retry chain with `error resolve`.
