import { z } from "zod";

const cronExpressionSchema = z.string().trim().min(1).max(160);
const timeZoneSchema = z.string().trim().min(1).max(120);
const maximumAutomationPromptBytes = 65_536;
const maximumPrecheckCommandBytes = 4_096;

export const automationPromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(maximumAutomationPromptBytes)
  .refine(
    (prompt) =>
      new TextEncoder().encode(prompt).byteLength <=
      maximumAutomationPromptBytes,
    "Prompt must be at most 65,536 UTF-8 bytes.",
  );

export const automationScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("date_time"),
    runAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal("interval"),
    anchorAt: z.iso.datetime(),
    everySeconds: z.number().int().min(300).max(31_536_000),
  }),
  z.strictObject({
    kind: z.literal("cron"),
    expression: cronExpressionSchema,
    timeZone: timeZoneSchema,
  }),
]);
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

export const automationPrecheckSchema = z.strictObject({
  command: z
    .string()
    .trim()
    .min(1)
    .max(maximumPrecheckCommandBytes)
    .refine(
      (command) =>
        new TextEncoder().encode(command).byteLength <=
        maximumPrecheckCommandBytes,
      "Command must be at most 4,096 UTF-8 bytes.",
    ),
  timeoutSeconds: z.number().int().min(1).max(60),
  includeStdout: z.boolean(),
});
export type AutomationPrecheck = z.infer<typeof automationPrecheckSchema>;
