import {
  SidecarOperationError,
  type WorkspaceSkillsV1Handlers,
} from "../../internal/sidecar-protocol/index.js";
import {
  scanWorkspaceSkills,
  WorkspaceSkillsScannerError,
} from "./workspace-skills-scanner.js";

export class WorkspaceSkillsSidecarHost {
  readonly handlers: WorkspaceSkillsV1Handlers;
  readonly #homeDirectory: string | undefined;
  #closed = false;

  constructor(options: { readonly homeDirectory?: string } = {}) {
    this.#homeDirectory = options.homeDirectory;
    this.handlers = {
      readCatalog: (request, context) =>
        this.#readCatalog(request, context.signal),
      resolveSkill: (request, context) =>
        this.#resolveSkill(request, context.signal),
    };
  }

  close(): void {
    this.#closed = true;
  }

  async #readCatalog(
    request: { readonly declaredPath: string; readonly policyRootPath: string },
    signal: AbortSignal,
  ) {
    const result = await this.#scan(request, signal);
    return {
      skills: result.skills,
      diagnostics: result.diagnostics,
      catalogFingerprint: result.catalogFingerprint,
    };
  }

  async #resolveSkill(
    request: {
      readonly declaredPath: string;
      readonly policyRootPath: string;
      readonly catalogFingerprint: string;
      readonly id: string;
    },
    signal: AbortSignal,
  ) {
    const result = await this.#scan(request, signal);
    if (result.catalogFingerprint !== request.catalogFingerprint) {
      throw new SidecarOperationError("workspace_skills_catalog_changed");
    }
    const resolved = result.resolvedSkills.get(request.id);
    if (!resolved) {
      throw new SidecarOperationError("workspace_skills_skill_not_found");
    }
    const { content, ...skill } = resolved;
    return { skill, content };
  }

  async #scan(
    request: { readonly declaredPath: string; readonly policyRootPath: string },
    signal: AbortSignal,
  ) {
    if (this.#closed) {
      throw new SidecarOperationError("workspace_skills_unavailable");
    }
    try {
      return await scanWorkspaceSkills({
        workspacePath: request.declaredPath,
        policyRootPath: request.policyRootPath,
        ...(this.#homeDirectory ? { homeDirectory: this.#homeDirectory } : {}),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new SidecarOperationError("workspace_skills_cancelled");
      }
      if (error instanceof WorkspaceSkillsScannerError) {
        const code =
          error.code === "workspace_skills_limit_exceeded"
            ? "workspace_skills_limit_exceeded"
            : error.code === "workspace_skills_unstable"
              ? "workspace_skills_path_unstable"
              : "workspace_skills_workspace_outside_policy";
        throw new SidecarOperationError(code);
      }
      throw new SidecarOperationError("workspace_skills_read_failed");
    }
  }
}
