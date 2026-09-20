import type { RequestScope } from "../identity/identity-provider.js";
import type { ExecutionEnvironmentLease } from "../execution/contracts.js";

export interface ExecutionAttachmentMaterializationRequest {
  readonly lease: ExecutionEnvironmentLease;
  readonly applicationThreadId: string;
  readonly attachmentId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly safeExtension: string;
  /** Must return a fresh exact-byte stream on every call for reconciliation. */
  readonly content: () => AsyncIterable<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface MaterializedExecutionAttachment {
  readonly agentPath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ExecutionAttachmentReleaseRequest {
  readonly lease: ExecutionEnvironmentLease;
  readonly applicationThreadId: string;
  readonly attachmentId: string;
  readonly expectedSha256: string;
  readonly signal?: AbortSignal;
}

export interface ExecutionAttachmentStager {
  supports(scope: RequestScope, environmentId: string): boolean;
  materialize(
    scope: RequestScope,
    request: ExecutionAttachmentMaterializationRequest,
  ): Promise<MaterializedExecutionAttachment>;
  release(
    scope: RequestScope,
    request: ExecutionAttachmentReleaseRequest,
  ): Promise<void>;
  close(): void | Promise<void>;
}

export class ExecutionAttachmentStagingUnavailableError extends Error {
  readonly diagnosticCode = "composer_attachment_staging_unavailable" as const;

  constructor(options?: ErrorOptions) {
    super("composer_attachment_staging_unavailable", options);
    this.name = "ExecutionAttachmentStagingUnavailableError";
  }
}

export class UnsupportedExecutionAttachmentStager implements ExecutionAttachmentStager {
  supports(_scope: RequestScope, _environmentId: string): boolean {
    return false;
  }

  async materialize(
    _scope: RequestScope,
    _request: ExecutionAttachmentMaterializationRequest,
  ): Promise<never> {
    throw new ExecutionAttachmentStagingUnavailableError();
  }

  async release(
    _scope: RequestScope,
    _request: ExecutionAttachmentReleaseRequest,
  ): Promise<never> {
    throw new ExecutionAttachmentStagingUnavailableError();
  }

  close(): void {}
}

export function sameRequestScope(
  left: RequestScope,
  right: RequestScope,
): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

export function assertStagingLease(
  scope: RequestScope,
  environmentId: string,
  lease: ExecutionEnvironmentLease,
): void {
  if (
    !sameRequestScope(scope, lease.scope) ||
    lease.environment.id !== environmentId ||
    lease.workspace.summary.environmentId !== environmentId ||
    lease.workspace.authorityRevision < 0
  ) {
    throw new ExecutionAttachmentStagingUnavailableError();
  }
}
