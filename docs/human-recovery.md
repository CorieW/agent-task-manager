# Human interaction and recovery

`OutcomeTransitionBroker` applies provider-defined role outcomes. An outcome
listed in `humanResolutionOutcomes` is rejected unless it carries a complete
resolution request. The broker persists the stable Error, immutable blank-slot
baseline, and visible slot before moving the Task to its waiting status.
Ordinary outcomes cannot smuggle a resolution request through this interface.

## Canonical slots

`HumanRecoveryManager` supports provider-neutral `answer`, `resolution`,
`review`, and `testing` slots. Callers supply the waiting status and frozen
action-to-status routes; no role name or workflow status is hardcoded.

Each slot is a closed `human-interaction-slot-v1` JSON object inside exact
`agent-task-manager:human-slot:<sha256>` markers in the Task body. Before a
blank response is exposed, the manager stores the complete immutable baseline
as `human-slot/<slotId>` in Resources. Only `response.action` and
`response.text` may differ from that baseline.

```json
"response": {
  "action": "resume",
  "text": "Resolved by updating the required configuration."
}
```

## Consumption

Consumption:

1. verifies the normalized Task body, archive state, and complete
   provider-neutral property projection against the baseline;
2. permits changes only in the selected response;
3. resolves the action through the slot's frozen route map;
4. stores `human-consumption/<slotId>` as pending;
5. conditionally changes Task Status; and
6. finalizes the consumption record.

Replays return the applied record without another transition. Pending Notion
intents resume only when the exact target is visible or the original Task
version remains current. Otherwise recovery fails closed.

## Inspection and manual recovery

`inspectHumanRecovery` returns Task status/version/archive state plus each
slot's ID, kind, baseline validity, response state, and consumption state. It
does not expose prompt, routes, or response text.

Use `reconcileHumanResponse`, `reconcileActivity`, and `reconcileLease` only as
explicit operator actions. Blank requests have no CLI creation command and are
created through `OutcomeTransitionBroker` or `HumanRecoveryManager`.
