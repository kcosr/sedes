import { normalizedAbsolutePath } from "../absolute-path.js";
import { z } from "zod";

export const DIRECTORY_BROWSE_DEFAULT_PAGE_SIZE = 50;
export const DIRECTORY_BROWSE_MAXIMUM_PAGE_SIZE = 200;

export const directoryBrowsePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 4096)
  .refine(normalizedAbsolutePath, {
    message: "Directory path must be a normalized absolute path.",
  });

const directoryBrowseLocationRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("roots") }),
  z.strictObject({
    kind: z.literal("directory"),
    path: directoryBrowsePathSchema,
  }),
]);

export const directoryBrowseRequestSchema = z.strictObject({
  location: directoryBrowseLocationRequestSchema,
  cursor: z.string().min(1).max(2048).optional(),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(DIRECTORY_BROWSE_MAXIMUM_PAGE_SIZE)
    .default(DIRECTORY_BROWSE_DEFAULT_PAGE_SIZE),
});
export type DirectoryBrowseRequest = z.input<
  typeof directoryBrowseRequestSchema
>;
export type ParsedDirectoryBrowseRequest = z.output<
  typeof directoryBrowseRequestSchema
>;

const directoryBrowseLocationResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("roots") }),
  z.strictObject({
    kind: z.literal("directory"),
    path: directoryBrowsePathSchema,
    parentPath: directoryBrowsePathSchema.optional(),
  }),
]);

export const directoryBrowseEntrySchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => new TextEncoder().encode(value).byteLength <= 255)
    .refine(
      (value) =>
        value !== "." &&
        value !== ".." &&
        !value.includes("/") &&
        !value.includes("\\") &&
        !/\p{Cc}/u.test(value),
      { message: "Directory entry name is invalid." },
    ),
  path: directoryBrowsePathSchema,
});

export const directoryBrowseResultSchema = z.strictObject({
  location: directoryBrowseLocationResultSchema,
  entries: z
    .array(directoryBrowseEntrySchema)
    .max(DIRECTORY_BROWSE_MAXIMUM_PAGE_SIZE),
  nextCursor: z.string().min(1).max(2048).optional(),
  truncated: z.boolean(),
});
export type DirectoryBrowseResult = z.infer<typeof directoryBrowseResultSchema>;
