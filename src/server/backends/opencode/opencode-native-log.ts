import type { OpenCodeNativePort } from "./opencode-native-port.js";
import type { OpenCodeNativeLogReadInput, OpenCodeNativeLogCut } from "./opencode-native-codecs.js";
export { OpenCodeNativeLogError, OPENCODE_NATIVE_LOG_LIMITS } from "./opencode-native-codecs.js";
export type { OpenCodeNativeDurableEvent, OpenCodeNativeLogLimits, OpenCodeNativeLogGap,
  OpenCodeNativeLogCut, OpenCodeNativeLogReadInput } from "./opencode-native-codecs.js";

/** Finite, bounded experimental log read. A synced watermark is not replay evidence. */
export async function readOpenCodeNativeLog(client: OpenCodeNativePort, input: OpenCodeNativeLogReadInput): Promise<OpenCodeNativeLogCut> {
  const { signal, ...request } = input;
  const result = await client.read("readLog", request, { signal });
  return { ...result, watermark: result.watermark ?? undefined };
}
