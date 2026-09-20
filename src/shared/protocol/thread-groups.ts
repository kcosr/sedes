import { z } from "zod";
import { mutationIdSchema, threadIdSchema } from "./domain.js";

export const threadGroupIdSchema = z.uuid();
export const threadGroupNameSchema = z
  .string()
  .transform((value) => value.normalize("NFKC").trim())
  .pipe(z.string().min(1).max(120));

export const normalizedThreadGroupSchema = z.strictObject({
  id: threadGroupIdSchema,
  name: threadGroupNameSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  memberCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeMemberCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
});
export type NormalizedThreadGroup = z.infer<
  typeof normalizedThreadGroupSchema
>;

export const updateThreadGroupAssignmentRequestSchema = z.discriminatedUnion(
  "action",
  [
    z.strictObject({
      action: z.literal("create"),
      name: threadGroupNameSchema,
      expectedRevision: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      mutationId: mutationIdSchema,
    }),
    z.strictObject({
      action: z.literal("assign"),
      groupId: threadGroupIdSchema,
      expectedRevision: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      mutationId: mutationIdSchema,
    }),
    z.strictObject({
      action: z.literal("remove"),
      expectedRevision: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER),
      mutationId: mutationIdSchema,
    }),
  ],
);
export type UpdateThreadGroupAssignmentRequest = z.infer<
  typeof updateThreadGroupAssignmentRequestSchema
>;

export const updateThreadGroupRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("rename"),
    name: threadGroupNameSchema,
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    mutationId: mutationIdSchema,
  }),
  z.strictObject({
    action: z.literal("delete"),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    expectedMemberCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    mutationId: mutationIdSchema,
  }),
]);
export type UpdateThreadGroupRequest = z.infer<
  typeof updateThreadGroupRequestSchema
>;

export const threadGroupRouteParametersSchema = z.strictObject({
  groupId: threadGroupIdSchema,
});

export const threadGroupMutationResultSchema = z.strictObject({
  groupId: threadGroupIdSchema.nullable(),
  threadId: threadIdSchema.optional(),
});
export type ThreadGroupMutationResult = z.infer<
  typeof threadGroupMutationResultSchema
>;
