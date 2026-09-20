import { normalizedAbsolutePath } from "../../shared/absolute-path.js";
import { z } from "zod";
import {
  SidecarOperationRegistry,
  defineSidecarOperation,
  type SidecarOperationContext,
} from "./operation-registry.js";

export const DIRECTORY_BROWSER_CAPABILITY_ID = "directory_browser" as const;
export const DIRECTORY_BROWSER_MAJOR_VERSION = 1 as const;
export const DIRECTORY_BROWSER_DEFAULT_PAGE_SIZE = 50;
export const DIRECTORY_BROWSER_MAXIMUM_PAGE_SIZE = 200;

const canonicalAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => normalizedAbsolutePath(value),
    "directory_browser_path_invalid",
  );

const directoryNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !/[\u0000-\u001f\u007f\\]/u.test(value) &&
      Buffer.byteLength(value, "utf8") <= 255,
    "directory_browser_name_invalid",
  );

const cursorSchema = z
  .string()
  .min(40)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+\.[0-9a-z]+\.[A-Za-z0-9_-]+$/u);

export const directoryBrowserListImmediateOperation = defineSidecarOperation({
  capabilityId: DIRECTORY_BROWSER_CAPABILITY_ID,
  majorVersion: DIRECTORY_BROWSER_MAJOR_VERSION,
  operation: "directories.list",
  lane: "operation",
  maximumDeadlineMilliseconds: 15_000,
  requestSchema: z.strictObject({
    rootPath: canonicalAbsolutePathSchema,
    directoryPath: canonicalAbsolutePathSchema,
    pageSize: z.number().int().min(1).max(DIRECTORY_BROWSER_MAXIMUM_PAGE_SIZE),
    cursor: cursorSchema.optional(),
  }),
  responseSchema: z.strictObject({
    directoryPath: canonicalAbsolutePathSchema,
    entries: z
      .array(
        z.strictObject({
          name: directoryNameSchema,
          path: canonicalAbsolutePathSchema,
        }),
      )
      .max(DIRECTORY_BROWSER_MAXIMUM_PAGE_SIZE),
    nextCursor: cursorSchema.optional(),
    truncated: z.boolean(),
  }),
});

export const directoryBrowserV1Operations = Object.freeze([
  directoryBrowserListImmediateOperation,
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

export interface DirectoryBrowserV1Handlers {
  readonly listImmediate: HandlerFor<
    typeof directoryBrowserListImmediateOperation
  >;
}

export function registerDirectoryBrowserV1Operations(
  registry: SidecarOperationRegistry,
  handlers: DirectoryBrowserV1Handlers,
): void {
  registry.register(
    directoryBrowserListImmediateOperation,
    handlers.listImmediate,
  );
}
