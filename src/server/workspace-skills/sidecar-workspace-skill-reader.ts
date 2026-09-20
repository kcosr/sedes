import { randomUUID } from "node:crypto";
import {
  SidecarOperationError,
  workspaceSkillsCatalogReadOperation,
  workspaceSkillsResolveOperation,
  workspaceSkillsV1ErrorCodeSchema,
  type SidecarOperationDefinition,
} from "../../internal/sidecar-protocol/index.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import type { SidecarRuntimeOwner } from "../sidecar/sidecar-runtime.js";
import {
  WorkspaceSkillReaderError,
  type WorkspaceSkillReader,
} from "./contracts.js";

export class SidecarWorkspaceSkillReader implements WorkspaceSkillReader {
  readonly #admissionId = randomUUID();

  constructor(
    private readonly input: {
      readonly runtime: SidecarRuntimeOwner<SidecarClientSession>;
      readonly scope: RequestScope;
      readonly environmentId: string;
      readonly declaredPath: string;
      readonly policyRootPath: string;
    },
  ) {}

  async readCatalog(signal?: AbortSignal) {
    return await this.#call(
      workspaceSkillsCatalogReadOperation,
      {
        admissionId: this.#admissionId,
        declaredPath: this.input.declaredPath,
        policyRootPath: this.input.policyRootPath,
      },
      signal,
    );
  }

  async resolve(
    input: { readonly catalogFingerprint: string; readonly id: string },
    signal?: AbortSignal,
  ) {
    return await this.#call(
      workspaceSkillsResolveOperation,
      {
        admissionId: this.#admissionId,
        declaredPath: this.input.declaredPath,
        policyRootPath: this.input.policyRootPath,
        catalogFingerprint: input.catalogFingerprint,
        id: input.id,
      },
      signal,
    );
  }

  async #call<Request, Response>(
    definition: SidecarOperationDefinition<Request, Response>,
    request: Request,
    signal?: AbortSignal,
  ): Promise<Response> {
    const effectiveSignal = signal ?? new AbortController().signal;
    const lease = await this.input.runtime.acquireOperation(
      this.input.scope,
      this.input.environmentId,
      effectiveSignal,
    );
    try {
      try {
        return await lease.session.call(definition, request, {
          signal: effectiveSignal,
        });
      } catch (error) {
        if (error instanceof SidecarOperationError) {
          const code = workspaceSkillsV1ErrorCodeSchema.safeParse(error.code);
          if (code.success) {
            throw new WorkspaceSkillReaderError(code.data, error.retryable, {
              cause: error,
            });
          }
        }
        throw error;
      }
    } finally {
      lease.release();
    }
  }
}
