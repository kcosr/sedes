import { z } from "zod";
import { serializedUtf8Bytes } from "./payload.js";

export const NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS = 8;
export const NONBLOCKING_QUESTIONS_MAXIMUM_OPTIONS = 8;
export const NONBLOCKING_QUESTIONS_MAXIMUM_TITLE_BYTES = 4 * 1_024;
export const NONBLOCKING_QUESTIONS_MAXIMUM_OPTION_BYTES = 2 * 1_024;
export const NONBLOCKING_QUESTIONS_MAXIMUM_PAYLOAD_BYTES = 48 * 1_024;

const utf8Encoder = new TextEncoder();

function boundedNonemptyString(maximumBytes: number, label: string) {
  return z.string().superRefine((value, context) => {
    if (value.trim().length === 0) {
      context.addIssue({
        code: "custom",
        message: `${label} must not be empty.`,
      });
    }
    if (utf8Encoder.encode(value).byteLength > maximumBytes) {
      context.addIssue({
        code: "custom",
        message: `${label} exceeds its UTF-8 byte limit.`,
      });
    }
  });
}

export const nonblockingQuestionSchema = z.strictObject({
  title: boundedNonemptyString(
    NONBLOCKING_QUESTIONS_MAXIMUM_TITLE_BYTES,
    "Question title",
  ),
  options: z
    .array(
      boundedNonemptyString(
        NONBLOCKING_QUESTIONS_MAXIMUM_OPTION_BYTES,
        "Question option",
      ),
    )
    .min(1)
    .max(NONBLOCKING_QUESTIONS_MAXIMUM_OPTIONS)
    .nullable(),
});
export type NonblockingQuestion = z.infer<typeof nonblockingQuestionSchema>;

export const nonblockingQuestionsPayloadSchema = z
  .strictObject({
    questions: z
      .array(nonblockingQuestionSchema)
      .min(1)
      .max(NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS),
  })
  .superRefine((value, context) => {
    if (
      serializedUtf8Bytes(value) > NONBLOCKING_QUESTIONS_MAXIMUM_PAYLOAD_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "Async questions exceed the question payload limit.",
      });
    }
  });
export type NonblockingQuestionsPayload = z.infer<
  typeof nonblockingQuestionsPayloadSchema
>;

export const MAXIMUM_PENDING_QUESTION_REQUESTS = 100;
export const questionRequestSchema = z.strictObject({
  id: z.string().min(1).max(160),
  threadId: z.string().min(1).max(160),
  sourceItemId: z.string().min(1).max(160),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
  questions: z
    .array(
      nonblockingQuestionSchema.extend({
        index: z
          .number()
          .int()
          .min(0)
          .max(NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS - 1),
      }),
    )
    .min(1)
    .max(NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS)
    .refine(
      (questions) =>
        new Set(questions.map(({ index }) => index)).size === questions.length,
      "Pending question indices must be unique.",
    )
    .refine(
      (questions) =>
        serializedUtf8Bytes({ questions }) <=
        NONBLOCKING_QUESTIONS_MAXIMUM_PAYLOAD_BYTES +
          NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS * 10,
      "Pending questions exceed their payload limit.",
    ),
});
export type QuestionRequest = z.infer<typeof questionRequestSchema>;
export const questionRequestsResultSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requests: z
    .array(questionRequestSchema)
    .max(MAXIMUM_PENDING_QUESTION_REQUESTS),
});
export type QuestionRequestsResult = z.infer<
  typeof questionRequestsResultSchema
>;
export const dismissQuestionRequestSchema = z.strictObject({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type DismissQuestionRequest = z.infer<
  typeof dismissQuestionRequestSchema
>;
export const questionAnswerSchema = z.strictObject({
  questionIndex: z
    .number()
    .int()
    .min(0)
    .max(NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS - 1),
  answer: boundedNonemptyString(16 * 1024, "Question response"),
});
export const questionResponseOriginSchema = z.strictObject({
  kind: z.literal("question_response"),
  requestId: z.string().min(1).max(160),
  sourceItemId: z.string().min(1).max(160),
  answers: z
    .array(
      questionAnswerSchema.extend({
        question: nonblockingQuestionSchema.shape.title,
      }),
    )
    .min(1)
    .max(NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS)
    .refine(
      (answers) =>
        new Set(answers.map(({ questionIndex }) => questionIndex)).size ===
        answers.length,
      "Question indices must be unique.",
    ),
});
export const respondToQuestionRequestSchema = z.strictObject({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  answers: z
    .array(questionAnswerSchema)
    .min(1)
    .max(NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS)
    .refine(
      (answers) =>
        new Set(answers.map(({ questionIndex }) => questionIndex)).size ===
        answers.length,
      "Question indices must be unique.",
    ),
});
export type RespondToQuestionRequest = z.infer<
  typeof respondToQuestionRequestSchema
>;

/** Bounded lookup for question entries currently loaded in the transcript. */
export const questionStatusesRequestSchema = z.strictObject({
  sourceItemIds: z.array(z.string().min(1).max(512)).min(1).max(100),
});
export const questionRequestStatusSchema = z.strictObject({
  sourceItemId: z.string().min(1).max(512),
  questions: z.array(z.strictObject({
    index: z.number().int().min(0)
      .max(NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS - 1),
    status: z.enum(["pending", "answered", "dismissed"]),
  })).max(NONBLOCKING_QUESTIONS_MAXIMUM_QUESTIONS)
    .refine((questions) => new Set(questions.map(({ index }) => index)).size === questions.length,
      "Question status indices must be unique."),
});
export type QuestionRequestStatus = z.infer<typeof questionRequestStatusSchema>;
export const questionStatusesResultSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  statuses: z.array(questionRequestStatusSchema).max(100),
});
export type QuestionStatusesResult = z.infer<typeof questionStatusesResultSchema>;
