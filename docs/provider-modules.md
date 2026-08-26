# Provider modules

The CLI has no provider registry or built-in provider selection logic. Every environment names a Node.js module whose `agentTaskProviderModule` export implements the versioned `agent-task-provider-module-v1` contract. The module descriptor supplies a non-empty `type` and a `create(context)` factory. The factory may be synchronous or asynchronous and must return the complete `AgentTaskProvider` interface.

```ts
import {
  AGENT_TASK_PROVIDER_MODULE_SCHEMA,
  type AgentTaskProviderModule,
} from "@corie_w/agent-task-manager";

export const agentTaskProviderModule: AgentTaskProviderModule = {
  schema: AGENT_TASK_PROVIDER_MODULE_SCHEMA,
  type: "example",
  async create({ environmentId, environmentVariables, options }) {
    return createExampleProvider({
      environmentId,
      options,
      token: environmentVariables.EXAMPLE_TOKEN,
    });
  },
};
```

`options` is strict JSON copied unchanged from `provider.options`; the package does not know or validate adapter fields. `environmentVariables` is the trusted host environment. An adapter should resolve secrets only inside its factory, reject missing credentials without printing their values, and keep credentials out of records, errors, logs, and plans.

Relative module paths resolve from the environment file's directory. Absolute paths and `file:` URLs are accepted. Bare package specifiers resolve from the environment file's package context when possible and otherwise use normal ESM resolution. The configured module executes as trusted host code with the same authority as the CLI.

The returned provider owns configuration validation, workspace validation and bootstrap semantics, storage, optimistic concurrency, and projection of its records into the five provider-neutral record families. Workspace plan `target`, step `kind`, step `payload`, and apply-result identifiers are provider-defined JSON. Plans must remain deterministic, digest-bound, drift-checked, and safe to replay after ambiguous transport failures.

The CLI validates the module descriptor and verifies every required provider method before dispatch. `providers` reports the configured module and its declared type without calling `create`; lifecycle, record, validation, and initialization commands create the adapter and then depend only on `AgentTaskProvider`.

## Configuration migration

Environment schema v1 now has a generic provider envelope. Move every adapter-specific field under `provider.options` and replace the old `provider.type` discriminator with `provider.module`:

```json
{
  "provider": {
    "module": "example-provider-package",
    "options": {
      "adapterSpecificField": "value"
    }
  }
}
```

Old provider objects are rejected rather than guessed or silently rewritten. This keeps the shared parser independent of every adapter schema.
