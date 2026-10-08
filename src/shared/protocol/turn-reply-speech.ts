import { z } from "zod";
import { selectedAssistantResultSchema } from "./notification.js";

/**
 * Reply text for replaying one ended turn through native voice. The result is the
 * turn's stored completion classification filtered by the principal's current
 * `assistantResultPhases`, or the turn's stored whole reply as `{ unclassified }`
 * when that selection has no non-blank text; null means Sedes stored no reply
 * text for the turn.
 */
export const turnReplySpeechSchema = z.strictObject({
  assistantResult: selectedAssistantResultSchema.nullable(),
});
export type TurnReplySpeech = z.infer<typeof turnReplySpeechSchema>;
