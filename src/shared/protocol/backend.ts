import { formFieldsSchema, formAnswersSchema } from "./interactions.js";
import { nonblockingQuestionsPayloadSchema } from "./questions.js";
import { backgroundActivitySchema } from "./background-activity.js";
import { z } from "zod";
import {
  allowedImageMimeSchema,
  agentToolInvocationCorrelationSchema,
  boundedDisplayTextSchema,
  boundedTextSchema,
  messageTextSchema,
  MAXIMUM_MESSAGE_ITEM_BYTES,
  boundedToolResultSchema,
  boundedValueSchema,
  fileReplacementSchema,
  fileRangeSchema,
  MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
  MAXIMUM_BROWSER_ENTITY_BYTES,
  operationPhaseSchema,
  PAYLOAD_LIMITS,
  requireSerializedByteLimit,
  requireConsistentFileReplacement,
  safeItemErrorSchema,
  turnFailureSchema,
  unifiedDiffSchema,
} from "./payload.js";
import { normalizedImageSchema } from "./output-artifacts.js";
import {
  MAXIMUM_NORMALIZED_ITEMS_PER_TURN,
  MAXIMUM_USER_MESSAGE_CONTENT_PARTS,
  reasoningSummaryPartsSchema,
  runtimeNoticeSchema,
  usageSnapshotSchema,
} from "./conversation.js";
import {
  MAXIMUM_PROVIDER_FEATURES_PER_CONVERSATION_ITEM,
  providerFeatureConversationItemEnvelopeSchema,
} from "./provider-feature.js";
import {
  contextExcerptSchema,
  requireValidContextExcerptContentParts,
} from "./context-excerpts.js";
import {
  decisionActionRoleSchema,
  interactionKindSchema,
  interactionInvocationSchema,
  INTERACTION_LIMITS,
  questionnaireQuestionPresentationShape,
  questionnaireSingleChoicePresentationShape,
  questionnaireTextInputSchema,
  backendQuestionnaireAnswerSchema,
} from "./interactions.js";
import {
  composerAttachmentDescriptorSchema,
  requireUniqueComposerAttachmentContentParts,
} from "./composer-attachments.js";
import {
  materializedTaskContextSchema,
  requireUniqueTaskContextContentParts,
} from "./tasks.js";

export const MAXIMUM_BACKEND_ITEMS_PER_TURN = MAXIMUM_NORMALIZED_ITEMS_PER_TURN;

