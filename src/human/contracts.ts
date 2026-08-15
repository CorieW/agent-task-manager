// Defines provider-neutral human interaction slots and consumed authority.
export type HumanSlotKind = "answer" | "resolution" | "review" | "testing";

export interface HumanSlotResponse {
  readonly action: string;
  readonly text: string;
}

export interface HumanInteractionSlot {
  readonly createdAt: string;
  readonly generation: number;
  readonly kind: HumanSlotKind;
  readonly prompt: string;
  readonly requestedBy: string;
  readonly response: HumanSlotResponse | null;
  readonly routes: Readonly<Record<string, string>>;
  readonly schema: "human-interaction-slot-v1";
  readonly slotId: string;
  readonly sourceErrorKey: string | null;
  readonly taskId: string;
}

export interface HumanAuthority {
  readonly action: string;
  readonly responseDigest: string;
  readonly schema: "human-authority-v1";
  readonly slotId: string;
  readonly targetStatus: string;
  readonly text: string;
}

export interface HumanConsumptionRecord {
  readonly appliedTaskVersion: string | null;
  readonly authority: HumanAuthority;
  readonly schema: "human-consumption-v1";
  readonly sourceStatus: string;
  readonly state: "applied" | "pending";
  readonly taskId: string;
}
