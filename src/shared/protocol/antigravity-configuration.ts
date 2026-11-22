import { z } from "zod";
import { normalizedAbsolutePath } from "../absolute-path.js";

const absolutePosixPath = z.string().min(1).max(4096).refine(
  value => value.startsWith("/") && normalizedAbsolutePath(value),
  "A canonical absolute path on the Linux or macOS execution host is required.",
);
const identifier = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.trim() === value && !/\p{Cc}/u.test(value), "An exact native identifier is required.");

/** Administration settings. ACP protocol types stay server-private. */
export const antigravityModuleConfigurationSchema = z.strictObject({
  executablePath: absolutePosixPath.optional(),
  geminiDirectory: absolutePosixPath.optional(),
  initializationTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
});

export const antigravityConnectionDefaultsSchema = z.strictObject({
  modelId: identifier(240).optional(),
  thinkingLevel: identifier(120).optional(),
  modeId: identifier(120).optional(),
});

export const antigravityConnectionConfigurationSchema = z.strictObject({
  defaults: antigravityConnectionDefaultsSchema.default({}),
});

export type AntigravityModuleConfiguration = z.infer<typeof antigravityModuleConfigurationSchema>;
export type AntigravityConnectionDefaults = z.infer<typeof antigravityConnectionDefaultsSchema>;
export type AntigravityConnectionConfiguration = z.infer<typeof antigravityConnectionConfigurationSchema>;
