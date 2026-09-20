import { z } from "zod";
import {
  automationPrecheckSchema,
  automationPromptSchema,
  automationScheduleSchema,
} from "../shared/protocol/automation.js";
import { createThreadRequestSchema } from "../shared/protocol/api.js";
import {
  automationDefinitionStatusSchema,
  automationMisfirePolicySchema,
  automationRunModeSchema,
} from "../shared/protocol/domain.js";

export const automationCliDefinitionSchema = z.strictObject({
  prompt: automationPromptSchema,
  runMode: automationRunModeSchema,
  schedule: automationScheduleSchema,
  misfirePolicy: automationMisfirePolicySchema,
  precheck: automationPrecheckSchema.nullable().default(null),
  state: automationDefinitionStatusSchema.optional(),
});

export const automationCliChecksSchema = z.strictObject({
  previewCount: z.number().int().min(0).max(10).default(0),
  testPrecheck: z.boolean().default(false),
});

export const automationCliInputSchema = z.strictObject({
  thread: createThreadRequestSchema.optional(),
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
