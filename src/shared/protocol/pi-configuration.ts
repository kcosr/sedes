import { z } from "zod";
import { normalizedAbsolutePath } from "../absolute-path.js";

/** Administration settings only. Pi's RPC protocol remains server-private. */
const absolutePath = z.string().min(1).max(4096).refine(
  normalizedAbsolutePath,
  "A canonical absolute path on the execution host is required.",
);
const identifier = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => !/\p{Cc}/u.test(value), "Control characters are not allowed.");

export const piNativeThinkingLevelSchema = z.enum([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

export const piNativeModuleConfigurationSchema = z.strictObject({
  executablePath: absolutePath.optional(),
  agentDirectory: absolutePath.optional(),
  sessionDirectory: absolutePath.optional(),
  projectTrusted: z.boolean().default(false),
  initializationTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
});

export const piNativeConnectionDefaultsSchema = z.strictObject({
  provider: identifier(120).optional(),
  model: identifier(240).optional(),
  thinkingLevel: piNativeThinkingLevelSchema.optional(),
}).refine(value => (value.provider === undefined) === (value.model === undefined), {
  message: "Set both the model provider and model ID, or leave both at the native default.",
  path: ["model"],
});

export const piNativeConnectionConfigurationSchema = z.strictObject({
  defaults: piNativeConnectionDefaultsSchema.default({}),
});

export type PiNativeModuleConfiguration = z.infer<typeof piNativeModuleConfigurationSchema>;
export type PiNativeConnectionDefaults = z.infer<typeof piNativeConnectionDefaultsSchema>;
export type PiNativeConnectionConfiguration = z.infer<typeof piNativeConnectionConfigurationSchema>;
