import { threadParkAction } from "../../../shared/thread-parking.js";
import type { BulkInventoryAction, ThreadRunState } from "../../../shared/index.js";

/** Labels for the inventory actions a row or stack offers. */
export function inventoryActionLabel(
  action: BulkInventoryAction | "wake",
  runState: ThreadRunState = "idle",
): string {
  switch (action) {
    case "park":
      return threadParkAction(runState).label;
    case "unpark":
      return "Unpark";
    case "archive":
      return "Archive";
    case "wake":
      return "Wake";
  }
}

/** The pending form of a stack action, as in "Parking…". */
export function inventoryActionProgress(action: BulkInventoryAction): string {
  switch (action) {
    case "park":
      return "Parking";
    case "unpark":
      return "Unparking";
    case "archive":
      return "Archiving";
  }
}
