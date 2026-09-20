import { z } from "zod";
import { boundedDisplayTextSchema } from "./payload.js";

/** Live work owned by this runtime generation, independent of input readiness. */
export const backgroundActivitySchema = z.strictObject({
  state: z.enum(["known", "unknown"]),
  agents: z.number().int().min(0).max(1_000_000),
  commands: z.number().int().min(0).max(1_000_000),
  other: z.number().int().min(0).max(1_000_000),
  description: boundedDisplayTextSchema.optional(),
});
export type BackgroundActivity = z.infer<typeof backgroundActivitySchema>;

/** Uncertain activity must not authorize automatic runtime retirement. */
export function hasOutstandingBackgroundActivity(activity?: BackgroundActivity): boolean {
  return activity !== undefined &&
    (activity.state === "unknown" || activity.agents + activity.commands + activity.other > 0);
}
