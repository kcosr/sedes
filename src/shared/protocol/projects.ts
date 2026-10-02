import { z } from "zod";
import { apiErrorDetailSchema } from "./api.js";
import {
  environmentIdSchema,
  projectIdSchema,
  projectNameSchema,
  threadIdSchema,
  workspaceIdSchema,
} from "./domain.js";

const MAXIMUM_PROJECT_LOCATIONS = 10_000;
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/** A user-entered project name: trimmed, then non-empty and bounded. */
export const projectNameInputSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(projectNameSchema);

/** One directory on one execution environment, as a location of its project. */
export const projectLocationSchema = z
  .strictObject({
    id: workspaceIdSchema,
    environmentId: environmentIdSchema,
    environmentLabel: z.string().min(1).max(160),
    /** The directory's folder name. */
    label: z.string().min(1).max(240),
    path: z.string().min(1).max(4096),
    removed: z.boolean(),
    /** The location was taken by its project's latest removal. */
    removedWithProject: z.boolean(),
    available: z.boolean(),
    threadCount: z.number().int().nonnegative(),
    revision: revisionSchema,
  })
  .refine((location) => location.removed || !location.removedWithProject, {
    message: "Only a removed location can be marked as removed with its project.",
    path: ["removedWithProject"],
  });

/** A principal-owned project with every location, including removed ones. */
export const projectSummarySchema = z
  .strictObject({
    id: projectIdSchema,
    name: projectNameSchema,
    revision: revisionSchema,
    /** Changes whenever a location is added, removed, restored, or moved. */
    membershipRevision: revisionSchema,
    removed: z.boolean(),
    locations: z.array(projectLocationSchema).max(MAXIMUM_PROJECT_LOCATIONS),
  })
  .refine(
    (project) =>
      !project.removed || project.locations.every((location) => location.removed),
    {
      message: "A removed project cannot have an active location.",
      path: ["locations"],
    },
  );
export const listProjectsResultSchema = z.strictObject({
  projects: z.array(projectSummarySchema).max(MAXIMUM_PROJECT_LOCATIONS),
});

/** The project a directory joins when it is first added as a location. */
export const projectAssignmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("existing"), projectId: projectIdSchema }),
  z.strictObject({ kind: z.literal("new"), name: projectNameInputSchema }),
]);

/**
 * Adds a directory as a location, or restores or revalidates it when it is
 * already one. An existing location keeps its project; naming a different
 * existing project is a conflict, because joining it is a move.
 */
export const openWorkspaceRequestSchema = z.strictObject({
  environmentId: environmentIdSchema,
  path: z.string().min(1).max(4096),
  project: projectAssignmentSchema,
});
export const openWorkspaceResultSchema = z.strictObject({
  id: workspaceIdSchema,
  projectId: projectIdSchema,
});

export const renameProjectRequestSchema = z.strictObject({
  name: projectNameInputSchema,
  expectedRevision: revisionSchema,
});
export const removeProjectRequestSchema = z.strictObject({
  expectedRevision: revisionSchema,
  expectedMembershipRevision: revisionSchema,
});
export const restoreProjectRequestSchema = z
  .strictObject({
    expectedRevision: revisionSchema,
    /** Removed locations to restore after the project, each individually. */
    locationIds: z.array(workspaceIdSchema).max(MAXIMUM_PROJECT_LOCATIONS),
  })
  .refine(
    (request) => new Set(request.locationIds).size === request.locationIds.length,
    { message: "Location identifiers must be unique.", path: ["locationIds"] },
  );
export const restoredLocationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ id: workspaceIdSchema, status: z.literal("restored") }),
  z.strictObject({
    id: workspaceIdSchema,
    status: z.literal("failed"),
    error: apiErrorDetailSchema,
  }),
]);
export const restoreProjectResultSchema = z.strictObject({
  project: projectSummarySchema,
  /** One result per requested location, in request order. */
  locations: z
    .array(restoredLocationResultSchema)
    .max(MAXIMUM_PROJECT_LOCATIONS),
});
/** Moves every location into the target and deletes the source. */
export const mergeProjectRequestSchema = z.strictObject({
  targetProjectId: projectIdSchema,
  expectedSourceMembershipRevision: revisionSchema,
  expectedTargetMembershipRevision: revisionSchema,
});

export const removeLocationRequestSchema = z.strictObject({
  expectedRevision: revisionSchema,
});
export const moveLocationRequestSchema = z.strictObject({
  target: projectAssignmentSchema,
  expectedRevision: revisionSchema,
});

export const projectRemovalBlockerKindSchema = z.enum([
  "durable_work",
  "enabled_schedule",
  "live_terminal",
]);
export const projectRemovalBlockerSchema = z.strictObject({
  locationId: workspaceIdSchema,
  environmentId: environmentIdSchema,
  kind: projectRemovalBlockerKindSchema,
  threadIds: z.array(threadIdSchema).min(1).max(10_000),
});
/** Every blocker across the project's active locations, not only the first. */
export const projectRemovalBlockedErrorSchema = z.strictObject({
  error: apiErrorDetailSchema.extend({ code: z.literal("invalid_transition") }),
  blockers: z
    .array(projectRemovalBlockerSchema)
    .min(1)
    .max(projectRemovalBlockerKindSchema.options.length * MAXIMUM_PROJECT_LOCATIONS),
});

export type ProjectLocation = z.infer<typeof projectLocationSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ListProjectsResult = z.infer<typeof listProjectsResultSchema>;
export type ProjectAssignment = z.infer<typeof projectAssignmentSchema>;
export type OpenWorkspaceRequest = z.infer<typeof openWorkspaceRequestSchema>;
export type OpenWorkspaceResult = z.infer<typeof openWorkspaceResultSchema>;
export type RenameProjectRequest = z.infer<typeof renameProjectRequestSchema>;
export type RemoveProjectRequest = z.infer<typeof removeProjectRequestSchema>;
export type RestoreProjectRequest = z.infer<typeof restoreProjectRequestSchema>;
export type RestoredLocationResult = z.infer<typeof restoredLocationResultSchema>;
export type RestoreProjectResult = z.infer<typeof restoreProjectResultSchema>;
export type MergeProjectRequest = z.infer<typeof mergeProjectRequestSchema>;
export type RemoveLocationRequest = z.infer<typeof removeLocationRequestSchema>;
export type MoveLocationRequest = z.infer<typeof moveLocationRequestSchema>;
export type ProjectRemovalBlocker = z.infer<typeof projectRemovalBlockerSchema>;
export type ProjectRemovalBlockedResponse = z.infer<
  typeof projectRemovalBlockedErrorSchema
>;
