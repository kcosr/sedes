import { z } from "zod";
import { mutationIdSchema } from "./domain.js";

export const CANNED_PROMPT_MAX_ITEMS = 32;
export const CANNED_PROMPT_TITLE_MAX_CHARACTERS = 120;
export const CANNED_PROMPT_TITLE_MAX_BYTES = 480;
export const CANNED_PROMPT_TEXT_MAX_BYTES = 8192;

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

export const cannedPromptIdSchema = z.uuid();

export const cannedPromptTitleSchema = z
  .string()
  .transform((value) => value.normalize("NFKC").trim())
  .pipe(
    z
      .string()
      .min(1, "A canned prompt title is required.")
      .refine(
        (value) => [...value].length <= CANNED_PROMPT_TITLE_MAX_CHARACTERS,
        `A canned prompt title must be at most ${CANNED_PROMPT_TITLE_MAX_CHARACTERS} characters.`,
      )
      .refine(
        (value) => utf8ByteLength(value) <= CANNED_PROMPT_TITLE_MAX_BYTES,
        `A canned prompt title must be at most ${CANNED_PROMPT_TITLE_MAX_BYTES} UTF-8 bytes.`,
      ),
  );

export const cannedPromptTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Canned prompt text is required.")
  .refine(
    (value) => utf8ByteLength(value) <= CANNED_PROMPT_TEXT_MAX_BYTES,
    `Canned prompt text must be at most ${CANNED_PROMPT_TEXT_MAX_BYTES} UTF-8 bytes.`,
  );

export const cannedPromptSchema = z.strictObject({
  id: cannedPromptIdSchema,
  title: cannedPromptTitleSchema,
  text: cannedPromptTextSchema,
  position: z
    .number()
    .int()
    .nonnegative()
    .max(CANNED_PROMPT_MAX_ITEMS - 1),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type CannedPrompt = z.infer<typeof cannedPromptSchema>;

export const cannedPromptLibrarySchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  items: z
    .array(cannedPromptSchema)
    .max(CANNED_PROMPT_MAX_ITEMS)
    .refine(
      (items) => items.every((item, index) => item.position === index),
      "Canned prompts must have contiguous positions in presentation order.",
    )
    .refine(
      (items) => new Set(items.map((item) => item.id)).size === items.length,
      "Canned prompt ids must be unique within the library.",
    ),
});
export type CannedPromptLibrary = z.infer<typeof cannedPromptLibrarySchema>;

const mutationFields = {
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mutationId: mutationIdSchema,
} as const;

export const createCannedPromptRequestSchema = z.strictObject({
  title: cannedPromptTitleSchema,
  text: cannedPromptTextSchema,
  ...mutationFields,
});
export type CreateCannedPromptRequest = z.infer<
  typeof createCannedPromptRequestSchema
>;

export const updateCannedPromptRequestSchema = z.strictObject({
  title: cannedPromptTitleSchema,
  text: cannedPromptTextSchema,
  ...mutationFields,
});
export type UpdateCannedPromptRequest = z.infer<
  typeof updateCannedPromptRequestSchema
>;

export const deleteCannedPromptRequestSchema = z.strictObject({
  ...mutationFields,
});
export type DeleteCannedPromptRequest = z.infer<
  typeof deleteCannedPromptRequestSchema
>;

export const reorderCannedPromptsRequestSchema = z.strictObject({
  promptIds: z.array(cannedPromptIdSchema).min(1).max(CANNED_PROMPT_MAX_ITEMS),
  ...mutationFields,
});
export type ReorderCannedPromptsRequest = z.infer<
  typeof reorderCannedPromptsRequestSchema
>;

export const cannedPromptRouteParametersSchema = z.strictObject({
  promptId: cannedPromptIdSchema,
});

export const cannedPromptMutationResultSchema =
  cannedPromptLibrarySchema.extend({
    replayed: z.boolean(),
  });
export type CannedPromptMutationResult = z.infer<
  typeof cannedPromptMutationResultSchema
>;