export const backendTurnSchema = z
  .strictObject({
    backendTurnId: z.string().min(1).max(512),
    /**
     * Application-generated submission identities echoed by the backend.
     * Multiple operations can contribute to one provider-native turn (for
     * example, mid-turn steering), so every accepted operation is retained.
     * The field is absent only when no operation came through this application.
     */
    completionCorrelations: z
      .array(z.string().min(1).max(512))
      .min(1)
      .max(1_000)
      .optional(),
    status: z.enum(["in_progress", "completed", "interrupted", "failed"]),
    failure: turnFailureSchema.optional(),
    endedBy: z
      .enum(["agent_settled", "steer", "interrupted", "failed"])
      .optional(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    /**
     * Why this successfully completed turn cannot be an exact fork boundary
     * for this backend. Absent means the backend's branching capability
     * alone decides.
     */
    forkUnavailableReason: boundedDisplayTextSchema.optional(),
    orderedBackendItemIds: z
      .array(z.string().min(1).max(512))
      .max(MAXIMUM_BACKEND_ITEMS_PER_TURN),
  })
  .superRefine((turn, context) => {
    if (turn.failure !== undefined && turn.status !== "failed") {
      context.addIssue({ code: "custom", path: ["failure"], message: "Failure details belong to failed turns only." });
    }
    if (turn.forkUnavailableReason !== undefined && turn.status !== "completed") {
      context.addIssue({ code: "custom", path: ["forkUnavailableReason"], message: "Only a completed turn can explain why it is not a fork boundary." });
    }
    if (turn.completionCorrelations) {
      requireUniqueIdentifiers(
        turn.completionCorrelations,
        context,
        ["completionCorrelations"],
        "Backend turn completion correlations must be unique.",
      );
    }
    requireUniqueIdentifiers(
      turn.orderedBackendItemIds,
      context,
      ["orderedBackendItemIds"],
      "Backend turn item identifiers must be unique.",
    );
  });
export type BackendTurn = z.infer<typeof backendTurnSchema>;

const backendItemBaseShape = {
  backendItemId: z.string().min(1).max(512),
  backendTurnId: z.string().min(1).max(512),
  status: z.enum(["streaming", "completed", "failed", "interrupted"]),
  sourceOrder: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  error: safeItemErrorSchema.optional(),
  providerFeatures: z
    .array(providerFeatureConversationItemEnvelopeSchema)
    .max(MAXIMUM_PROVIDER_FEATURES_PER_CONVERSATION_ITEM)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        const key = `${value.ref.featureId}@${value.ref.schemaVersion}`;
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate provider feature "${key}".`,
            path: [index],
          });
        }
        seen.add(key);
      }
    })
    .optional(),
} as const;

function requireConsistentBackendOperationState(
  value: { status: string; phase: string },
  context: z.RefinementCtx,
): void {
  const terminal = new Set(["completed", "failed", "interrupted"]);
  const statusTerminal = terminal.has(value.status);
  const phaseTerminal = terminal.has(value.phase);
  if (
    statusTerminal !== phaseTerminal ||
    (statusTerminal && value.status !== value.phase)
  ) {
    context.addIssue({
      code: "custom",
      message: "Backend operation status and phase are contradictory.",
      path: ["phase"],
    });
  }
}

const backendMessageContentPartSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: messageTextSchema }),
  z.strictObject({
    kind: z.literal("skill"),
    name: boundedDisplayTextSchema,
  }),
  z.strictObject({
    kind: z.literal("context_excerpt"),
    excerpt: contextExcerptSchema,
  }),
  z.strictObject({
    kind: z.literal("task_context"),
    task: materializedTaskContextSchema,
  }),
  z.strictObject({
    kind: z.literal("image"),
    mimeType: allowedImageMimeSchema.optional(),
    fileName: boundedDisplayTextSchema.optional(),
    alt: boundedDisplayTextSchema.optional(),
    omitted: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("attachment"),
    attachment: composerAttachmentDescriptorSchema,
  }),
]);

const backendPlanEntrySchema = z.strictObject({
  id: z.string().min(1).max(512),
  text: boundedDisplayTextSchema,
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
});

const schemas = [
  z
    .strictObject({
      ...backendItemBaseShape,
      semanticKind: z.literal("user_message"),
      deliveryOperationId: z.string().min(1).max(160).optional(),
      content: z
        .array(backendMessageContentPartSchema)
        .min(1)
        .max(MAXIMUM_USER_MESSAGE_CONTENT_PARTS),
    })
    .superRefine((message, context) => {
      requireValidContextExcerptContentParts(message.content, context);
      requireUniqueComposerAttachmentContentParts(message.content, context);
      requireUniqueTaskContextContentParts(message.content, context);
      if (
        message.deliveryOperationId === undefined &&
        message.content.some(
          ({ kind }) => kind === "attachment" || kind === "task_context",
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A durable backend message attachment or task context requires an authenticated delivery operation.",
          path: ["deliveryOperationId"],
        });
      }
    }),
  z.strictObject({
    ...backendItemBaseShape,
    semanticKind: z.literal("assistant_message"),
    responsePhase: z.enum(["provisional", "final", "unclassified"]).optional(),
    nonblockingQuestions: nonblockingQuestionsPayloadSchema.optional(),
    markdown: messageTextSchema,
  }),
  z.strictObject({
    ...backendItemBaseShape,
    semanticKind: z.literal("reasoning"),
    summaryParts: reasoningSummaryPartsSchema.optional(),
    markdown: boundedTextSchema,
  }),
  z.strictObject({
    ...backendItemBaseShape,
    semanticKind: z.literal("plan"),
    entries: z
      .array(backendPlanEntrySchema)
      .max(PAYLOAD_LIMITS.collectionEntries),
  }),
  z
    .strictObject({
      ...backendItemBaseShape,
      semanticKind: z.literal("command"),
      phase: operationPhaseSchema,
      command: boundedDisplayTextSchema,
      cwd: boundedDisplayTextSchema.optional(),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
      output: boundedTextSchema.optional(),
      exitCode: z.number().int().optional(),
      durationMs: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    })
    .superRefine(requireConsistentBackendOperationState),
  z
    .strictObject({
      ...backendItemBaseShape,
      semanticKind: z.literal("file_read"),
      phase: operationPhaseSchema,
      path: boundedDisplayTextSchema,
      range: fileRangeSchema.optional(),
      contentPreview: boundedTextSchema.optional(),
    })
    .superRefine(requireConsistentBackendOperationState),
  z
    .strictObject({
      ...backendItemBaseShape,
      semanticKind: z.literal("file_change"),
      phase: operationPhaseSchema,
      operation: z.enum(["write", "edit", "delete", "move"]),
      effect: z.enum(["proposed", "applied", "not_applied", "unknown"]),
      path: boundedDisplayTextSchema,
      destinationPath: boundedDisplayTextSchema.optional(),
      range: fileRangeSchema.optional(),
      diff: unifiedDiffSchema.optional(),
      contentPreview: boundedTextSchema.optional(),
      replacement: fileReplacementSchema.optional(),
      additions: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
      deletions: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    })
    .superRefine((value, context) => {
      requireConsistentBackendOperationState(value, context);
      requireConsistentFileReplacement(value, context);
    }),
  z
    .strictObject({
      ...backendItemBaseShape,
      semanticKind: z.literal("tool"),
      phase: operationPhaseSchema,
      toolName: boundedDisplayTextSchema,
      title: boundedDisplayTextSchema,
      category: z.enum([
        "search",
        "filesystem",
        "network",
        "computation",
        "other",
      ]),
      agentToolInvocation: agentToolInvocationCorrelationSchema.optional(),
      arguments: boundedValueSchema.optional(),
      result: boundedToolResultSchema.optional(),
    })
    .superRefine(requireConsistentBackendOperationState),
  z
    .strictObject({
      ...backendItemBaseShape,
      semanticKind: z.literal("mcp"),
      phase: operationPhaseSchema,
      server: boundedDisplayTextSchema,
      toolName: boundedDisplayTextSchema,
      arguments: boundedValueSchema.optional(),
      result: boundedToolResultSchema.optional(),
      durationMs: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    })
    .superRefine(requireConsistentBackendOperationState),
  z
    .strictObject({
      ...backendItemBaseShape,
      semanticKind: z.literal("web_search"),
      phase: operationPhaseSchema,
      query: boundedDisplayTextSchema.optional(),
      result: boundedToolResultSchema.optional(),
    })
    .superRefine(requireConsistentBackendOperationState),
  z.strictObject({
    ...backendItemBaseShape,
    semanticKind: z.literal("collaboration"),
    action: z.enum(["spawn", "message", "result", "status"]),
    agentLabel: boundedDisplayTextSchema.optional(),
    summary: boundedTextSchema.optional(),
  }),
  z.strictObject({
    ...backendItemBaseShape,
    semanticKind: z.literal("image"),
    image: normalizedImageSchema,
  }),
  z.strictObject({
    ...backendItemBaseShape,
    semanticKind: z.literal("review_marker"),
    verdict: z.enum(["comment", "approve", "request_changes"]),
    label: boundedDisplayTextSchema,
    body: boundedTextSchema.optional(),
    path: boundedDisplayTextSchema.optional(),
    range: fileRangeSchema.optional(),
  }),
  z.strictObject({
    ...backendItemBaseShape,
    semanticKind: z.literal("compaction"),
    summary: boundedTextSchema
      .refine((summary) => summary.text.trim().length > 0, {
        message: "A compaction summary must contain text.",
      })
      .optional(),
  }),
  z.strictObject({
    ...backendItemBaseShape,
    semanticKind: z.literal("notice"),
    tone: z.enum(["neutral", "info", "success", "warning", "error"]),
    text: boundedTextSchema,
  }),
] as const;

export const backendItemSchema = z
  .discriminatedUnion("semanticKind", schemas)
  .superRefine((item, context) => {
    if (
      item.semanticKind === "user_message" ||
      item.semanticKind === "assistant_message"
    ) {
      requireSerializedByteLimit(
        item,
        context,
        MAXIMUM_MESSAGE_ITEM_BYTES,
        "Message item exceeds the serialized byte limit.",
      );
    }
  });
export type BackendItem = z.infer<typeof backendItemSchema>;

export const backendRunStateSchema = z.enum([
  "idle",
  "starting",
  "running",
  "stopping",
  "failed",
  "disconnected",
  "reconciling",
]);
export type BackendRunState = z.infer<typeof backendRunStateSchema>;

export const backendEffectiveSettingsSchema = z.strictObject({
  model: z
    .strictObject({
      provider: z.string().min(1).max(120),
      id: z.string().min(1).max(240),
    })
    .optional(),
  thinkingLevel: z.string().min(1).max(120).optional(),
  toolAccess: z.enum(["read_only", "ask", "full"]).optional(),
});
export type BackendEffectiveSettings = z.infer<
  typeof backendEffectiveSettingsSchema
>;

export const backendBranchingCapabilitySchema = z.discriminatedUnion(
  "availability",
  [
    z.strictObject({
      availability: z.literal("unavailable"),
      reason: boundedDisplayTextSchema,
    }),
    z.strictObject({
      availability: z.literal("available"),
      boundaries: z
        .array(
          z.enum([
            "latest_completed",
            "selected_completed_turn",
            "latest_provider_snapshot",
          ]),
        )
        .min(1)
        .max(3)
        .refine(
          (boundaries) => new Set(boundaries).size === boundaries.length,
          "Branch boundary capabilities must be unique.",
        ),
      method: z.enum(["provider_native", "provider_history_import"]),
      sourceMustBeIdle: z.boolean(),
      settingsInheritance: z.enum(["native", "application_applied"]),
      fidelity: z.strictObject({
        instructions: z.boolean(),
        messages: z.boolean(),
        toolCalls: z.boolean(),
        toolResults: z.boolean(),
        compaction: z.boolean(),
        attachments: z.boolean(),
        settings: z.boolean(),
        limitations: z.array(boundedDisplayTextSchema).max(16),
      }),
      childIdentity: z.enum(["application_reserved", "provider_assigned"]),
      creationRecovery: z.enum([
        "idempotent",
        "exactly_reconcilable",
        "potentially_unknown",
      ]),
    }),
  ],
);
export type BackendBranchingCapability = z.infer<
  typeof backendBranchingCapabilitySchema
>;

export const backendCapabilityDocumentSchema = z.strictObject({
  revision: z.string().min(1).max(160),
  actions: z
    .array(
      z.enum([
        "rename",
        "compact",
        "set_model",
        "set_thinking_level",
        "set_tool_access",
      ]),
    )
    .max(16),
  deliveryModes: z.array(z.enum(["submit", "steer"])).max(2),
  steerTarget: z.enum(["turn", "conversation"]).nullable(),
  composerAttachments: z
    .strictObject({
      fileStaging: z.boolean(),
      nativeImage: z.boolean(),
    })
    .refine(
      (attachments) => !attachments.nativeImage || attachments.fileStaging,
      {
        message: "Native image input requires staged file support.",
        path: ["nativeImage"],
      },
    ),
  nonblockingQuestions: z.boolean(),
  providerOutputArtifacts: z.strictObject({
    nativeImage: z.boolean(),
  }),
  supportsHistory: z.boolean(),
  branching: backendBranchingCapabilitySchema,
  interactionKinds: z
    .array(interactionKindSchema)
    .max(interactionKindSchema.options.length)
    .refine(
      (kinds) => new Set(kinds).size === kinds.length,
      "Backend interaction kinds must be unique.",
    ),
  usageAccounting: z.enum(["supported", "unsupported"]),
  usageSections: z
    .array(z.enum(["context", "counters"]))
    .max(2),
  effectiveSettings: backendEffectiveSettingsSchema,
});
export type BackendCapabilityDocument = z.infer<
  typeof backendCapabilityDocumentSchema
>;

const driverInteractionBaseShape = {
  invocation: interactionInvocationSchema.optional(),
  backendInteractionId: z.string().min(1).max(512),
  sourceLabel: boundedDisplayTextSchema,
  title: boundedDisplayTextSchema,
  openedAt: z.iso.datetime(),
  secret: z.boolean(),
  destructive: z.boolean(),
  cancellable: z.boolean(),
} as const;

export const driverInteractionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...driverInteractionBaseShape,
      kind: z.literal("form"),
      fields: formFieldsSchema,
    }),
    z.strictObject({
      ...driverInteractionBaseShape,
      kind: z.literal("choice"),
      message: boundedTextSchema.optional(),
      options: z
        .array(
          z.strictObject({
            backendOptionId: z.string().min(1).max(512),
            label: boundedDisplayTextSchema,
            description: boundedDisplayTextSchema.optional(),
          }),
        )
        .min(1)
        .max(64)
        .superRefine((options, context) => {
          const ids = new Set<string>();
          for (const [index, option] of options.entries()) {
            if (ids.has(option.backendOptionId)) {
              context.addIssue({
                code: "custom",
                message: "Backend interaction option IDs must be unique.",
                path: [index, "backendOptionId"],
              });
            }
            ids.add(option.backendOptionId);
          }
        }),
      multiple: z.boolean(),
    }),
    z.strictObject({
      ...driverInteractionBaseShape,
      kind: z.literal("confirmation"),
      message: boundedTextSchema,
      confirmLabel: boundedDisplayTextSchema.optional(),
      cancelLabel: boundedDisplayTextSchema.optional(),
    }),
    z.strictObject({
      ...driverInteractionBaseShape,
      kind: z.literal("text_input"),
      placeholder: boundedDisplayTextSchema.optional(),
      initialValue: boundedTextSchema.optional(),
      multiline: z.boolean(),
    }),
    z.strictObject({
      ...driverInteractionBaseShape,
      kind: z.literal("editor"),
      initialValue: boundedTextSchema.optional(),
      language: z.string().min(1).max(120).optional(),
    }),
    z
      .strictObject({
        ...driverInteractionBaseShape,
        kind: z.literal("decision"),
        message: boundedTextSchema.optional(),
        code: boundedTextSchema.optional(),
        actions: z
          .array(
            z.strictObject({
              backendActionId: z.string().min(1).max(512),
              label: boundedDisplayTextSchema,
              description: boundedDisplayTextSchema.optional(),
              role: decisionActionRoleSchema,
            }),
          )
          .min(1)
          .max(INTERACTION_LIMITS.decisionActions),
      })
      .superRefine((interaction, context) => {
        const ids = new Set<string>();
        let primaryCount = 0;
        for (const [index, action] of interaction.actions.entries()) {
          if (ids.has(action.backendActionId)) {
            context.addIssue({
              code: "custom",
              message: "Backend decision action IDs must be unique.",
              path: ["actions", index, "backendActionId"],
            });
          }
          ids.add(action.backendActionId);
          if (action.role === "primary") primaryCount += 1;
        }
        if (primaryCount > 1) {
          context.addIssue({
            code: "custom",
            message: "A decision may have at most one primary action.",
            path: ["actions"],
          });
        }
      }),
    z
      .strictObject({
        ...driverInteractionBaseShape,
        kind: z.literal("questionnaire"),
        message: boundedTextSchema.optional(),
        questions: z
          .array(
            z.strictObject({
              backendQuestionId: z.string().min(1).max(512),
              ...questionnaireQuestionPresentationShape,
              input: z.discriminatedUnion("kind", [
                z.strictObject({
                  ...questionnaireSingleChoicePresentationShape,
                  options: z
                    .array(
                      z.strictObject({
                        backendOptionId: z.string().min(1).max(512),
                        label: boundedDisplayTextSchema,
                        description: boundedDisplayTextSchema,
                      }),
                    )
                    .min(1)
                    .max(INTERACTION_LIMITS.questionnaireOptionsPerQuestion),
                  other: z
                    .strictObject({
                      backendOptionId: z.string().min(1).max(512),
                      label: boundedDisplayTextSchema,
                      description: boundedDisplayTextSchema.optional(),
                    })
                    .optional(),
                }),
                questionnaireTextInputSchema,
              ]),
            }),
          )
          .min(1)
          .max(INTERACTION_LIMITS.questionnaireQuestions),
      })
      .superRefine((interaction, context) => {
        const questionIds = new Set<string>();
        const optionIds = new Set<string>();
        for (const [
          questionIndex,
          question,
        ] of interaction.questions.entries()) {
          if (questionIds.has(question.backendQuestionId)) {
            context.addIssue({
              code: "custom",
              message: "Backend questionnaire question IDs must be unique.",
              path: ["questions", questionIndex, "backendQuestionId"],
            });
          }
          questionIds.add(question.backendQuestionId);
          if (question.input.kind !== "single_choice") continue;
          const options = [
            ...question.input.options,
            ...(question.input.other ? [question.input.other] : []),
          ];
          for (const option of options) {
            if (optionIds.has(option.backendOptionId)) {
              context.addIssue({
                code: "custom",
                message: "Backend questionnaire option IDs must be unique.",
                path: ["questions", questionIndex, "input"],
              });
            }
            optionIds.add(option.backendOptionId);
          }
        }
        if (
          interaction.secret !==
          interaction.questions.some((question) => question.secret)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Questionnaire secret state must match its secret questions.",
            path: ["secret"],
          });
        }
      }),
  ])
  .superRefine(requireBoundedInteraction);
export type DriverInteraction = z.infer<typeof driverInteractionSchema>;

export const interactionResponseInputSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      applicationOperationId: z.string().min(1).max(160),
      interactionId: z.string().min(1).max(512),
      kind: z.literal("form"),
      answers: formAnswersSchema,
    }),
    z.strictObject({
      applicationOperationId: z.string().min(1).max(160),
      interactionId: z.string().min(1).max(512),
      kind: z.literal("cancel"),
    }),
    z.strictObject({
      applicationOperationId: z.string().min(1).max(160),
      interactionId: z.string().min(1).max(512),
      kind: z.literal("choice"),
      selectedOptionIds: z.array(z.string().min(1).max(512)).max(64),
    }),
    z.strictObject({
      applicationOperationId: z.string().min(1).max(160),
      interactionId: z.string().min(1).max(512),
      kind: z.literal("confirmation"),
      confirmed: z.boolean(),
    }),
    z.strictObject({
      applicationOperationId: z.string().min(1).max(160),
      interactionId: z.string().min(1).max(512),
      kind: z.literal("text_input"),
      value: z.string().max(65_536),
    }),
    z.strictObject({
      applicationOperationId: z.string().min(1).max(160),
      interactionId: z.string().min(1).max(512),
      kind: z.literal("editor"),
      value: z.string().max(262_144),
    }),
    z.strictObject({
      applicationOperationId: z.string().min(1).max(160),
      interactionId: z.string().min(1).max(512),
      kind: z.literal("decision"),
      selectedActionId: z.string().min(1).max(512),
    }),
    z.strictObject({
      applicationOperationId: z.string().min(1).max(160),
      interactionId: z.string().min(1).max(512),
      kind: z.literal("questionnaire"),
      answers: z
        .array(backendQuestionnaireAnswerSchema)
        .min(1)
        .max(INTERACTION_LIMITS.questionnaireQuestions),
    }),
  ])
  .superRefine((response, context) => {
    if (response.kind === "choice") {
      if (
        new Set(response.selectedOptionIds).size !==
        response.selectedOptionIds.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Backend choice response option IDs must be unique.",
          path: ["selectedOptionIds"],
        });
      }
    } else if (response.kind === "questionnaire") {
      const questionIds = new Set<string>();
      for (const [index, answer] of response.answers.entries()) {
        if (questionIds.has(answer.questionId)) {
          context.addIssue({
            code: "custom",
            message: "Backend questionnaire answer IDs must be unique.",
            path: ["answers", index, "questionId"],
          });
        }
        questionIds.add(answer.questionId);
      }
    }
  });
export type InteractionResponseInput = z.infer<
  typeof interactionResponseInputSchema
>;

function requireBoundedInteraction(
  interaction: unknown,
  context: z.RefinementCtx,
): void {
  if (
    new TextEncoder().encode(JSON.stringify(interaction)).byteLength >
    MAXIMUM_BROWSER_ENTITY_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: "Interaction payload exceeds the serialized byte limit.",
    });
  }
}

export const backendConversationEventSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("background_activity_changed"),
      activity: backgroundActivitySchema,
    }),
    z.strictObject({
      type: z.literal("run_state_changed"),
      state: backendRunStateSchema,
      activeBackendTurnId: z.string().min(1).max(512).optional(),
    }),
    z.strictObject({
      type: z.literal("turn_started"),
      turn: backendTurnSchema,
    }),
    z.strictObject({
      type: z.literal("turn_updated"),
      turn: backendTurnSchema,
    }),
    z.strictObject({
      type: z.literal("turn_completed"),
      turn: backendTurnSchema,
    }),
    z.strictObject({
      type: z.literal("item_started"),
      item: backendItemSchema,
    }),
    z.strictObject({
      type: z.literal("item_updated"),
      item: backendItemSchema,
    }),
    z.strictObject({
      type: z.literal("item_completed"),
      item: backendItemSchema,
    }),
    z.strictObject({
      type: z.literal("interaction_opened"),
      interaction: driverInteractionSchema,
    }),
    z.strictObject({
      type: z.literal("interaction_resolved"),
      backendInteractionId: z.string().min(1).max(512),
    }),
    z.strictObject({
      type: z.literal("capabilities_changed"),
      capabilities: backendCapabilityDocumentSchema,
    }),
    z.strictObject({
      type: z.literal("usage_changed"),
      usage: usageSnapshotSchema,
    }),
    z.strictObject({
      type: z.literal("notice"),
      notice: runtimeNoticeSchema,
    }),
    z.strictObject({
      type: z.literal("resnapshot_required"),
      reason: z.enum([
        "sequence_gap",
        "buffer_overflow",
        "persistence_pending",
        "history_changed",
        "ambiguous_correlation",
        "contradictory_state",
        "provider_handle_closed",
      ]),
    }),
  ])
  .superRefine((event, context) => {
    if (event.type === "item_started" && event.item.status !== "streaming") {
      context.addIssue({
        code: "custom",
        message: "A started backend item must be streaming.",
        path: ["item", "status"],
      });
    }
    if (event.type === "item_completed" && event.item.status === "streaming") {
      context.addIssue({
        code: "custom",
        message: "A completed backend item must be terminal.",
        path: ["item", "status"],
      });
    }
  });
export type BackendConversationEvent = z.infer<
  typeof backendConversationEventSchema
>;

const backendTimelineShape = {
  orderedBackendTurnIds: z.array(z.string().min(1).max(512)).max(1_000),
  turnsById: z.record(z.string(), backendTurnSchema),
  itemsById: z.record(z.string(), backendItemSchema),
} as const;

function requireValidBackendTimeline(
  value: {
    readonly orderedBackendTurnIds: readonly string[];
    readonly turnsById: Record<string, BackendTurn>;
    readonly itemsById: Record<string, BackendItem>;
    readonly activeBackendTurnId?: string;
  },
  context: z.RefinementCtx,
): void {
  requireUniqueIdentifiers(
    value.orderedBackendTurnIds,
    context,
    ["orderedBackendTurnIds"],
    "Backend timeline turn identifiers must be unique.",
  );
  const orderedTurnIds = new Set(value.orderedBackendTurnIds);
  const referencedItemIds = new Set<string>();
  for (const [recordKey, turn] of Object.entries(value.turnsById)) {
    if (turn.backendTurnId !== recordKey) {
      context.addIssue({
        code: "custom",
        message: "Backend turn record key does not match its identifier.",
        path: ["turnsById", recordKey, "backendTurnId"],
      });
    }
    if (!orderedTurnIds.has(recordKey)) {
      context.addIssue({
        code: "custom",
        message: "Backend timeline contains an unordered turn record.",
        path: ["turnsById", recordKey],
      });
    }
    for (const backendItemId of turn.orderedBackendItemIds) {
      const item = value.itemsById[backendItemId];
      if (!item) {
        context.addIssue({
          code: "custom",
          message: "Backend turn references a missing item.",
          path: ["turnsById", recordKey, "orderedBackendItemIds"],
        });
        continue;
      }
      if (item.backendTurnId !== recordKey) {
        context.addIssue({
          code: "custom",
          message: "Backend item belongs to another turn.",
          path: ["itemsById", backendItemId, "backendTurnId"],
        });
      }
      if (referencedItemIds.has(backendItemId)) {
        context.addIssue({
          code: "custom",
          message: "Backend item is referenced by more than one turn.",
          path: ["itemsById", backendItemId],
        });
      }
      referencedItemIds.add(backendItemId);
    }
  }
  for (const backendTurnId of value.orderedBackendTurnIds) {
    if (!value.turnsById[backendTurnId]) {
      context.addIssue({
        code: "custom",
        message: "Backend timeline references a missing turn.",
        path: ["orderedBackendTurnIds"],
      });
    }
  }
  for (const [recordKey, item] of Object.entries(value.itemsById)) {
    if (item.backendItemId !== recordKey) {
      context.addIssue({
        code: "custom",
        message: "Backend item record key does not match its identifier.",
        path: ["itemsById", recordKey, "backendItemId"],
      });
    }
    if (!referencedItemIds.has(recordKey)) {
      context.addIssue({
        code: "custom",
        message: "Backend timeline contains an unreferenced item record.",
        path: ["itemsById", recordKey],
      });
    }
  }
  if (
    value.activeBackendTurnId &&
    !value.turnsById[value.activeBackendTurnId]
  ) {
    context.addIssue({
      code: "custom",
      message: "Backend active turn is missing from the timeline.",
      path: ["activeBackendTurnId"],
    });
  }
  requireSerializedByteLimit(
    value,
    context,
    MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
    "Backend snapshot or history page exceeds the serialized byte limit.",
  );
}

function requireUniqueIdentifiers(
  values: readonly string[],
  context: z.RefinementCtx,
  path: Array<string | number>,
  message: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message,
        path: [...path, index],
      });
    }
    seen.add(value);
  }
}

export const backendConversationSnapshotSchema = z
  .strictObject({
    ...backendTimelineShape,
    runState: backendRunStateSchema,
    backgroundActivity: backgroundActivitySchema.optional(),
    activeBackendTurnId: z.string().min(1).max(512).optional(),
  })
  .superRefine(requireValidBackendTimeline);
export type BackendConversationSnapshot = z.infer<
  typeof backendConversationSnapshotSchema
>;

export const backendHistoryPageSchema = z
  .strictObject({
    ...backendTimelineShape,
    previousCursor: z.string().min(1).max(512).optional(),
  })
  .superRefine(requireValidBackendTimeline);
export type BackendHistoryPagePayload = z.infer<
  typeof backendHistoryPageSchema
>;

export const sequencedBackendEventSchema = z.strictObject({
  handleSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  event: backendConversationEventSchema,
});
export type SequencedBackendEvent = z.infer<typeof sequencedBackendEventSchema>;
