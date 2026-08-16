# Execution hosts

`agent-task-manager run` is the provider-neutral execution entry point. It
validates the configured provider workspace, loads one explicitly authorized
local host module, promotes an explicit assignment, dispatches the Agent,
executes proposed effects in order, applies the provider-defined outcome route,
then releases leases and reconciles Agent activity.

```powershell
agent-task-manager run `
  --agent task-master `
  --task <notion-page-id> `
  --operation-key <stable-logical-key> `
  --host .\agent-task-manager.host.mjs `
  --json
```

The operation key is mandatory. Reuse it only to resume the exact same logical
run. The host path is also mandatory: loading executable host code is an
explicit human authorization, never an implicit configuration lookup.

Each operation is bound to its exact environment, Agent, Task, depth, and lease
expiry. Agent Task Manager serializes it with a same-host filesystem lock,
persists the prepared assignment before acquiring leases, and checkpoints the
validated Agent result, exact applied-effect identities, outcome receipt, and
terminal report. A retry resumes the first incomplete phase; a completed retry
returns the stored report without redispatching the model. Hosts must still use
durable effect brokers because a process can stop between an external response
and the next checkpoint write.

## Host module contract

The module exports `createAgentExecutionHost({ config, provider })`. It returns
`AgentExecutionBindings` containing:

- the capabilities, intents, runner profiles, and model/reasoning pairs that
  are actually installed;
- `prepare`, which returns an environment-resolved runtime and trusted
  additional input;
- `executeEffects`, which must use durable effect brokers and return one
  ordered execution per proposed intent;
- optional remediation-cycle and human-resolution materializers; and
- optional cleanup.

Agent Task Manager revalidates the requested definition, Task query, assignment,
runtime context, result, effect sequence, outcome route, lease releases, and
activity projection around those host-owned boundaries. A missing or incomplete
host fails before assignment promotion.

Hosts coordinating `child_agent.wave` can call `materializeAgentContexts` before
dispatch. It creates deterministic `agent/context` Resources containing the
Task/version, parent run and definition authority, child definition and
activation, assignment depth, and exact child Resource pins. The returned
catalog supplies the only keys, versions, and digests a wave may use.
`ProviderChildAgentWaveEffects` must be constructed with that catalog and the
matching parent-run authority; it rejects cross-run, cross-Task, stale, or
definition-swapped contexts before invoking a child driver.

No model credential, provider token, or other secret belongs in the environment
JSON or the module export. The host reads its own credentials from an external
secret boundary. A `no-tools` profile must use a direct model control plane; a
tool-using subprocess such as `codex exec` cannot truthfully be registered as
the no-tool adapter.

The package supplies the orchestration contract and the concrete zero-tool
runtime stack. `HttpNoToolModelClient` can call a trusted HTTPS model gateway
whose response is the raw `agent-result-v1` JSON; its bearer credential stays in
the model control plane and is never included in the Agent context. The package
intentionally does not guess a model vendor, browser, publication service, or
tool-enabled sandbox. A host must register real adapters for every capability
and intent advertised during activation.
