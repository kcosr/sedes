const park = { untilDone: false, label: "Park", description: undefined } as const;
export const parkUntilDone = {
  untilDone: true,
  label: "Park until done",
  description: "Mutes progress speech. Returns to Active when this turn ends.",
} as const;

export function threadParkAction(parkUntilTurnEnd: boolean) {
  return parkUntilTurnEnd ? parkUntilDone : park;
}
