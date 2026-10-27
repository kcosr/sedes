import type { UsageSnapshot } from "../../../../../shared/protocol/conversation.js";
import type { PiManagedContextUsage } from "../rpc/pi-managed-protocol.js";

/** Native live occupancy is independent of cumulative token accounting. Pi
 * deliberately reports unknown occupancy after compaction until a new response. */
export function piNativeContextUsage(value: PiManagedContextUsage | undefined): UsageSnapshot["context"] {
  if (!value) return undefined;
  return {
    windowTokens: value.contextWindow,
    ...(value.tokens === null ? {} : { usedTokens: value.tokens }),
    ...(value.percent === null ? {} : { percent: value.percent }),
  };
}
