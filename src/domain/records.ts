import type { JsonObject } from "./json.js";

export interface TaskSummary {
  readonly archived: boolean;
  readonly id: string;
  readonly priority: number | null;
  readonly status: string;
  readonly title: string;
  readonly version: string;
}

export interface TaskSnapshot extends TaskSummary {
  readonly body: string;
  readonly dependencies: readonly string[];
  readonly properties: JsonObject;
}

export interface TaskQuery {
  readonly cursor: string | null;
  readonly limit: number;
  readonly predicate: JsonObject;
}

export interface SelectionPolicy {
  readonly acceptsAssignmentsFrom: readonly ("coordinator" | "explicit" | "self")[];
  readonly maxCandidateSummaries: number;
  readonly mode: "coordinator" | "explicit" | "self";
  readonly resultSchema: string;
  readonly taskQueryResource: string | null;
}

export interface InvocationPolicy {
  readonly mode: "event" | "manual" | "scheduled";
  readonly scheduleResource: string | null;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly noVerdict: "block" | "retry";
}

export interface SubAgentDefinition {
  readonly allowedIntents: readonly string[];
  readonly capabilities: readonly string[];
  readonly maxConcurrency: number;
  readonly maxAssignmentsPerRun: number;
  readonly contextBudgetBytes: number;
  readonly deadlineSeconds: number;
  readonly enabled: boolean;
  readonly id: string;
  readonly humanResolutionOutcomes: readonly string[];
  readonly inputResourceSelectors: readonly string[];
  readonly invocation: InvocationPolicy;
  readonly priority: number;
  readonly maxAssignmentDepth: number;
  readonly model: string;
  readonly name: string;
  readonly promptResources: readonly string[];
  readonly prohibitedCapabilities: readonly string[];
  readonly reasoning: string;
  readonly requiredProviderCapabilities: readonly string[];
  readonly revision: number;
  readonly retry: RetryPolicy;
  readonly runnerProfile: string;
  readonly schema: "sub-agent-definition-v1";
  readonly selection: SelectionPolicy;
  readonly transitions: Readonly<Record<string, string>>;
  readonly outputSchema: string;
}

export interface SubAgentActivity {
  readonly status: "Offline" | "Online";
  readonly taskIds: readonly string[];
  readonly version: string;
}

export interface LeaseProjection {
  readonly runLeaseIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly taskLeaseIds: readonly string[];
}

export interface ActivityMutation {
  readonly expectedRunLeaseIds: readonly string[];
  readonly expectedTaskIds: readonly string[];
  readonly idempotencyKey: string;
  readonly nextRunLeaseIds: readonly string[];
  readonly nextTaskIds: readonly string[];
  readonly subAgentId: string;
}

export interface ConditionalTaskMutation {
  readonly expectedVersion: string;
  readonly idempotencyKey: string;
  readonly nextBody: string | null;
  readonly nextProperties: JsonObject;
  readonly nextStatus: string | null;
  readonly taskId: string;
}

export interface ResourceRef {
  readonly digest: string | null;
  readonly key: string;
  readonly version: string | null;
}

export interface ResourceRecord {
  readonly body: string;
  readonly dependencies: readonly ResourceRef[];
  readonly digest: string;
  readonly key: string;
  readonly kind: string;
  readonly state: "active" | "draft" | "retired";
  readonly version: string;
}

export interface ResourceMutation extends ResourceRecord {
  readonly idempotencyKey: string;
}

export interface ErrorMutation {
  readonly description: string;
  readonly errorKey: string;
  readonly idempotencyKey: string;
  readonly relatedRunId: string | null;
  readonly relatedSubAgentId: string | null;
  readonly relatedTaskId: string | null;
  readonly resolution: string;
  readonly severity: "critical" | "high" | "low" | "medium";
  readonly title: string;
}

export interface LeaseRequest {
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly ownerId: string;
  readonly scope: "agent_run" | "task_assignment";
  readonly subAgentId: string;
  readonly taskId: string | null;
}

export interface LeaseRenewal {
  readonly expectedExpiresAt: string;
  readonly idempotencyKey: string;
  readonly leaseId: string;
  readonly nextExpiresAt: string;
  readonly ownerId: string;
}

export interface LeaseRelease {
  readonly expectedVersion: string | null;
  readonly leaseId: string;
  readonly ownerId: string;
}

export interface LeaseSnapshot {
  readonly expiresAt: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly released: boolean;
  readonly scope: LeaseRequest["scope"];
  readonly subAgentId: string;
  readonly taskId: string | null;
  readonly version: string;
}

export interface LeaseResult {
  readonly acquired: boolean;
  readonly conflictingLeaseId: string | null;
  readonly leaseId: string | null;
}
