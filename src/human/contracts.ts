/** Defines provider-neutral human interaction slots and consumed authority. */
import type { JsonObject } from "../domain/json.js";

/** Enumerates the supported human slot kind variants. */
export type HumanSlotKind = "answer" | "resolution" | "review" | "testing";

/** Defines the data and behavior required by human slot response. */
export interface HumanSlotResponse {
  /** Provides action to human slot response. */
  readonly action: string;
  /** Provides text to human slot response. */
  readonly text: string;
}

/** Defines the data and behavior required by human interaction slot. */
export interface HumanInteractionSlot {
  /** Records the canonical timestamp for created. */
  readonly createdAt: string;
  /** Provides generation to human interaction slot. */
  readonly generation: number;
  /** Discriminates the kind variant. */
  readonly kind: HumanSlotKind;
  /** Provides prompt to human interaction slot. */
  readonly prompt: string;
  /** Identifies the actor that requested human interaction. */
  readonly requestedBy: string;
  /** Provides response to human interaction slot. */
  readonly response: HumanSlotResponse | null;
  /** Provides routes to human interaction slot. */
  readonly routes: Readonly<Record<string, string>>;
  /** Version tag for the human interaction slot representation. */
  readonly schema: "human-interaction-slot-v1";
  /** Identifies slot. */
  readonly slotId: string;
  /** Identifies source error. */
  readonly sourceErrorKey: string | null;
  /** Identifies task. */
  readonly taskId: string;
}

/** Defines the data and behavior required by human authority. */
export interface HumanAuthority {
  /** Provides action to human authority. */
  readonly action: string;
  /** Stores the SHA-256 digest of response. */
  readonly responseDigest: string;
  /** Version tag for the human authority representation. */
  readonly schema: "human-authority-v1";
  /** Identifies slot. */
  readonly slotId: string;
  /** Records the current target status for workflow decisions. */
  readonly targetStatus: string;
  /** Provides text to human authority. */
  readonly text: string;
}

/** Defines the data and behavior required by human consumption record. */
export interface HumanConsumptionRecord {
  /** Records the applied task version used for compatibility checks. */
  readonly appliedTaskVersion: string | null;
  /** Provides authority to human consumption record. */
  readonly authority: HumanAuthority;
  /** Version tag for the human consumption record representation. */
  readonly schema: "human-consumption-v1";
  /** Records the current source status for workflow decisions. */
  readonly sourceStatus: string;
  /** Records the source task version used for compatibility checks. */
  readonly sourceTaskVersion: string;
  /** Records the current state for workflow decisions. */
  readonly state: "applied" | "pending";
  /** Identifies task. */
  readonly taskId: string;
}

/** Defines the data and behavior required by human slot baseline record. */
export interface HumanSlotBaselineRecord {
  /** Version tag for the human slot baseline record representation. */
  readonly schema: "human-slot-baseline-v2";
  /** Provides slot to human slot baseline record. */
  readonly slot: HumanInteractionSlot;
  /** Indicates whether task archived. */
  readonly taskArchived: boolean;
  /** Stores the SHA-256 digest of task body. */
  readonly taskBodyDigest: string;
  /** Provides task properties to human slot baseline record. */
  readonly taskProperties: JsonObject;
  /** Stores the SHA-256 digest of task properties. */
  readonly taskPropertiesDigest: string;
  /** Records the current waiting status for workflow decisions. */
  readonly waitingStatus: string;
}
