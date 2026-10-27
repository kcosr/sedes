import type { OpenCodeNativeActivity, OpenCodeNativeInboxItem, OpenCodeNativeInteractions } from "./opencode-native-api.js";

/** Native work inventories, independent of whether old history has a terminal record. */
export function openCodeArchiveInventoriesAreIdle(
  activity: OpenCodeNativeActivity,
  pending: readonly OpenCodeNativeInboxItem[],
  interactions: OpenCodeNativeInteractions,
): boolean {
  return !activity.active && activity.activeChildren.length === 0 &&
    !activity.shells.some(shell => shell.status === "running") && pending.length === 0 &&
    interactions.permissions.length === 0 && interactions.forms.length === 0;
}
