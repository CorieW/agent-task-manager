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
Task snapshot, parent/child activation digests, and exact child Resource pins;
the returned catalog supplies the keys, versions, and digests required by wave
nodes.

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
