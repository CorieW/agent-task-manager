# External harness workflow

Agent Task Manager is a provider boundary, not a model host. A ChatGPT
Scheduled Task or another trusted harness performs reasoning, starts child
agents, edits repositories, runs tests, and publishes work. It uses the CLI to
read only eligible provider work and to make narrowly validated state changes.

No model endpoint, model API credential, or model transport is configured in
Agent Task Manager.

## Task Master flow

1. Read eligible Tasks without acquiring a lease:

   ```powershell
   agent-task-manager candidates --agent task-master --json
   ```

2. Select the next Task according to the Task Master prompt and prepare the
   worker role that should handle it:

   ```powershell
   agent-task-manager assignment prepare `
     --agent planner `
     --task <task-id> `
     --operation-key <stable-key> `
     --json
   ```

3. Give `assignment.context` to that role. The context contains the exact Task,
   Agent definition, prompt and policy Resource bodies, output schema, Resource
   pins, capability grant, and stable run identity.
4. Let the external role perform its work. If it needs Coder, Reviewer, Tester,
   or another child, the harness creates that child itself. Agent Task Manager
   does not invoke a model.
5. Execute authorized external proposed effects and retain bounded evidence for
   each one. The manager applies `task.plan.publish` and
   `task.github_link.record` itself during outcome routing.
6. Submit the result and attestations:

   ```powershell
   agent-task-manager assignment complete `
     --operation-key <stable-key> `
     --completion completion.json `
     --json
   ```

Use the same operation key after interruption. Preparation returns the existing
assignment or terminal report. Completion replays the terminal report and
finishes any interrupted lease cleanup without rerouting the outcome.

## Completion envelope

The external harness authors outcome, payload, and proposed intents. The CLI
binds them to the prepared context, definition, and run and computes the
canonical Agent-result digest itself.

```json
{
  "schema": "harness-assignment-completion-v1",
  "result": {
    "schema": "harness-agent-result-v1",
    "outcome": "succeeded",
    "payload": { "summary": "Plan completed" },
    "proposedIntents": []
  },
  "effectAttestations": [],
  "humanResolution": null,
  "reviewFindingKeys": null,
  "testFailureKeys": null
}
```

For every proposed external intent, `effectAttestations` must contain an entry
with the original proposed-intent index, the same kind, `state: "applied"`, and
bounded JSON evidence. Manager-owned Task intents are not externally attested.
An attestation records what the trusted harness did; it does not give Agent
Task Manager authority to perform that external action.

## Task-owned role output

Task Planner proposes one `task.plan.publish` intent with `planMarkdown` and a
complete `questions` array. The manager upserts a single `## Plan` section in
the Task body. When questions are nonempty, the result must use a declared
human-resolution outcome; the manager renders every question into one human
request so the human can answer them together.

Coder proposes `task.github_link.record` after `publication.draft_pr`. The
manager appends the canonical `https://github.com/<owner>/<repo>/pull/<number>`
URL to the Task's `GitHub Links` property without duplicating it.

Code Reviewer and Code Tester use the external `publication.pr_comment` intent
to post their review findings or verification result to that Draft PR. The
trusted harness performs and attests those GitHub writes before completing the
assignment.

## Readiness and authority

Eligibility comes from the Agent's provider-owned Task Query Resource. A
Backlog Task is invisible to a query restricted to Ready, so it cannot be
prepared accidentally. Preparation then validates the selected Task against
the same immutable candidate basis, acquires run and Task leases, and records
the exact Task version/status. Completion rejects a stale result if the Task,
definition, Resources, leases, or assignment authority changed.

The root Task Master harness normally uses `candidates` and prepares the worker
role directly. It should not hold an exclusive assignment on a Task while a
child role is assigned to that same Task.
