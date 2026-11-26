import type { BulkInventoryAction } from "../../../shared/index.js";

/** Labels for the inventory actions a row or stack offers. */
export function inventoryActionLabel(
  action: BulkInventoryAction | "wake",
): string {
  switch (action) {
    case "park":
      return "Park";
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
