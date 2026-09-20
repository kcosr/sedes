import { z } from "zod";
import type { ClassifiedAssistantResult } from "./completion-result.js";
import type { InteractionKind } from "./interactions.js";

export const notificationEventKindSchema = z.enum([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "thread.woke",
  "automation.started",
  "automation.failed",
  "approval.requested",
  "input.requested",
  "question.requested",
]);
export type NotificationEventKind = z.infer<typeof notificationEventKindSchema>;

export const notificationAssistantResultPhaseSchema = z.enum([
  "provisional",
  "final",
  "unclassified",
]);
export type NotificationAssistantResultPhase = z.infer<
  typeof notificationAssistantResultPhaseSchema
>;

const scriptFields = {
  scriptPath: z
    .string()
    .max(4096)
    .refine(
      (value) => !value.includes("\0"),
      "Script path cannot contain NUL.",
    ),
  arguments: z
    .array(
      z
        .string()
        .max(4096)
        .refine(
          (value) => !value.includes("\0"),
          "Arguments cannot contain NUL.",
        ),
    )
    .max(64),
  timeoutSeconds: z.number().int().min(1).max(300),
};
const configFields = {
  enabled: z.boolean(),
  assistantResultPhases: z
    .array(notificationAssistantResultPhaseSchema)
    .max(3)
    .refine(
      (phases) => new Set(phases).size === phases.length,
      "Select each response phase only once.",
    ),
  ...scriptFields,
  events: z
    .array(notificationEventKindSchema)
    .max(notificationEventKindSchema.options.length)
    .refine(
      (events) => new Set(events).size === events.length,
      "Select each event only once.",
    ),
};
const validScript = (input: { enabled: boolean; scriptPath: string }) =>
  !input.enabled || input.scriptPath.startsWith("/");

export const notificationSettingsSchema = z
  .strictObject({
    ...configFields,
    silenced: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .refine(validScript, {
    message: "Enabled notifications require an absolute script path.",
    path: ["scriptPath"],
  });
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const updateNotificationSettingsRequestSchema = z
  .strictObject({
    ...configFields,
    expectedRevision: z.number().int().nonnegative(),
  })
  .refine(validScript, {
    message: "Enabled notifications require an absolute script path.",
    path: ["scriptPath"],
  });
export type UpdateNotificationSettingsRequest = z.infer<
  typeof updateNotificationSettingsRequestSchema
>;

export const setNotificationSilencedRequestSchema = z.strictObject({
  silenced: z.boolean(),
});
export type SetNotificationSilencedRequest = z.infer<
  typeof setNotificationSilencedRequestSchema
>;
export const testNotificationRequestSchema = z
  .strictObject(scriptFields)
  .refine((input) => input.scriptPath.startsWith("/"), {
    message: "Testing requires an absolute script path.",
    path: ["scriptPath"],
  });
export type TestNotificationRequest = z.infer<
  typeof testNotificationRequestSchema
>;

export const notificationTestResultSchema = z.strictObject({
  success: z.boolean(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  error: z.string().nullable(),
});
export type NotificationTestResult = z.infer<
  typeof notificationTestResultSchema
>;

/** Application-owned event data. No provider identities, prompts, or transcripts. */
export type NotificationEventPayload = {
  readonly event: NotificationEventKind;
  readonly occurredAt: string;
  readonly title: string;
  readonly message: string;
  readonly thread?: { readonly id: string; readonly title: string };
  readonly workspace?: { readonly id: string; readonly name: string };
  readonly turn?: {
    readonly id: string;
    readonly outcome: "completed" | "failed" | "interrupted";
  };
  readonly interaction?: {
    readonly id: string;
    readonly kind: InteractionKind;
  };
  readonly question?: {
    readonly id: string;
    readonly questionCount: number;
  };
  readonly wake?: { readonly reason: string; readonly reminderText?: string };
  readonly automation?: {
    readonly id: string;
    readonly name: string;
    readonly runId: string;
    readonly trigger: "scheduled" | "manual";
    readonly stage?: string;
    readonly diagnostic?: string;
  };
};
export type NotificationPayload = Omit<NotificationEventPayload, "event"> & {
  /** Selected completion text phases: omitted means excluded; null means unavailable. */
  readonly assistantResult?: Partial<ClassifiedAssistantResult>;
  readonly schemaVersion: 3;
  readonly notificationId: string;
  readonly event: NotificationEventKind | "notification.test";
};
