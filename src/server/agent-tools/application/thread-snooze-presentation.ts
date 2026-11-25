import type { InventoryPrincipalStateRecord } from "../../db/repositories/inventory-repository.js";

export interface AgentThreadSnoozeFields {
  readonly snoozedUntil?: string;
  readonly wakeReminder?: string | null;
}

export function projectAgentThreadSnooze({
  inventoryState,
  snoozedUntil,
  wakeReminderText,
}: Pick<
  InventoryPrincipalStateRecord,
  "inventoryState" | "snoozedUntil" | "wakeReminderText"
>): AgentThreadSnoozeFields {
  if (inventoryState !== "snoozed") return {};
  if (snoozedUntil === null) throw new Error("agent_thread_snooze_deadline_missing");
  return {
    snoozedUntil: new Date(snoozedUntil).toISOString(),
    wakeReminder: wakeReminderText,
  };
}
