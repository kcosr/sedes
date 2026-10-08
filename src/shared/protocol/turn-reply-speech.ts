import { z } from "zod";
import { selectedAssistantResultSchema } from "./notification.js";

/**
 * Reply text for replaying one ended turn through native voice. The result is the
 * turn's stored completion classification filtered by the principal's current
 * `assistantResultPhases`; null means Sedes stored no classification for the turn.
 */
export const turnReplySpeechSchema = z.strictObject({
  assistantResult: selectedAssistantResultSchema.nullable(),
});
export type TurnReplySpeech = z.infer<typeof turnReplySpeechSchema>;
