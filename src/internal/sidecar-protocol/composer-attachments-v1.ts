import { normalizedAbsolutePath } from "../../shared/absolute-path.js";
import { z } from "zod";
import { MAXIMUM_COMPOSER_ATTACHMENT_STAGING_CHUNK_BYTES } from "../../shared/composer-attachment-staging-limits.js";
import { MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES } from "../../shared/protocol/composer-attachments.js";
import {
  SidecarOperationRegistry,
  defineSidecarOperation,
  type SidecarOperationContext,
} from "./operation-registry.js";

export const COMPOSER_ATTACHMENTS_CAPABILITY_ID =
  "composer_attachments" as const;
export const COMPOSER_ATTACHMENTS_MAJOR_VERSION = 1 as const;
export const COMPOSER_ATTACHMENT_CHUNK_BASE64_CHARACTERS =
  Math.ceil(MAXIMUM_COMPOSER_ATTACHMENT_STAGING_CHUNK_BYTES / 3) * 4;

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const extensionSchema = z.string().regex(/^(?:|\.[a-z0-9]{1,12})$/u);
const agentPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      normalizedAbsolutePath(value) &&
      value !== "/" &&
      !/^[a-z]:\\$/iu.test(value),
    "composer_attachment_agent_path_invalid",
  );
const canonicalBase64Schema = z
  .string()
  .min(4)
  .max(COMPOSER_ATTACHMENT_CHUNK_BASE64_CHARACTERS)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

const definition = <Request, Response>(input: {
  readonly operation: string;
  readonly requestSchema: z.ZodType<Request>;
  readonly responseSchema: z.ZodType<Response>;
}) =>
  defineSidecarOperation({
    capabilityId: COMPOSER_ATTACHMENTS_CAPABILITY_ID,
    majorVersion: COMPOSER_ATTACHMENTS_MAJOR_VERSION,
    operation: input.operation,
    lane: "operation" as const,
    maximumDeadlineMilliseconds: 60_000,
    requestSchema: input.requestSchema,
    responseSchema: input.responseSchema,
  });

const materializedSchema = z.strictObject({
  state: z.literal("ready"),
  agentPath: agentPathSchema,
  sha256: sha256Schema,
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES),
});

export const composerAttachmentsMaterializationOpenOperation = definition({
  operation: "materialization.open",
  requestSchema: z.strictObject({
    admissionId: uuidSchema,
    scopeKey: sha256Schema,
    threadId: uuidSchema,
    attachmentId: uuidSchema,
    sha256: sha256Schema,
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES),
    extension: extensionSchema,
  }),
  responseSchema: z.discriminatedUnion("state", [
    materializedSchema,
    z.strictObject({
      state: z.literal("upload"),
      uploadHandle: uuidSchema,
      nextOffset: z
        .number()
        .int()
        .nonnegative()
        .max(MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES),
    }),
  ]),
});

export const composerAttachmentsMaterializationAppendOperation = definition({
  operation: "materialization.append",
  requestSchema: z.strictObject({
    uploadHandle: uuidSchema,
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES),
    decodedBytes: z
      .number()
      .int()
      .min(1)
      .max(MAXIMUM_COMPOSER_ATTACHMENT_STAGING_CHUNK_BYTES),
    chunkSha256: sha256Schema,
    contentBase64: canonicalBase64Schema,
  }),
  responseSchema: z.strictObject({
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .max(MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES),
  }),
});

export const composerAttachmentsMaterializationCommitOperation = definition({
  operation: "materialization.commit",
  requestSchema: z.strictObject({ uploadHandle: uuidSchema }),
  responseSchema: materializedSchema.omit({ state: true }),
});

export const composerAttachmentsMaterializationAbortOperation = definition({
  operation: "materialization.abort",
  requestSchema: z.strictObject({ uploadHandle: uuidSchema }),
  responseSchema: z.strictObject({ aborted: z.literal(true) }),
});

export const composerAttachmentsMaterializationReleaseOperation = definition({
  operation: "materialization.release",
  requestSchema: z.strictObject({
    scopeKey: sha256Schema,
    threadId: uuidSchema,
    attachmentId: uuidSchema,
    expectedSha256: sha256Schema,
  }),
  responseSchema: z.strictObject({ released: z.literal(true) }),
});

export const composerAttachmentsV1Operations = Object.freeze([
  composerAttachmentsMaterializationOpenOperation,
  composerAttachmentsMaterializationAppendOperation,
  composerAttachmentsMaterializationCommitOperation,
  composerAttachmentsMaterializationAbortOperation,
  composerAttachmentsMaterializationReleaseOperation,
]);

type HandlerFor<Definition> = Definition extends {
  requestSchema: z.ZodType<infer Request>;
  responseSchema: z.ZodType<infer Response>;
}
  ? (
      request: Request,
      context: SidecarOperationContext,
    ) => Promise<Response> | Response
  : never;

export interface ComposerAttachmentsV1Handlers {
  readonly open: HandlerFor<
    typeof composerAttachmentsMaterializationOpenOperation
  >;
  readonly append: HandlerFor<
    typeof composerAttachmentsMaterializationAppendOperation
  >;
  readonly commit: HandlerFor<
    typeof composerAttachmentsMaterializationCommitOperation
  >;
  readonly abort: HandlerFor<
    typeof composerAttachmentsMaterializationAbortOperation
  >;
  readonly release: HandlerFor<
    typeof composerAttachmentsMaterializationReleaseOperation
  >;
}

export function registerComposerAttachmentsV1Operations(
  registry: SidecarOperationRegistry,
  handlers: ComposerAttachmentsV1Handlers,
): void {
  registry.register(
    composerAttachmentsMaterializationOpenOperation,
    handlers.open,
  );
  registry.register(
    composerAttachmentsMaterializationAppendOperation,
    handlers.append,
  );
  registry.register(
    composerAttachmentsMaterializationCommitOperation,
    handlers.commit,
  );
  registry.register(
    composerAttachmentsMaterializationAbortOperation,
    handlers.abort,
  );
  registry.register(
    composerAttachmentsMaterializationReleaseOperation,
    handlers.release,
  );
}
