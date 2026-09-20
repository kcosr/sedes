import type {
  WorkspaceSkillsV1ErrorCode,
  WorkspaceSkillDiagnostic,
  WorkspaceSkillMetadata,
} from "../../internal/sidecar-protocol/index.js";

export class WorkspaceSkillReaderError extends Error {
  constructor(
    readonly code: WorkspaceSkillsV1ErrorCode,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "WorkspaceSkillReaderError";
  }
}

export interface WorkspaceSkillCatalog {
  readonly skills: readonly WorkspaceSkillMetadata[];
  readonly diagnostics: readonly WorkspaceSkillDiagnostic[];
  readonly catalogFingerprint: string;
}

export interface ResolvedWorkspaceSkill {
  readonly skill: WorkspaceSkillMetadata;
  readonly content: string;
}

/**
 * Data-only Agent Skills reader for one admitted execution workspace. Native
 * paths and bodies remain server-private and never enter normalized contracts.
 */
export interface WorkspaceSkillReader {
  readCatalog(signal?: AbortSignal): Promise<WorkspaceSkillCatalog>;
  resolve(
    input: {
      readonly catalogFingerprint: string;
      readonly id: string;
    },
    signal?: AbortSignal,
  ): Promise<ResolvedWorkspaceSkill>;
}
