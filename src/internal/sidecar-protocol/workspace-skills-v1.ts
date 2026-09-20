import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SidecarOperationRegistry,
  defineSidecarOperation,
  type SidecarOperationContext,
} from "./operation-registry.js";
import { workspaceToolsAbsolutePathSchema } from "./workspace-tools-v2.js";

export const WORKSPACE_SKILLS_CAPABILITY_ID = "workspace_skills" as const;
export const WORKSPACE_SKILLS_MAJOR_VERSION = 1 as const;
export const WORKSPACE_SKILLS_MAXIMUM_FILE_BYTES = 256 * 1024;
export const WORKSPACE_SKILLS_MAXIMUM_SKILLS = 128;
export const WORKSPACE_SKILLS_MAXIMUM_DIAGNOSTICS = 128;
export const WORKSPACE_SKILLS_MAXIMUM_SCAN_ENTRIES = 4_096;
export const WORKSPACE_SKILLS_MAXIMUM_DEPTH = 16;
export const WORKSPACE_SKILLS_MAXIMUM_CATALOG_BYTES = 256 * 1024;
export const WORKSPACE_SKILLS_V1_LIMITS = Object.freeze({
  maximumFileBytes: WORKSPACE_SKILLS_MAXIMUM_FILE_BYTES,
  maximumSkills: WORKSPACE_SKILLS_MAXIMUM_SKILLS,
  maximumDiagnostics: WORKSPACE_SKILLS_MAXIMUM_DIAGNOSTICS,
  maximumScanEntries: WORKSPACE_SKILLS_MAXIMUM_SCAN_ENTRIES,
  maximumDepth: WORKSPACE_SKILLS_MAXIMUM_DEPTH,
  maximumCatalogBytes: WORKSPACE_SKILLS_MAXIMUM_CATALOG_BYTES,
});

export const workspaceSkillsV1ErrorCodeSchema = z.enum([
  "workspace_skills_unavailable",
  "workspace_skills_workspace_invalid",
  "workspace_skills_workspace_outside_policy",
  "workspace_skills_path_unstable",
  "workspace_skills_limit_exceeded",
  "workspace_skills_read_failed",
  "workspace_skills_catalog_changed",
  "workspace_skills_skill_not_found",
  "workspace_skills_cancelled",
]);
export type WorkspaceSkillsV1ErrorCode = z.infer<
  typeof workspaceSkillsV1ErrorCodeSchema
>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const skillDescriptionSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 4_096,
    "workspace_skills_description_too_large",
  );
const skillSourceSchema = z.enum([
  "account_pi",
  "account_agents",
  "workspace_pi",
  "workspace_agents",
]);

export const workspaceSkillMetadataSchema = z.strictObject({
  id: sha256Schema,
  name: skillNameSchema,
  description: skillDescriptionSchema,
  source: skillSourceSchema,
  filePath: workspaceToolsAbsolutePathSchema,
  baseDir: workspaceToolsAbsolutePathSchema,
  contentSha256: sha256Schema,
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(WORKSPACE_SKILLS_MAXIMUM_FILE_BYTES),
  disableModelInvocation: z.boolean(),
});

export const workspaceSkillDiagnosticSchema = z.strictObject({
  code: z.enum(["invalid_skill", "name_collision"]),
  source: skillSourceSchema,
  filePath: workspaceToolsAbsolutePathSchema,
  name: skillNameSchema.optional(),
  winnerId: sha256Schema.optional(),
});

const catalogResponseSchema = z
  .strictObject({
    skills: z
      .array(workspaceSkillMetadataSchema)
      .max(WORKSPACE_SKILLS_MAXIMUM_SKILLS),
    diagnostics: z
      .array(workspaceSkillDiagnosticSchema)
      .max(WORKSPACE_SKILLS_MAXIMUM_DIAGNOSTICS),
    catalogFingerprint: sha256Schema,
  })
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), "utf8") <=
      WORKSPACE_SKILLS_MAXIMUM_CATALOG_BYTES,
    "workspace_skills_catalog_too_large",
  );

const authorityRequestSchema = z.strictObject({
  admissionId: z.string().uuid(),
  declaredPath: workspaceToolsAbsolutePathSchema,
  policyRootPath: workspaceToolsAbsolutePathSchema,
});

export const workspaceSkillsCatalogReadOperation = defineSidecarOperation({
  capabilityId: WORKSPACE_SKILLS_CAPABILITY_ID,
  majorVersion: WORKSPACE_SKILLS_MAJOR_VERSION,
  operation: "catalog.read",
  lane: "operation",
  maximumDeadlineMilliseconds: 30_000,
  requestSchema: authorityRequestSchema,
  responseSchema: catalogResponseSchema,
});

export const workspaceSkillsResolveOperation = defineSidecarOperation({
  capabilityId: WORKSPACE_SKILLS_CAPABILITY_ID,
  majorVersion: WORKSPACE_SKILLS_MAJOR_VERSION,
  operation: "skill.resolve",
  lane: "operation",
  maximumDeadlineMilliseconds: 30_000,
  requestSchema: authorityRequestSchema.extend({
    catalogFingerprint: sha256Schema,
    id: sha256Schema,
  }),
  responseSchema: z
    .strictObject({
      skill: workspaceSkillMetadataSchema,
      content: z
        .string()
        .refine(
          (value) =>
            Buffer.byteLength(value, "utf8") <=
            WORKSPACE_SKILLS_MAXIMUM_FILE_BYTES,
          "workspace_skills_content_too_large",
        ),
    })
    .refine(
      (value) =>
        Buffer.byteLength(value.content, "utf8") === value.skill.sizeBytes,
      "workspace_skills_size_mismatch",
    )
    .refine(
      (value) =>
        createHash("sha256").update(value.content).digest("hex") ===
        value.skill.contentSha256,
      "workspace_skills_digest_mismatch",
    ),
});

export const workspaceSkillsV1Operations = Object.freeze([
  workspaceSkillsCatalogReadOperation,
  workspaceSkillsResolveOperation,
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

export interface WorkspaceSkillsV1Handlers {
  readonly readCatalog: HandlerFor<typeof workspaceSkillsCatalogReadOperation>;
  readonly resolveSkill: HandlerFor<typeof workspaceSkillsResolveOperation>;
}

export type WorkspaceSkillsCatalogReadRequest = z.infer<
  typeof workspaceSkillsCatalogReadOperation.requestSchema
>;
export type WorkspaceSkillsCatalogReadResponse = z.infer<
  typeof workspaceSkillsCatalogReadOperation.responseSchema
>;
export type WorkspaceSkillsResolveRequest = z.infer<
  typeof workspaceSkillsResolveOperation.requestSchema
>;
export type WorkspaceSkillsResolveResponse = z.infer<
  typeof workspaceSkillsResolveOperation.responseSchema
>;
export type WorkspaceSkillMetadata = z.infer<
  typeof workspaceSkillMetadataSchema
>;
export type WorkspaceSkillDiagnostic = z.infer<
  typeof workspaceSkillDiagnosticSchema
>;

export function registerWorkspaceSkillsV1Operations(
  registry: SidecarOperationRegistry,
  handlers: WorkspaceSkillsV1Handlers,
): void {
  registry.register(workspaceSkillsCatalogReadOperation, handlers.readCatalog);
  registry.register(workspaceSkillsResolveOperation, handlers.resolveSkill);
}
