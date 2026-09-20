import { z } from "zod";
import { allowedImageMimeSchema, boundedDisplayTextSchema } from "./payload.js";

const MEBIBYTE = 1_024 * 1_024;

export const MAXIMUM_COMPOSER_ATTACHMENTS = 8;
export const MAXIMUM_COMPOSER_ATTACHMENT_IMAGES = 4;
export const MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES = 25 * MEBIBYTE;
export const MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_BYTES = 16 * MEBIBYTE;
export const MAXIMUM_COMPOSER_ATTACHMENT_AGGREGATE_BYTES = 64 * MEBIBYTE;
export const MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_PIXELS = 40_000_000;
export const MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_DIMENSION = 16_384;
export const MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_HEADER_BYTES = MEBIBYTE;
export const COMPOSER_ATTACHMENT_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const COMPOSER_ATTACHMENT_LIMITS = Object.freeze({
  maximumAttachments: MAXIMUM_COMPOSER_ATTACHMENTS,
  maximumImages: MAXIMUM_COMPOSER_ATTACHMENT_IMAGES,
  maximumAggregateBytes: MAXIMUM_COMPOSER_ATTACHMENT_AGGREGATE_BYTES,
  maximumFileBytes: MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES,
  maximumImageBytes: MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_BYTES,
  maximumImagePixels: MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_PIXELS,
  maximumImageDimension: MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_DIMENSION,
  maximumFileNameBytes: 255,
} as const);

const utf8Encoder = new TextEncoder();

/** Client-generated idempotency identity for one immutable uploaded blob. */
export const composerAttachmentIdSchema = z.uuid();

export const composerAttachmentFileNameSchema = z
  .string()
  .min(1)
  .max(COMPOSER_ATTACHMENT_LIMITS.maximumFileNameBytes)
  .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), {
    message: "Attachment file names must not contain control characters.",
  })
  .refine(
    (value) =>
      utf8Encoder.encode(value).byteLength <=
      COMPOSER_ATTACHMENT_LIMITS.maximumFileNameBytes,
    { message: "Attachment file name exceeds the UTF-8 byte limit." },
  );

const attachmentBaseShape = {
  id: composerAttachmentIdSchema,
  fileName: composerAttachmentFileNameSchema,
} as const;

export const composerAttachmentDescriptorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...attachmentBaseShape,
    kind: z.literal("image"),
    mediaType: allowedImageMimeSchema,
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(COMPOSER_ATTACHMENT_LIMITS.maximumImageBytes),
  }),
  z.strictObject({
    ...attachmentBaseShape,
    kind: z.literal("file"),
    mediaType: z.literal("application/octet-stream"),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(COMPOSER_ATTACHMENT_LIMITS.maximumFileBytes),
  }),
]);
export type ComposerAttachmentDescriptor = z.infer<
  typeof composerAttachmentDescriptorSchema
>;

export const composerAttachmentArraySchema = z
  .array(composerAttachmentDescriptorSchema)
  .max(COMPOSER_ATTACHMENT_LIMITS.maximumAttachments)
  .superRefine((attachments, context) => {
    const ids = new Set<string>();
    let aggregateBytes = 0;
    let imageCount = 0;
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index]!;
      if (ids.has(attachment.id)) {
        context.addIssue({
          code: "custom",
          message: "Composer attachment identifiers must be unique.",
          path: [index, "id"],
        });
      }
      ids.add(attachment.id);
      aggregateBytes += attachment.byteSize;
      if (attachment.kind === "image") imageCount += 1;
    }
    if (aggregateBytes > COMPOSER_ATTACHMENT_LIMITS.maximumAggregateBytes) {
      context.addIssue({
        code: "custom",
        message: "Composer attachments exceed the aggregate byte limit.",
      });
    }
    if (imageCount > COMPOSER_ATTACHMENT_LIMITS.maximumImages) {
      context.addIssue({
        code: "custom",
        message: "Composer attachments exceed the previewable image limit.",
      });
    }
  });
