import { z } from "zod";
import {
  automationNameSchema,
  automationPrecheckSchema,
  automationPromptSchema,
  automationScheduleSchema,
} from "../shared/protocol/automation.js";
import {
  automationMisfirePolicySchema,
  automationRunModeSchema,
} from "../shared/protocol/domain.js";

export const automationCliDefinitionSchema = z.strictObject({
  name: automationNameSchema,
  prompt: automationPromptSchema,
  runMode: automationRunModeSchema,
  schedule: automationScheduleSchema,
  misfirePolicy: automationMisfirePolicySchema.nullable(),
  precheck: automationPrecheckSchema.nullable().default(null),
  initialState: z.enum(["enabled", "paused"]).optional(),
}).superRefine((definition, context) => {
  if ((definition.schedule.kind === "date_time") !== (definition.misfirePolicy === null)) {
    context.addIssue({
      code: "custom",
      path: ["misfirePolicy"],
      message: "Use null for a one-time schedule and skip or coalesce for a recurring schedule.",
    });
  }
});

export const automationCliChecksSchema = z.strictObject({
  previewCount: z.number().int().min(0).max(10).default(0),
  testPrecheck: z.boolean().default(false),
});

export const automationCliInputSchema = z.strictObject({
  automation: automationCliDefinitionSchema,
  checks: automationCliChecksSchema.default({
    previewCount: 0,
    testPrecheck: false,
  }),
});

export type AutomationCliDefinition = z.infer<
  typeof automationCliDefinitionSchema
>;
export type AutomationCliInput = z.infer<typeof automationCliInputSchema>;
