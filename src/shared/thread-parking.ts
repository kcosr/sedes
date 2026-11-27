import type { ThreadRunState } from "./protocol/conversation.js";

const park = { untilDone: false, label: "Park", description: undefined } as const;
const parkUntilDone = {
  untilDone: true,
  label: "Park until done",
  description: "Mutes progress speech. Returns to Active when this turn ends.",
} as const;

export function threadParkAction(runState: ThreadRunState) {
  switch (runState) {
    case "running":
    case "waiting_for_approval":
    case "waiting_for_input":
    case "stopping":
      return parkUntilDone;
    default:
      return park;
  }
}
