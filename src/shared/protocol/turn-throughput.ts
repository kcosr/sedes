import { z } from "zod";

/**
 * Volatile main-agent request measurements for one fully observed turn.
 * Output includes reasoning. Request time includes provider latency, but
 * excludes tools and gaps between requests. Never reconstructed from history.
 */
export const turnThroughputSchema = z.strictObject({
  outputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestDurationMs: z.number().positive().max(Number.MAX_SAFE_INTEGER),
}).refine((value) => Number.isFinite(value.outputTokens / (value.requestDurationMs / 1000)), {
  message: "Throughput must produce a finite rate.",
});
export type TurnThroughput = z.infer<typeof turnThroughputSchema>;
