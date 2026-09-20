import { z } from "zod";

export const applicationPreferencesSchema = z.strictObject({
  showOpenAIComposerSkills: z.boolean(),
  revision: z.number().int().nonnegative(),
});
export type ApplicationPreferences = z.infer<
  typeof applicationPreferencesSchema
>;

export const updateApplicationPreferencesRequestSchema = z.strictObject({
  showOpenAIComposerSkills: z.boolean(),
  expectedRevision: z.number().int().nonnegative(),
});
export type UpdateApplicationPreferencesRequest = z.infer<
  typeof updateApplicationPreferencesRequestSchema
>;
