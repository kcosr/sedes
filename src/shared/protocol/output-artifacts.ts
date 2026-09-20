import { z } from "zod";
import { MAXIMUM_OUTPUT_IMAGE_BYTES } from "../output-artifact-limits.js";
import { outputArtifactIdSchema } from "./domain.js";
import { allowedImageMimeSchema, boundedDisplayTextSchema } from "./payload.js";

export { MAXIMUM_OUTPUT_IMAGE_BYTES };

export const normalizedImageSchema = z.discriminatedUnion("representation", [
  z.strictObject({
    representation: z.literal("artifact"),
    artifactId: outputArtifactIdSchema,
    mimeType: allowedImageMimeSchema,
    byteSize: z.number().int().positive().max(MAXIMUM_OUTPUT_IMAGE_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    alt: boundedDisplayTextSchema.optional(),
    fileName: boundedDisplayTextSchema.optional(),
  }),
  z.strictObject({
    representation: z.literal("omitted"),
    mimeType: allowedImageMimeSchema.optional(),
    alt: boundedDisplayTextSchema.optional(),
    reason: z.enum([
      "byte_limit",
      "unsupported_mime",
      "invalid_data",
      "unavailable",
    ]),
  }),
]);
export type NormalizedImage = z.infer<typeof normalizedImageSchema>;
