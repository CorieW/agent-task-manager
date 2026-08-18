# Lifecycle and harness contract

An Active Agent is a disposable execution projection. Starting one parses the Agent definition from its page body, validates that it is enabled, resolves its `prompt/*` and `policy/*` selectors to active Resources, and then validates the Task, optional same-Task parent, and Task root exclusivity. The response contains the current Task, Agent, and Resource bodies; it contains no transcript or snapshot.

The harness refreshes `Last Heartbeat`. A heartbeat more than five minutes old is stale. Failure or staleness stops and archives descendants but leaves the run's parent running. Failed and stale rows remain visible; successful and ancestor-stopped rows are archived.

Each Retry Key permits three attempts. The third failure reports `active-agent-retry:<retry-key>` and blocks another restart until a human resolves that Error. The next restart begins a new attempt-one chain. Other Errors are informational.

Completion is rejected while descendants run and unless the outcome exists in the Agent definition's `transitions` object. The mapped Task status is applied; `$current` leaves it unchanged. The successful Active Agent is then archived.

One process must serialize writes with the supplied single-host mutex. Multi-host coordination is unsupported. External actions are at-least-once, so the harness must make repeats safe.
