/** Provider environment references and provider-owned workspace contracts. */
import type { JsonObject } from "./json.js";

/** Importable provider module and its opaque provider-owned configuration. */
export interface ProviderEnvironment {
  /** Node.js module specifier exporting `agentTaskProviderModule`. */
  readonly module: string;
  /** Strict JSON passed unchanged to the selected provider module. */
  readonly options: JsonObject;
}

/** One path-addressed environment or workspace validation failure. */
export interface ValidationIssue {
  /** Machine-readable validation or provider error code. */
  readonly code: string;
  /** Human-readable validation issue description. */
  readonly message: string;
  /** Logical configuration or provider location associated with the issue. */
  readonly path: string;
}

/** Aggregate result of a non-mutating validation pass. */
export interface ValidationReport {
  /** Validation issues discovered for the environment or workspace. */
  readonly issues: readonly ValidationIssue[];
  /** Whether validation completed without issues. */
  readonly valid: boolean;
}

/** One deterministic provider-owned workspace operation. */
export interface WorkspaceStep {
  /** Provider-owned record identifier. */
  readonly id: string;
  /** Provider-defined operation classification. */
  readonly kind: string;
  /** JSON payload carried by the workspace step. */
  readonly payload: JsonObject;
}

/** Digest-bound additive workspace plan for one environment and target schema. */
export interface WorkspacePlan {
  /** Digest of the complete plan used for apply-time drift checking. */
  readonly digest: string;
  /** Stable identity used to isolate one managed environment. */
  readonly environmentId: string;
  /** Digest of the exact observed workspace schema used to derive the steps. */
  readonly observedSchemaDigest: string;
  /** Versioned schema identifier for the serialized object. */
  readonly schema: "workspace-plan-v1";
  /** Ordered workspace mutations authorized by the plan. */
  readonly steps: readonly WorkspaceStep[];
  /** Digest of the canonical schema the plan converges on. */
  readonly targetSchemaDigest: string;
  /** Provider-defined target whose current state the plan authorizes mutating. */
  readonly target: JsonObject;
}
