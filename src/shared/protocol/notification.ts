import { z } from "zod";
import { normalizedAbsolutePath } from "../absolute-path.js";
import type { ClassifiedAssistantResult } from "./completion-result.js";
import type { InteractionKind } from "./interactions.js";
import { interactionKindSchema } from "./interactions.js";
import { boundedTextSchema, requireSerializedByteLimit } from "./payload.js";

export const notificationEventKindSchema = z.enum([
  "turn.progress",
  "turn.partial",
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

export const voiceActionSchema = z.enum(["none", "speak", "speakThenListen"]);
export type VoiceAction = z.infer<typeof voiceActionSchema>;
export const eventDeliverySchema = z.strictObject({
  script: z.boolean(),
  voice: voiceActionSchema,
});
export const notificationDeliverySchema = z.record(notificationEventKindSchema, eventDeliverySchema)
  .superRefine((delivery, context) => {
    for (const event of ["turn.progress", "turn.partial", "approval.requested", "input.requested", "question.requested"] as const) {
      if (delivery[event].voice === "speakThenListen") context.addIssue({
        code: "custom", path: [event, "voice"], message: "This event cannot start recognition.",
      });
    }
  });
export type NotificationDelivery = z.infer<typeof notificationDeliverySchema>;

export function defaultNotificationDelivery(): NotificationDelivery {
  return Object.fromEntries(notificationEventKindSchema.options.map((event) => [event, {
    script: false, voice: event === "turn.completed" ? "speakThenListen" : event === "turn.partial" ? "none" : "speak",
  }])) as NotificationDelivery;
}

export const notificationAssistantResultPhaseSchema = z.enum([
  "provisional",
  "partial",
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
    .max(4)
    .refine(
      (phases) => new Set(phases).size === phases.length,
      "Select each response phase only once.",
    ),
  ...scriptFields,
  delivery: notificationDeliverySchema,
};
// Preserve existing POSIX absolute spellings; native Windows paths also need
// drive/share authority without device namespaces or alternate data streams.
const absoluteScriptPath = (value: string) =>
  value.startsWith("/") || normalizedAbsolutePath(value);
const validScript = (input: { enabled: boolean; scriptPath: string; delivery: NotificationDelivery }) =>
  !input.enabled || !Object.values(input.delivery).some((entry) => entry.script) || absoluteScriptPath(input.scriptPath);

export const notificationSettingsSchema = z
  .strictObject({
    ...configFields,
    silenced: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .refine(validScript, {
    message: "Enabled script delivery requires an absolute script path.",
    path: ["scriptPath"],
  });
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const updateNotificationSettingsRequestSchema = z
  .strictObject({
    ...configFields,
    expectedRevision: z.number().int().nonnegative(),
  })
  .refine(validScript, {
    message: "Enabled script delivery requires an absolute script path.",
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
  .refine((input) => absoluteScriptPath(input.scriptPath), {
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
    readonly outcome?: "completed" | "failed" | "interrupted";
  };
  readonly progress?: { readonly phase: "provisional" | "partial"; readonly itemId: string; readonly text: string; readonly truncation?: z.infer<typeof boundedTextSchema>["truncation"] };
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
  readonly schemaVersion: 5;
  readonly notificationId: string;
  readonly event: NotificationEventKind | "notification.test";
};

/** Completion text phases chosen by `assistantResultPhases`: omitted means excluded; null means unavailable. */
export const selectedAssistantResultSchema = z.strictObject({
  provisional: boundedTextSchema.nullable().optional(),
  partial: boundedTextSchema.nullable().optional(),
  unclassified: boundedTextSchema.nullable().optional(),
  final: boundedTextSchema.nullable().optional(),
});
export type SelectedAssistantResult = z.infer<typeof selectedAssistantResultSchema>;

const identity = z.string().min(1).max(512);
const noticeText = z.string().max(65_536);
export const notificationPayloadSchema = z.strictObject({
  schemaVersion: z.literal(5),
  notificationId: identity,
  event: z.union([notificationEventKindSchema, z.literal("notification.test")]),
  occurredAt: z.iso.datetime(), title: noticeText, message: noticeText,
  thread: z.strictObject({ id: identity, title: noticeText }).optional(),
  workspace: z.strictObject({ id: identity, name: noticeText }).optional(),
  turn: z.strictObject({ id: identity, outcome: z.enum(["completed", "failed", "interrupted"]).optional() }).optional(),
  progress: boundedTextSchema.extend({ itemId: identity, phase: z.enum(["provisional", "partial"]) }).optional(),
  interaction: z.strictObject({ id: identity, kind: interactionKindSchema }).optional(),
  question: z.strictObject({ id: identity, questionCount: z.number().int().nonnegative() }).optional(),
  wake: z.strictObject({ reason: noticeText, reminderText: noticeText.optional() }).optional(),
  automation: z.strictObject({ id: identity, name: noticeText, runId: identity,
    trigger: z.enum(["scheduled", "manual"]), stage: noticeText.optional(), diagnostic: noticeText.optional() }).optional(),
  assistantResult: selectedAssistantResultSchema.optional(),
}).superRefine((value, context) => {
  requireSerializedByteLimit(value, context, 65_536, "Notification exceeds 64 KiB.");
  const phase = value.event === "turn.progress" ? "provisional" : value.event === "turn.partial" ? "partial" : undefined;
  if (phase !== undefined && value.progress?.phase !== phase) {
    context.addIssue({ code: "custom", path: ["progress", "phase"], message: "Live reply phase must match its notification event." });
  } else if (phase === undefined && value.progress !== undefined) {
    context.addIssue({ code: "custom", path: ["progress"], message: "Only live reply notifications carry progress text." });
  }
});

export const voiceRecognitionTargetSchema = z.strictObject({
  threadId: identity, activityToken: identity, sourceTurnId: identity.optional(),
});
export type VoiceRecognitionTarget = z.infer<typeof voiceRecognitionTargetSchema>;
export const notificationPolicySchema = z.strictObject({
  generation: z.number().int().nonnegative(), settings: notificationSettingsSchema,
});
export type NotificationPolicy = z.infer<typeof notificationPolicySchema>;
export const voiceNotificationSchema = z.strictObject({
  payload: notificationPayloadSchema,
  sourceEventId: identity,
  voice: voiceActionSchema,
  generation: z.number().int().nonnegative(),
  userInputRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  origin: z.strictObject({ clientId: identity }).optional(),
  recognitionTarget: voiceRecognitionTargetSchema.optional(),
  /** Only state-attention events with the same explicit subject may coalesce. */
  subjectId: identity.optional(),
}).superRefine((value, context) => {
  const turnEvent = value.payload.event.startsWith("turn.");
  if (turnEvent !== (value.userInputRevision !== undefined)) {
    context.addIssue({ code: "custom", path: ["userInputRevision"], message: "Input revision is required exactly for turn voice notifications." });
  }
  if (turnEvent && !value.payload.thread) {
    context.addIssue({ code: "custom", path: ["payload", "thread"], message: "Turn voice notifications require a source thread." });
  }
  if (turnEvent && value.recognitionTarget && value.recognitionTarget.threadId !== value.payload.thread?.id) {
    context.addIssue({ code: "custom", path: ["recognitionTarget", "threadId"], message: "A turn's recognition target must match its source thread." });
  }
  if ((value.payload.event === "turn.progress" || value.payload.event === "turn.partial") && value.voice === "speakThenListen") {
    context.addIssue({ code: "custom", path: ["voice"], message: "Live reply notifications cannot start recognition." });
  }
});
export type VoiceNotification = z.infer<typeof voiceNotificationSchema>;
