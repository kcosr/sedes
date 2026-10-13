import { z } from "zod";
import { normalizedAbsolutePath } from "../absolute-path.js";
import { WORKSPACE_FILE_MAX_PATH_BYTES } from "../workspace-file-limits.js";
import { normalizedImageSchema } from "./output-artifacts.js";

export const imageShowRequestSchema = z.strictObject({
  path: z.string().min(1).max(WORKSPACE_FILE_MAX_PATH_BYTES)
    .refine(normalizedAbsolutePath, "Provide a normalized absolute image path.")
    .refine(value => new TextEncoder().encode(value).byteLength <= WORKSPACE_FILE_MAX_PATH_BYTES,
      "Image path exceeds the Files path limit."),
  title: z.string().trim().min(1).max(240).optional(),
});
export type ImageShowRequest = z.infer<typeof imageShowRequestSchema>;

export const imageShowResultSchema = z.strictObject({ image: normalizedImageSchema.options[0] });
export type ImageShowResult = z.infer<typeof imageShowResultSchema>;
