import type { BulkInventoryAction } from "../../../shared/index.js";

/**
 * Words for the inventory actions a row or stack offers. Park keeps its
 * original wire name: `settle` parks a thread and `unsettle` unparks it.
 */
export function inventoryActionLabel(
  action: BulkInventoryAction | "wake",
): string {
  switch (action) {
    case "settle":
      return "Park";
    case "unsettle":
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
    case "settle":
      return "Parking";
    case "unsettle":
      return "Unparking";
    case "archive":
      return "Archiving";
  }
}
