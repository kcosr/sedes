import { z } from "zod";

/** Operator configuration only; native OpenCode protocol types stay server-private. */
const absolutePath = z.string().min(1).max(4096).refine(value =>
  value.startsWith("/") && !/[\u0000-\u001f\u007f]/u.test(value) &&
  (value === "/" || (!value.endsWith("/") && !value.includes("//") &&
    !value.split("/").some(part => part === "." || part === ".."))),
"A canonical absolute Linux path is required.");
const opaqueId = z.string().min(1).max(240).refine(value => !/\p{Cc}/u.test(value));

export const opencodeHttpUrlSchema = z.string().max(2048).refine(value => {
  const match = /^http:\/\/(127(?:\.(?:0|[1-9][0-9]{0,2})){3}|\[::1\]):([1-9][0-9]{0,4})\/?$/u.exec(value);
  if (!match || Number(match[2]) > 65535) return false;
  return match[1] === "[::1]" || match[1]!.split(".").every(part => Number(part) <= 255);
}, "OpenCode requires a loopback HTTP IP literal with an explicit port and no path.");

export const opencodePasswordReferenceSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("environment"), variable: z.string().max(128).regex(/^SEDES_OPENCODE_[A-Z0-9_]*PASSWORD[A-Z0-9_]*$/u) }),
  z.strictObject({ source: z.literal("protected_file"), path: absolutePath }),
]);

export const opencodeModuleConfigurationSchema = z.strictObject({
  nativeStorePath: absolutePath.refine(value => value !== "/", "Select the native SQLite database file.").optional(),
  configDirectory: absolutePath.optional(),
  connection: z.discriminatedUnion("ownership", [
    z.strictObject({ ownership: z.literal("owned"), channel: z.strictObject({
      type: z.literal("process_stdio"), executablePath: absolutePath.optional(), workingDirectory: absolutePath.optional(),
    }) }),
    z.strictObject({ ownership: z.literal("external"), channel: z.strictObject({
      type: z.literal("http"), url: opencodeHttpUrlSchema,
      authentication: z.strictObject({ type: z.literal("basic"), username: z.literal("opencode"), secret: opencodePasswordReferenceSchema }),
    }) }),
  ]),
});

export const opencodeConnectionDefaultsSchema = z.strictObject({
  model: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("catalogDefault") }),
    z.strictObject({ type: z.literal("fixed"), modelId: opaqueId }),
  ]),
  variant: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("modelDefault") }),
    z.strictObject({ type: z.literal("fixed"), variantId: opaqueId }),
  ]),
});
export type OpenCodeModuleConfiguration = z.infer<typeof opencodeModuleConfigurationSchema>;
export type OpenCodeConnectionDefaults = z.infer<typeof opencodeConnectionDefaultsSchema>;
