/** Defines provider-neutral Task, Sub-agent, Resource, Error, activity, and lease records. */
import type { JsonObject } from "./json.js";

/** Compact projection used while selecting task. */
export interface TaskSummary {
  /** Whether the Task is archived. */
  readonly archived: boolean;
  /** Stable identifier for task summary. */
  readonly id: string;
  /** Priority for task summary. */
  readonly priority: number | null;
  /** Current workflow status. */
  readonly status: string;
  /** Title for task summary. */
  readonly title: string;
  /** Opaque version token used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Immutable snapshot of task. */
export interface TaskSnapshot extends TaskSummary {
  /** Provider-managed page body. */
  readonly body: string;
  /** Dependencies included in task snapshot. */
  readonly dependencies: readonly string[];
  /** Provider-visible structured properties. */
  readonly properties: JsonObject;
}

/** Canonical fields for task query. */
export interface TaskQuery {
  /** Opaque cursor after which the next page begins. */
  readonly cursor: string | null;
  /** Limit for task query. */
  readonly limit: number;
  /** Predicate for task query. */
  readonly predicate: JsonObject;
}

/** Policy governing selection. */
export interface SelectionPolicy {
  /** Assignment modes accepted by the definition. */
  readonly acceptsAssignmentsFrom: readonly (
    "coordinator" | "explicit" | "self"
  )[];
  /** Max candidate summaries for selection policy. */
  readonly maxCandidateSummaries: number;
  /** Mode for selection policy. */
  readonly mode: "coordinator" | "explicit" | "self";
  /** Result schema for selection policy. */
  readonly resultSchema: string;
  /** Task query resource for selection policy. */
  readonly taskQueryResource: string | null;
}

/** Policy governing invocation. */
export interface InvocationPolicy {
  /** Mode for invocation policy. */
  readonly mode: "event" | "manual" | "scheduled";
  /** Schedule resource for invocation policy. */
  readonly scheduleResource: string | null;
}

/** Policy governing retry. */
export interface RetryPolicy {
  /** Max attempts for retry policy. */
  readonly maxAttempts: number;
  /** No verdict for retry policy. */
  readonly noVerdict: "block" | "retry";
}

/** Canonical fields for sub-agent definition. */
export interface SubAgentDefinition {
  /** Effect intents the definition may invoke. */
  readonly allowedIntents: readonly string[];
  /** Capabilities included in sub-agent definition. */
  readonly capabilities: readonly string[];
  /** Max concurrency for sub-agent definition. */
  readonly maxConcurrency: number;
  /** Max assignments per run for sub-agent definition. */
  readonly maxAssignmentsPerRun: number;
  /** Context budget bytes for sub-agent definition. */
  readonly contextBudgetBytes: number;
  /** Deadline duration in seconds. */
  readonly deadlineSeconds: number;
  /** Whether the definition is eligible for activation. */
  readonly enabled: boolean;
  /** Stable identifier for sub-agent definition. */
  readonly id: string;
  /** Human resolution outcomes included in sub-agent definition. */
  readonly humanResolutionOutcomes: readonly string[];
  /** Input resource selectors included in sub-agent definition. */
  readonly inputResourceSelectors: readonly string[];
  /** Invocation for sub-agent definition. */
  readonly invocation: InvocationPolicy;
  /** Priority for sub-agent definition. */
  readonly priority: number;
  /** Max assignment depth for sub-agent definition. */
  readonly maxAssignmentDepth: number;
  /** Model for sub-agent definition. */
  readonly model: string;
  /** Name for sub-agent definition. */
  readonly name: string;
  /** Prompt resources included in sub-agent definition. */
  readonly promptResources: readonly string[];
  /** Prohibited capabilities included in sub-agent definition. */
  readonly prohibitedCapabilities: readonly string[];
  /** Reasoning for sub-agent definition. */
  readonly reasoning: string;
  /** Provider capabilities required to activate the definition. */
  readonly requiredProviderCapabilities: readonly string[];
  /** Revision for sub-agent definition. */
  readonly revision: number;
  /** Retry for sub-agent definition. */
  readonly retry: RetryPolicy;
  /** Runner profile for sub-agent definition. */
  readonly runnerProfile: string;
  /** Schema discriminator for the serialized representation. */
  readonly schema: "sub-agent-definition-v1";
  /** Selection for sub-agent definition. */
  readonly selection: SelectionPolicy;
  /** Transitions for sub-agent definition. */
  readonly transitions: Readonly<Record<string, string>>;
  /** Output schema for sub-agent definition. */
  readonly outputSchema: string;
}

/** Canonical fields for sub-agent activity. */
export interface SubAgentActivity {
  /** Current workflow status. */
  readonly status: "Offline" | "Online";
  /** Task IDs. */
  readonly taskIds: readonly string[];
  /** Opaque version token used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Canonical fields for lease projection. */
export interface LeaseProjection {
  /** Run lease IDs. */
  readonly runLeaseIds: readonly string[];
  /** Task IDs. */
  readonly taskIds: readonly string[];
  /** Task lease IDs. */
  readonly taskLeaseIds: readonly string[];
}

/** Requested state change for activity. */
export interface ActivityMutation {
  /** Expected run lease IDs. */
  readonly expectedRunLeaseIds: readonly string[];
  /** Expected task IDs. */
  readonly expectedTaskIds: readonly string[];
  /** Key that identifies retries of the same logical operation. */
  readonly idempotencyKey: string;
  /** Next run lease IDs. */
  readonly nextRunLeaseIds: readonly string[];
  /** Next task IDs. */
  readonly nextTaskIds: readonly string[];
  /** Stable identifier for sub-agent. */
  readonly subAgentId: string;
}

/** Requested state change for conditional task. */
export interface ConditionalTaskMutation {
  /** Version token expected for expected. */
  readonly expectedVersion: string;
  /** Key that identifies retries of the same logical operation. */
  readonly idempotencyKey: string;
  /** Next body for conditional task mutation. */
  readonly nextBody: string | null;
  /** Next properties for conditional task mutation. */
  readonly nextProperties: JsonObject;
  /** Replacement Task status, or null to preserve the current status. */
  readonly nextStatus: string | null;
  /** Stable identifier for task. */
  readonly taskId: string;
}

/** Stable reference to resource. */
export interface ResourceRef {
  /** Optional SHA-256 digest pin for the referenced Resource. */
  readonly digest: string | null;
  /** Key for resource ref. */
  readonly key: string;
  /** Opaque version token used for compatibility or concurrency checks. */
  readonly version: string | null;
}

/** Persisted representation of resource. */
export interface ResourceRecord {
  /** Provider-managed page body. */
  readonly body: string;
  /** Dependencies included in resource record. */
  readonly dependencies: readonly ResourceRef[];
  /** SHA-256 digest of the Resource body and metadata. */
  readonly digest: string;
  /** Key for resource record. */
  readonly key: string;
  /** Kind for resource record. */
  readonly kind: string;
  /** Current state of resource record. */
  readonly state: "active" | "draft" | "retired";
  /** Opaque version token used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Requested state change for resource. */
export interface ResourceMutation extends ResourceRecord {
  /** Key that identifies retries of the same logical operation. */
  readonly idempotencyKey: string;
}

/** Human-visible workflow states for recorded Errors. */
export const ERROR_STATUSES = ["Not Fixed", "Fixing", "Fixed"] as const;
/** Allowed error status literals. */
export type ErrorStatus = (typeof ERROR_STATUSES)[number];

/** Requested state change for error. */
export interface ErrorMutation {
  /** Description for error mutation. */
  readonly description: string;
  /** Stable key for error. */
  readonly errorKey: string;
  /** Key that identifies retries of the same logical operation. */
  readonly idempotencyKey: string;
  /** Stable identifier for related run. */
  readonly relatedRunId: string | null;
  /** Stable identifier for related sub-agent. */
  readonly relatedSubAgentId: string | null;
  /** Stable identifier for related task. */
  readonly relatedTaskId: string | null;
  /** Resolution for error mutation. */
  readonly resolution: string;
  /** Severity for error mutation. */
  readonly severity: "critical" | "high" | "low" | "medium";
  /** Current workflow status. */
  readonly status: ErrorStatus;
  /** Title for error mutation. */
  readonly title: string;
}

/** Inputs required to perform lease. */
export interface LeaseRequest {
  /** Timestamp at which the lease expires. */
  readonly expiresAt: string;
  /** Key that identifies retries of the same logical operation. */
  readonly idempotencyKey: string;
  /** Stable identifier for owner. */
  readonly ownerId: string;
  /** Scope for lease request. */
  readonly scope: "agent_run" | "task_assignment";
  /** Stable identifier for sub-agent. */
  readonly subAgentId: string;
  /** Stable identifier for task. */
  readonly taskId: string | null;
}

/** Canonical fields for lease renewal. */
export interface LeaseRenewal {
  /** Existing lease expiry that must match before renewal. */
  readonly expectedExpiresAt: string;
  /** Key that identifies retries of the same logical operation. */
  readonly idempotencyKey: string;
  /** Stable identifier for lease. */
  readonly leaseId: string;
  /** Replacement expiry timestamp requested by a lease renewal. */
  readonly nextExpiresAt: string;
  /** Stable identifier for owner. */
  readonly ownerId: string;
}

/** Canonical fields for lease release. */
export interface LeaseRelease {
  /** Version token expected for expected. */
  readonly expectedVersion: string | null;
  /** Stable identifier for lease. */
  readonly leaseId: string;
  /** Stable identifier for owner. */
  readonly ownerId: string;
}

/** Immutable snapshot of lease. */
export interface LeaseSnapshot {
  /** Timestamp at which the lease expires. */
  readonly expiresAt: string;
  /** Stable identifier for lease. */
  readonly leaseId: string;
  /** Stable identifier for owner. */
  readonly ownerId: string;
  /** Whether the lease has been released. */
  readonly released: boolean;
  /** Scope for lease snapshot. */
  readonly scope: LeaseRequest["scope"];
  /** Stable identifier for sub-agent. */
  readonly subAgentId: string;
  /** Stable identifier for task. */
  readonly taskId: string | null;
  /** Opaque version token used for compatibility or concurrency checks. */
  readonly version: string;
}

/** Result of lease. */
export interface LeaseResult {
  /** Whether the requested lease was acquired. */
  readonly acquired: boolean;
  /** Stable identifier for conflicting lease. */
  readonly conflictingLeaseId: string | null;
  /** Stable identifier for lease. */
  readonly leaseId: string | null;
}