export type ComposerAttachmentArray = z.infer<
  typeof composerAttachmentArraySchema
>;

export function requireUniqueComposerAttachmentContentParts(
  parts: readonly {
    readonly kind: string;
    readonly attachment?: { readonly id: string };
  }[],
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.kind !== "attachment" || !part.attachment) continue;
    if (ids.has(part.attachment.id)) {
      context.addIssue({
        code: "custom",
        message: "Message attachment identifiers must be unique.",
        path: ["content", index, "attachment", "id"],
      });
    }
    ids.add(part.attachment.id);
  }
}

export const composerAttachmentReferenceArraySchema = z
  .array(composerAttachmentIdSchema)
  .max(COMPOSER_ATTACHMENT_LIMITS.maximumAttachments)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Composer attachment identifiers must be unique.",
  });

export const composerAttachmentAvailabilitySchema = z.discriminatedUnion(
  "availability",
  [
    z.strictObject({ availability: z.literal("available") }),
    z.strictObject({
      availability: z.literal("unavailable"),
      reason: boundedDisplayTextSchema,
    }),
  ],
);

export const composerAttachmentPolicySchema = z.strictObject({
  maximumAttachments: z.literal(COMPOSER_ATTACHMENT_LIMITS.maximumAttachments),
  maximumAggregateBytes: z.literal(
    COMPOSER_ATTACHMENT_LIMITS.maximumAggregateBytes,
  ),
  maximumImages: z.literal(COMPOSER_ATTACHMENT_LIMITS.maximumImages),
  maximumFileBytes: z.literal(COMPOSER_ATTACHMENT_LIMITS.maximumFileBytes),
  maximumImageBytes: z.literal(COMPOSER_ATTACHMENT_LIMITS.maximumImageBytes),
  maximumImagePixels: z.literal(COMPOSER_ATTACHMENT_LIMITS.maximumImagePixels),
  maximumImageDimension: z.literal(
    COMPOSER_ATTACHMENT_LIMITS.maximumImageDimension,
  ),
  imageMediaTypes: z.tuple([
    z.literal("image/png"),
    z.literal("image/jpeg"),
    z.literal("image/gif"),
    z.literal("image/webp"),
  ]),
});

export const COMPOSER_ATTACHMENT_POLICY = Object.freeze({
  maximumAttachments: COMPOSER_ATTACHMENT_LIMITS.maximumAttachments,
  maximumImages: COMPOSER_ATTACHMENT_LIMITS.maximumImages,
  maximumAggregateBytes: COMPOSER_ATTACHMENT_LIMITS.maximumAggregateBytes,
  maximumFileBytes: COMPOSER_ATTACHMENT_LIMITS.maximumFileBytes,
  maximumImageBytes: COMPOSER_ATTACHMENT_LIMITS.maximumImageBytes,
  maximumImagePixels: COMPOSER_ATTACHMENT_LIMITS.maximumImagePixels,
  maximumImageDimension: COMPOSER_ATTACHMENT_LIMITS.maximumImageDimension,
  imageMediaTypes: [...COMPOSER_ATTACHMENT_IMAGE_MEDIA_TYPES],
} as const satisfies z.input<typeof composerAttachmentPolicySchema>);

export const composerAttachmentCapabilitySchema = z
  .strictObject({
    fileStaging: composerAttachmentAvailabilitySchema,
    nativeImage: composerAttachmentAvailabilitySchema,
    policy: composerAttachmentPolicySchema,
  })
  .superRefine((capability, context) => {
    if (
      capability.nativeImage.availability === "available" &&
      capability.fileStaging.availability !== "available"
    ) {
      context.addIssue({
        code: "custom",
        message: "Native image input requires file staging availability.",
        path: ["nativeImage", "availability"],
      });
    }
  });
export type ComposerAttachmentCapability = z.infer<
  typeof composerAttachmentCapabilitySchema
>;
