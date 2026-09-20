import { z } from "zod";
import { environmentIdSchema, workspaceIdSchema } from "./domain.js";

/** Principal-owned remembered directories, including removed registrations. */
export const projectSummarySchema = z.strictObject({
  id: workspaceIdSchema,
  environmentId: environmentIdSchema,
  environmentLabel: z.string().min(1).max(160),
  label: z.string().min(1).max(240),
  path: z.string().min(1).max(4096),
  removed: z.boolean(),
  available: z.boolean(),
  threadCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export const listProjectsResultSchema = z.strictObject({ projects: z.array(projectSummarySchema) });
export const removeProjectRequestSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative() });
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ListProjectsResult = z.infer<typeof listProjectsResultSchema>;
export type RemoveProjectRequest = z.infer<typeof removeProjectRequestSchema>;
