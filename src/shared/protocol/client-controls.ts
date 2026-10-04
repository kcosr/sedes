import { z } from "zod";

export const clientVoiceSettingsSchema = z.strictObject({
  audioMode: z.enum(["off", "manual", "response"]),
  voiceThreadId: z.string().uuid().nullable(),
  pinDefaultVoiceThread: z.boolean(),
  autoListen: z.boolean(),
  onlyVoiceThread: z.boolean(),
  ignoreOtherDevices: z.boolean(),
  followComposerMode: z.boolean(),
});
export const clientVoicePatchSchema = clientVoiceSettingsSchema.partial().refine(value => Object.keys(value).length > 0);
export const clientCapabilitiesSchema = z.strictObject({
  navigate: z.boolean(), voice: z.boolean(), voiceSettings: z.boolean(),
});
export const clientRuntimeSchema = z.strictObject({
  foreground: z.boolean(), voiceReady: z.boolean(), interactionActive: z.boolean(),
});
export const clientSettingsSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(), voice: clientVoiceSettingsSchema,
});
export const clientStateSchema = z.strictObject({
  runtime: clientRuntimeSchema,
  settings: clientSettingsSnapshotSchema.nullable(),
});
export const registerClientSchema = z.strictObject({
  platform: z.enum(["browser", "electron", "android"]),
  capabilities: clientCapabilitiesSchema,
  state: clientStateSchema,
});
export const registeredClientSchema = z.strictObject({
  clientId: z.string().uuid(), connectionToken: z.string().min(32).max(128),
});
export type RegisteredClient = z.infer<typeof registeredClientSchema>;
export const clientActionResultSchema = z.strictObject({
  status: z.enum(["applied", "accepted", "noop", "failed"]),
  reason: z.string().min(1).max(160).optional(),
  state: clientStateSchema,
});
export const clientCommandSchema = z.strictObject({
  id: z.string().uuid(),
  action: z.enum(["settings.get", "settings.update", "end_interaction", "switch_thread", "turn_settled"]),
  expiresAt: z.number().int().nonnegative(),
  sourceThreadId: z.string().min(1).max(128),
  sourceTurnId: z.string().min(1).max(128),
  threadId: z.string().uuid().optional(),
  threadTitle: z.string().max(512).nullable().optional(),
  listen: z.boolean().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  patch: clientVoicePatchSchema.optional(),
  replyEventId: z.string().max(128).nullable().optional(),
});
export const clientPollRequestSchema = z.strictObject({
  state: clientStateSchema,
  acknowledgements: z.array(z.strictObject({ id: z.string().uuid(), result: clientActionResultSchema })).max(64),
});
export const clientPollResultSchema = z.strictObject({ commands: z.array(clientCommandSchema).max(64) });
export type ClientState = z.infer<typeof clientStateSchema>;
export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type ClientActionResult = z.infer<typeof clientActionResultSchema>;
