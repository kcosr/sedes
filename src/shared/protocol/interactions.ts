import { z } from "zod";
import {
  boundedDisplayTextSchema,
  boundedValueSchema,
  PAYLOAD_LIMITS,
} from "./payload.js";

/** Read-only invocation details supplied by the exact pending request. */
export const interactionInvocationSchema = z.strictObject({
  arguments: boundedValueSchema,
});

export const INTERACTION_LIMITS = {
  decisionActions: 16,
  questionnaireQuestions: 3,
  questionnaireOptionsPerQuestion: 8,
} as const;

export const interactionKindSchema = z.enum([
  "choice",
  "confirmation",
  "text_input",
  "editor",
  "decision",
  "questionnaire",
  "form",
]);
export type InteractionKind = z.infer<typeof interactionKindSchema>;

export const decisionActionRoleSchema = z.enum([
  "primary",
  "alternative",
  "reject",
]);
export type DecisionActionRole = z.infer<typeof decisionActionRoleSchema>;

export const questionnaireAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unanswered") }),
  z.strictObject({
    kind: z.literal("single_choice"),
    selectedOptionId: z.string().min(1).max(160),
    note: z.string().max(PAYLOAD_LIMITS.textCharacters).optional(),
  }),
  z.strictObject({
    kind: z.literal("text"),
    value: z.string().max(PAYLOAD_LIMITS.textCharacters),
  }),
]);
export type QuestionnaireAnswer = z.infer<typeof questionnaireAnswerSchema>;

export const browserQuestionnaireAnswerSchema = z.strictObject({
  questionId: z.string().min(1).max(160),
  answer: questionnaireAnswerSchema,
});
export type BrowserQuestionnaireAnswer = z.infer<
  typeof browserQuestionnaireAnswerSchema
>;

export const backendQuestionnaireAnswerSchema = z.strictObject({
  questionId: z.string().min(1).max(512),
  answer: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("unanswered") }),
    z.strictObject({
      kind: z.literal("single_choice"),
      selectedOptionId: z.string().min(1).max(512),
      note: z.string().max(PAYLOAD_LIMITS.textCharacters).optional(),
    }),
    z.strictObject({
      kind: z.literal("text"),
      value: z.string().max(PAYLOAD_LIMITS.textCharacters),
    }),
  ]),
});
export type BackendQuestionnaireAnswer = z.infer<
  typeof backendQuestionnaireAnswerSchema
>;

export const questionnaireQuestionPresentationShape = {
  header: boundedDisplayTextSchema,
  prompt: boundedDisplayTextSchema,
  secret: z.boolean(),
} as const;

export const questionnaireSingleChoicePresentationShape = {
  kind: z.literal("single_choice"),
  allowNote: z.boolean(),
} as const;

export const questionnaireTextInputSchema = z.strictObject({
  kind: z.literal("text"),
  multiline: z.boolean(),
  placeholder: boundedDisplayTextSchema.optional(),
});

export function requireUniqueQuestionnaireIdentities(
  questions: readonly {
    readonly id: string;
    readonly input: {
      readonly kind: string;
      readonly options?: readonly { readonly id: string }[];
      readonly other?: { readonly id: string };
    };
  }[],
  context: z.RefinementCtx,
): void {
  const questionIds = new Set<string>();
  const optionIds = new Set<string>();
  for (const [questionIndex, question] of questions.entries()) {
    if (questionIds.has(question.id)) {
      context.addIssue({
        code: "custom",
        message: "Questionnaire question IDs must be unique.",
        path: [questionIndex, "id"],
      });
    }
    questionIds.add(question.id);
    if (question.input.kind !== "single_choice") continue;
    const choices = [
      ...(question.input.options ?? []),
      ...(question.input.other ? [question.input.other] : []),
    ];
    for (const choice of choices) {
      if (optionIds.has(choice.id)) {
        context.addIssue({
          code: "custom",
          message: "Questionnaire option IDs must be unique.",
          path: [questionIndex, "input"],
        });
      }
      optionIds.add(choice.id);
    }
  }
}

const formOptionSchema = z.strictObject({
  id: z.string().min(1).max(160),
  label: boundedDisplayTextSchema,
});
export const formFieldSchema = z.strictObject({
  id: z.string().min(1).max(160),
  label: boundedDisplayTextSchema,
  description: boundedDisplayTextSchema.optional(),
  required: z.boolean(),
  input: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("text"),
      default: z.string().max(PAYLOAD_LIMITS.textCharacters).optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    }),
    z.strictObject({
      kind: z.literal("number"),
      integer: z.boolean(),
      default: z.number().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    }),
    z.strictObject({
      kind: z.literal("boolean"),
      default: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal("single_choice"),
      options: z.array(formOptionSchema).min(1).max(64),
      default: z.string().min(1).max(160).optional(),
    }),
    z.strictObject({
      kind: z.literal("multiple_choice"),
      options: z.array(formOptionSchema).min(1).max(64),
      default: z.array(z.string().min(1).max(160)).max(64).optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
    }),
  ]),
});
export type FormField = z.infer<typeof formFieldSchema>;
export const formAnswerSchema = z.strictObject({
  fieldId: z.string().min(1).max(160),
  value: z.union([
    z.string().max(PAYLOAD_LIMITS.textCharacters),
    z.number(),
    z.boolean(),
    z.array(z.string().min(1).max(160)).max(64),
  ]),
});
export type FormAnswer = z.infer<typeof formAnswerSchema>;
export const formAnswersSchema = z
  .array(formAnswerSchema)
  .max(32)
  .superRefine((answers, context) => {
    if (
      new Set(answers.map((answer) => answer.fieldId)).size !== answers.length
    )
      context.addIssue({
        code: "custom",
        message: "Form answer identities must be unique.",
      });
  });
