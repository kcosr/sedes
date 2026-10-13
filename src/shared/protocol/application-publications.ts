import { z } from "zod";

/** Application-owned output anchored to an exact provider-owned turn and item. */
export const applicationPublicationAnchorSchema = z.strictObject({
  turnId: z.string().min(1).max(160), afterItemId: z.string().min(1).max(160).optional(),
});
export type ApplicationPublicationAnchor = z.infer<typeof applicationPublicationAnchorSchema>;
