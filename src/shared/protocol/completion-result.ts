import { z } from "zod";
import { boundedTextSchema } from "./payload.js";

/** A missing section means no message could be assigned to that phase. */
export const classifiedAssistantResultSchema = z.strictObject({
  provisional: boundedTextSchema.nullable(),
  final: boundedTextSchema.nullable(),
  unclassified: boundedTextSchema.nullable(),
});
export type ClassifiedAssistantResult = z.infer<
  typeof classifiedAssistantResultSchema
>;
