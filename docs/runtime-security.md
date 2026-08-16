# Runtime security

The packaged CLI uses the external-harness workflow and never calls a model
endpoint. The runtime interfaces below are optional library integration points,
not CLI configuration requirements. A ChatGPT Scheduled Task or comparable
harness owns model interaction and calls the CLI for bounded provider access.

## Environment boundary

Runtime fields are mandatory before dispatch. `agentRunner`, `modelTransport`,
and `sandbox` are registry IDs for adapters already installed by the host, not
package names. The legacy `adapters.publication` field is inert; draft
publication uses `effects.handlers["publication.draft_pr"]`.

`runtime.root` and every read/write root must be absolute and must not be a
filesystem root. Write roots must be descendants of `runtime.root`.
`outputLimitBytes` bounds combined streamed output.
`terminationGraceMilliseconds` bounds graceful termination, and
`postKillReapMilliseconds` bounds hard-kill acknowledgement, output closure,
cleanup, cancellation acknowledgement, and session close.

Authority is the intersection of trusted environment boundaries and the
activated provider-defined role:

- `repository.read` exposes configured read roots.
- `repository.write` exposes configured read and write roots.
- `network.access` exposes configured HTTP(S) origins.
- `environment.read` exposes configured non-secret environment names.
- Without the matching capability, the policy contains no such authority.

Secret-shaped environment names are rejected. The core verifies adapter,
environment, run, policy, model/reasoning, executable, process-tree,
control-plane separation, and credential non-exposure receipts. The configured
`ToolIsolationAdapter` owns operating-system enforcement; a host must not
register an adapter that merely asserts a receipt.

## Concrete no-tool profile

`NoToolModelTransportAdapter`, `NoToolIsolationAdapter`, and
`NoToolAgentRunnerAdapter` implement the `no-tools` profile. It rejects all
filesystem, environment, network, provider, and child-process authority,
launches no tool process, and streams only a trusted model client's result.
Tool-enabled roles require an external enforcing adapter and fail closed when
it is absent.

## Dispatch integration

Dispatch accepts an environment-resolved runtime and a completed
`AssignmentPromotion`; it does not accept raw adapters or caller-authored tool
policy.

```ts
const runtime = resolveRuntimeEnvironment({
  config,
  modelTransports,
  runners,
  toolIsolations,
});

const result = await dispatchActivatedAgent({
  activated,
  activationRuntime,
  additionalInput: {},
  promotion,
  provider,
  runtime,
});
```

Immediately before launch, dispatch reactivates the definition and Resource
graph; verifies the assignment intent, run/task leases, `Status`, `Working On`,
Task version/status, and dependencies; and recompiles authority.

One absolute deadline covers preparation, startup, bounded retries, execution,
termination, kill, reap, output closure, and cleanup. Only a nonzero process
exit classified as `process_no_verdict` may use the role's bounded retry
policy. Policy violations, invalid receipts/results, timeouts, and cleanup
failures never retry.

Agent results are proposals. Provider, Git, publication, command, browser, and
child-agent effects run later through external-effect brokers.

## Wire contracts

- `run-context-v1` binds activation and definition digests, the exact Task,
  Resource bodies and pins, capability grant, input, run ID, and runtime
  receipt.
- `agent-result-v1` echoes context, definition, and run identities; uses an
  allowed outcome; satisfies the output schema; contains only allowed intents;
  and hashes every other result field.
- `runtime-capability-receipt-v1` binds environment, policy, adapters,
  executable, model, reasoning, run, filesystem, network, and environment
  evidence.
- `process-telemetry-v2` reports duration, exit/termination state, byte counts,
  output digests, and a stable tool-violation code.

## Failure handling

Runtime failures create or update `agent-runtime:<runId>` in Errors using a
stable code and redacted description. Raw exceptions, paths, adapter output,
and credentials are not copied into provider content. If Error persistence also
fails, the caller receives an `AggregateError` retaining both failures.

Common failure classes include stale assignment or Task basis, invalid adapter
receipt, unauthorized tool activity, output limit, deadline, unacknowledged
cancellation, reap/cleanup failure, and invalid result contract.
