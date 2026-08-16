# Public API

The package root exports provider-neutral domain contracts, orchestration
primitives, provider adapters, runtime boundaries, effect brokers, recovery
helpers, and trial contracts.

## Providers and core

- `AgentTaskProvider`, `ProviderRegistry`, and `InMemoryProvider`
- `SerializedProviderEmulator` and test-only `SeedableAgentTaskProvider`
- `NotionProvider`, `NotionHttpTransport`, `NotionWorkspaceReader`,
  `NotionWorkspaceManager`, `NotionPageStore`, `NotionRecordReader`, and
  `NotionStateStore`
- canonical JSON, digests, pagination, migration planning, schema comparison,
  selection-result helpers, invocation scheduling, and `runFoundationDryRun`

## Definitions and selection

- `parseAgentDefinitionManifest`, `validateAgentDefinition`, and
  `validateDefinitionSet`
- `resolveDefinition`, `activateDefinitions`, and `compileCapabilityGrant`
- task-query/candidate helpers, `prepareSelection`, `promoteSelection`,
  explicit-assignment helpers, and `routeOutcome`

## Runtime

- `RuntimeAdapterRegistry` and adapter/session/process interfaces
- `resolveRuntimeEnvironment` and `compileToolIsolationPolicy`
- context, result, receipt, and schema helpers
- `superviseProcess` and `dispatchActivatedAgent`
- `NoToolModelTransportAdapter`, `NoToolIsolationAdapter`, and
  `NoToolAgentRunnerAdapter`

## External effects

- `ExternalEffectBroker`, `ProviderEffectJournal`, and
  `AssignmentEffectAuthority`
- `WorkspaceOwnershipStore` and `ProviderWorkspaceOwnershipStore`
- `resolveExternalEffectEnvironment` and typed handler factories
- `LocalGitEffects`, `ConfiguredCommandEffects`, `DisposableBrowserEffects`,
  `DraftPublicationEffects`, and `ProviderChildAgentWaveEffects`

## Human recovery

- `OutcomeTransitionBroker` and `HumanRecoveryManager`
- `advanceReviewCycle`, `readReviewCycleState`,
  `DEFAULT_REVIEW_CYCLE_POLICY`, and `ReviewCycleLimitError`
- slot creation, parsing, rendering, and allowed-delta verification
- `inspectHumanRecovery`, `inspectAgentActivity`, and `inspectLease`
- `reconcileHumanResponse`, `reconcileActivity`, and `reconcileLease`

Exact lease inspection uses `AgentTaskProvider.getLeaseSnapshot`.

## Identification trials

- `prepareIdentificationTrial`
- `startIdentificationTrial`
- `recordIdentificationTrialObservation`
- versioned request, plan, observation, metrics, blocker, and report contracts

## Foundation dry run

```ts
import {
  InMemoryProvider,
  runFoundationDryRun,
  type ProviderEnvironment,
  type WorkspaceSchemaDescriptor,
} from "agent-task-manager";

declare const environment: ProviderEnvironment;
declare const target: WorkspaceSchemaDescriptor;

const provider = new InMemoryProvider(environment, target);
const report = await runFoundationDryRun({
  activeRuns: {},
  dueScheduledDefinitionIds: [],
  environment,
  environmentId: "local-demo",
  invocationSource: "manual",
  provider,
  scheduleLimit: 1,
  target,
});
```

This API may read provider state but does not apply schema steps, mutate Tasks,
or acquire leases.
