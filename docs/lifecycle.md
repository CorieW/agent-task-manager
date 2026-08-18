# Lifecycle and harness contract

An Active Agent is a disposable execution projection. Starting one parses the Agent definition from its page body, validates that it is enabled, resolves its `prompt/*` and `policy/*` selectors to active Resources, and then validates the Task, optional same-Task parent, and Task root exclusivity. The response contains the current Task, Agent, and Resource bodies plus a strict command-proxy system prompt; it contains no transcript or snapshot.

The harness refreshes `Last Heartbeat`. A heartbeat more than five minutes old is stale. Failure or staleness stops and archives descendants but leaves the run's parent running. Failed and stale rows remain visible; successful and ancestor-stopped rows are archived.

Each Retry Key permits three attempts. The third failure reports `active-agent-retry:<retry-key>` and blocks another restart until a human resolves that Error. The next restart begins a new attempt-one chain. Other Errors are informational.

Completion is rejected while descendants run and unless the outcome exists in the Agent definition's `transitions` object. The mapped Task status is applied; `$current` leaves it unchanged. The successful Active Agent is then archived.

One process must serialize writes with the supplied single-host mutex. Multi-host coordination is unsupported. External actions are at-least-once, so the harness must make repeats safe.

The harness must expose no shell, terminal, process API, or direct executable tool to an Agent. Every operating-system command must use `agent-task-manager command proxy --run-id ID --harness-id ID -- COMMAND [ARGUMENT...]`. The proxy rejects non-running or foreign-owned runs, Agent-definition drift, path-like executable names, and commands denied by the Agent's inclusion or exclusion policy.

The host must set `AGENT_TASK_MANAGER_COMMAND_BROKER` to the absolute path of a trusted sandbox broker. The manager writes one JSON request (`{"command":"git","arguments":["status"]}`) to the broker's standard input and requires one `ProxyCommandResult` JSON object on standard output. The broker must contain the complete process tree, prevent descendants from escaping the Agent policy, enforce resource limits and cancellation, and remove direct host credentials. The CLI fails closed when no broker is configured; the manager never executes an Agent-requested executable itself.