export const formFieldsSchema = z
  .array(formFieldSchema)
  .min(1)
  .max(32)
  .superRefine((fields, context) => {
    if (new Set(fields.map((field) => field.id)).size !== fields.length)
      context.addIssue({
        code: "custom",
        message: "Form field identities must be unique.",
      });
    for (const field of fields) {
      const input = field.input;
      if (
        (input.kind === "single_choice" || input.kind === "multiple_choice") &&
        new Set(input.options.map((option) => option.id)).size !==
          input.options.length
      )
        context.addIssue({
          code: "custom",
          message: "Form option identities must be unique.",
        });
      if (
        (input.kind === "text" &&
          input.minLength !== undefined &&
          input.maxLength !== undefined &&
          input.minLength > input.maxLength) ||
        (input.kind === "number" &&
          input.minimum !== undefined &&
          input.maximum !== undefined &&
          input.minimum > input.maximum) ||
        (input.kind === "multiple_choice" &&
          input.minItems !== undefined &&
          input.maxItems !== undefined &&
          input.minItems > input.maxItems)
      )
        context.addIssue({
          code: "custom",
          message: "Form bounds are inconsistent.",
        });
      if (
        (input.kind === "text" &&
          (input.minLength ?? 0) > PAYLOAD_LIMITS.textCharacters) ||
        (input.kind === "multiple_choice" &&
          (input.minItems ?? 0) > input.options.length) ||
        (input.kind === "number" &&
          input.integer &&
          Math.ceil(input.minimum ?? -Infinity) >
            Math.floor(input.maximum ?? Infinity))
      )
        context.addIssue({
          code: "custom",
          message: "Form field has no representable answer.",
        });
      if (
        input.default !== undefined &&
        validateFormAnswers(
          [{ ...field, required: false }],
          [{ fieldId: field.id, value: input.default }],
        )
      )
        context.addIssue({
          code: "custom",
          message: "Form default does not match its field.",
        });
    }
  });
/** Shared presentation validation; authority is enforced again before dispatch. */
export function validateFormAnswers(
  fields: readonly FormField[],
  answers: readonly FormAnswer[],
): string | null {
  const seen = new Set<string>();
  for (const answer of answers) {
    const field = fields.find((candidate) => candidate.id === answer.fieldId);
    if (!field || seen.has(answer.fieldId))
      return "The form contains an unknown or repeated field.";
    seen.add(answer.fieldId);
    const input = field.input;
    const value = answer.value;
    let valid = false;
    switch (input.kind) {
      case "text": {
        valid =
          typeof value === "string" &&
          value.length <= PAYLOAD_LIMITS.textCharacters &&
          Array.from(value).length >= (input.minLength ?? 0) &&
          Array.from(value).length <=
            (input.maxLength ?? PAYLOAD_LIMITS.textCharacters);
        if (valid && typeof value === "string" && input.format) {
          if (input.format === "email")
            valid = z.email().safeParse(value).success;
          else if (input.format === "uri")
            valid = z.url().safeParse(value).success;
          else if (input.format === "date")
            valid = z.iso.date().safeParse(value).success;
          else
            valid = z.iso.datetime({ offset: true }).safeParse(value).success;
        }
        break;
      }
      case "number":
        valid =
          typeof value === "number" &&
          Number.isFinite(value) &&
          (!input.integer || Number.isInteger(value)) &&
          value >= (input.minimum ?? -Infinity) &&
          value <= (input.maximum ?? Infinity);
        break;
      case "boolean":
        valid = typeof value === "boolean";
        break;
      case "single_choice":
        valid =
          typeof value === "string" &&
          input.options.some((option) => option.id === value);
        break;
      case "multiple_choice":
        valid =
          Array.isArray(value) &&
          new Set(value).size === value.length &&
          value.length >= (input.minItems ?? 0) &&
          value.length <= (input.maxItems ?? 64) &&
          value.every((id) => input.options.some((option) => option.id === id));
        break;
    }
    if (!valid) return `Enter a valid value for ${field.label.text}.`;
  }
  for (const field of fields)
    if (field.required && !seen.has(field.id))
      return `${field.label.text} is required.`;
  return null;
}
