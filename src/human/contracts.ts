/** Provider-neutral provider-neutral human interaction slots and consumed authority contract. */
import type { JsonObject } from "../domain/json.js";

/** Enumerates the supported human slot kind variants. */
export type HumanSlotKind = "answer" | "resolution" | "review" | "testing";

/** Provider-neutral human slot response contract. */
export interface HumanSlotResponse {
  /** Human-selected response action. */
  readonly action: string;
  /** Human-supplied response text. */
  readonly text: string;
}

/** Provider-neutral human interaction slot contract. */
export interface HumanInteractionSlot {
  /** Canonical timestamp for created. */
  readonly createdAt: string;
  /** Monotonic slot generation used to reject stale responses. */
  readonly generation: number;
  /** Discriminates the kind variant. */
  readonly kind: HumanSlotKind;
  /** Prompt displayed to the human. */
  readonly prompt: string;
  /** Actor that requested the human decision. */
  readonly requestedBy: string;
  /** Optional human response attached to the slot. */
  readonly response: HumanSlotResponse | null;
  /** Action-to-status transitions allowed for the slot. */
  readonly routes: Readonly<Record<string, string>>;
  /** Version tag for the human interaction slot representation. */
  readonly schema: "human-interaction-slot-v1";
  /** Stable identifier for slot id. */
  readonly slotId: string;
  /** Source error key dependency consumed by source error. */
  readonly sourceErrorKey: string | null;
  /** Stable identifier for task id. */
  readonly taskId: string;
}

/** Provider-neutral human authority contract. */
export interface HumanAuthority {
  /** Human-selected response action. */
  readonly action: string;
  /** SHA-256 digest of canonical response. */
  readonly responseDigest: string;
  /** Version tag for the human authority representation. */
  readonly schema: "human-authority-v1";
  /** Stable identifier for slot id. */
  readonly slotId: string;
  /** Workflow status for target. */
  readonly targetStatus: string;
  /** Human-supplied response text. */
  readonly text: string;
}

/** Persisted state for human consumption. */
export interface HumanConsumptionRecord {
  /** Opaque version token for applied task. */
  readonly appliedTaskVersion: string | null;
  /** Consumed human authority proving approval. */
  readonly authority: HumanAuthority;
  /** Version tag for the human consumption record representation. */
  readonly schema: "human-consumption-v1";
  /** Workflow status for source. */
  readonly sourceStatus: string;
  /** Opaque version token for source task. */
  readonly sourceTaskVersion: string;
  /** Lifecycle state used for workflow decisions. */
  readonly state: "applied" | "pending";
  /** Stable identifier for task id. */
  readonly taskId: string;
}

/** Persisted state for human slot baseline. */
export interface HumanSlotBaselineRecord {
  /** Version tag for the human slot baseline record representation. */
  readonly schema: "human-slot-baseline-v2";
  /** Immutable interaction slot presented to the human. */
  readonly slot: HumanInteractionSlot;
  /** Indicates whether task archived. */
  readonly taskArchived: boolean;
  /** SHA-256 digest of canonical task body. */
  readonly taskBodyDigest: string;
  /** Task properties captured with the human baseline. */
  readonly taskProperties: JsonObject;
  /** SHA-256 digest of canonical task properties. */
  readonly taskPropertiesDigest: string;
  /** Workflow status for waiting. */
  readonly waitingStatus: string;
}
