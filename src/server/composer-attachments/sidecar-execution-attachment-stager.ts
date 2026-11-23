import { createHash, randomUUID } from "node:crypto";
import {
  SidecarOperationError,
  SidecarProtocolDeliveryError,
  composerAttachmentsMaterializationAbortOperation,
  composerAttachmentsMaterializationAppendOperation,
  composerAttachmentsMaterializationCommitOperation,
  composerAttachmentsMaterializationOpenOperation,
  composerAttachmentsMaterializationReleaseOperation,
} from "../../internal/sidecar-protocol/index.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { deriveComposerAttachmentScopeKey } from "../security/installation-secret.js";
import type { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import {
  SidecarUnavailableError,
  type SidecarRuntimeLease,
  type SidecarRuntimeOwner,
} from "../sidecar/sidecar-runtime.js";
import { COMPOSER_ATTACHMENT_CHUNK_BYTES } from "./execution-attachment-staging-engine.js";
import {
  ExecutionAttachmentStagingUnavailableError,
  assertStagingLease,
  sameRequestScope,
  type ExecutionAttachmentMaterializationRequest,
  type ExecutionAttachmentReleaseRequest,
  type ExecutionAttachmentStager,
} from "./execution-attachment-stager.js";

const MAXIMUM_RECONCILIATION_ATTEMPTS = 3;

export class SidecarExecutionAttachmentStager implements ExecutionAttachmentStager {
  readonly #scope: RequestScope;
  readonly #environmentId: string;
  readonly #scopeKey: string;
  readonly #runtime: SidecarRuntimeOwner<SidecarClientSession>;
  readonly #enabled: () => boolean;
  #closed = false;

  constructor(readonly input: {
    readonly readAttachmentGeneration?: () => number | undefined;
    readonly scope: RequestScope;
    readonly enabled?: () => boolean;
    readonly environmentId: string;
    readonly installationKey: Uint8Array;
    readonly runtime: SidecarRuntimeOwner<SidecarClientSession>;
  }) {
    if (!input.environmentId) {
      throw new Error("sidecar_attachment_stager_configuration_invalid");
    }
    this.#enabled = input.enabled ?? (() => true);
    this.#scope = Object.freeze({ ...input.scope });
    this.#environmentId = input.environmentId;
    this.#scopeKey = deriveComposerAttachmentScopeKey(
      input.installationKey,
      input.scope,
    );
    this.#runtime = input.runtime;
  }

  #authority(request: ExecutionAttachmentMaterializationRequest | ExecutionAttachmentReleaseRequest) {
    if (!this.input.readAttachmentGeneration) return undefined;
    const workspace = request.lease.workspace;
    const featureGeneration = this.input.readAttachmentGeneration();
    if (!workspace.authorityRootId || featureGeneration === undefined) throw unavailable(new Error("composer_attachment_authority_stale"));
    return { path: workspace.canonicalPath, rootId: workspace.authorityRootId, rootGeneration: workspace.authorityRevision, featureGeneration };
  }

  supports(scope: RequestScope, environmentId: string): boolean {
    return (
      !this.#closed && this.#enabled() &&
      sameRequestScope(scope, this.#scope) &&
      environmentId === this.#environmentId
    );
  }

  async materialize(
    scope: RequestScope,
    request: ExecutionAttachmentMaterializationRequest,
  ) {
    this.#assert(scope, request);
    const workspaceAuthority = this.#authority(request);
    const check = () => {
      request.lease.assertCurrent?.();
      if (workspaceAuthority && workspaceAuthority.featureGeneration !== this.input.readAttachmentGeneration?.()) throw unavailable(new Error("composer_attachment_authority_stale"));
    };
    check();
    const admissionId = randomUUID();
    let uncertain: unknown;
    for (
      let attempt = 0;
      attempt < MAXIMUM_RECONCILIATION_ATTEMPTS;
      attempt += 1
    ) {
      request.signal?.throwIfAborted();
      let lease: SidecarRuntimeLease<SidecarClientSession>;
      try {
        lease = await this.#runtime.acquireOperation(
          scope,
          this.#environmentId,
          request.signal ?? new AbortController().signal,
        );
      } catch (error) {
        throw unavailable(error);
      }
      let uploadHandle: string | undefined;
      try {
        check();
        const opened = await lease.session.call(
          composerAttachmentsMaterializationOpenOperation,
          {
            admissionId,
            ...(workspaceAuthority && { workspaceAuthority }),
            scopeKey: this.#scopeKey,
            threadId: request.applicationThreadId,
            attachmentId: request.attachmentId,
            sha256: request.sha256,
            sizeBytes: request.sizeBytes,
            extension: request.safeExtension,
          },
          request.signal ? { signal: request.signal } : undefined,
        );
        if (opened.state === "ready") return withoutState(opened);
        uploadHandle = opened.uploadHandle;
        check();
        let offset = opened.nextOffset;
        for await (const piece of chunksFromOffset(
          request.content(),
          offset,
          request.signal,
        )) {
          check();
          const appended = await lease.session.call(
            composerAttachmentsMaterializationAppendOperation,
            {
              uploadHandle,
              offset,
              decodedBytes: piece.byteLength,
              chunkSha256: createHash("sha256").update(piece).digest("hex"),
              contentBase64: Buffer.from(piece).toString("base64"),
            },
            request.signal ? { signal: request.signal } : undefined,
          );
          offset = appended.nextOffset;
        }
        check();
        return await lease.session.call(
          composerAttachmentsMaterializationCommitOperation,
          { uploadHandle },
          request.signal ? { signal: request.signal } : undefined,
        );
      } catch (error) {
        if (isOutcomeUnknown(error)) {
          uncertain = error;
          continue;
        }
        if (uploadHandle) {
          await lease.session
            .call(composerAttachmentsMaterializationAbortOperation, {
              uploadHandle,
            })
            .catch(() => undefined);
        }
        throw classify(error);
      } finally {
        lease.release();
      }
    }
    throw unavailable(uncertain);
  }

  async release(
    scope: RequestScope,
    request: ExecutionAttachmentReleaseRequest,
  ): Promise<void> {
    this.#assert(scope, request);
    let uncertain: unknown;
    for (
      let attempt = 0;
      attempt < MAXIMUM_RECONCILIATION_ATTEMPTS;
      attempt += 1
    ) {
      let lease: SidecarRuntimeLease<SidecarClientSession>;
      try {
        lease = await this.#runtime.acquireOperation(
          scope,
          this.#environmentId,
          request.signal ?? new AbortController().signal,
        );
      } catch (error) {
        throw unavailable(error);
      }
      try {
        await lease.session.call(
          composerAttachmentsMaterializationReleaseOperation,
          {
            scopeKey: this.#scopeKey,
            workspaceAuthority: this.#authority(request),
            threadId: request.applicationThreadId,
            attachmentId: request.attachmentId,
            expectedSha256: request.expectedSha256,
          },
          request.signal ? { signal: request.signal } : undefined,
        );
        return;
      } catch (error) {
        if (!isOutcomeUnknown(error)) throw classify(error);
        uncertain = error;
      } finally {
        lease.release();
      }
    }
    throw unavailable(uncertain);
  }

  close(): void {
    // Production owns the shared environment-scoped runtime. Closing this
    // capability must not stop Files or another enabled capability.
    this.#closed = true;
  }

  #assert(
    scope: RequestScope,
    request:
      | ExecutionAttachmentMaterializationRequest
      | ExecutionAttachmentReleaseRequest,
  ): void {
    if (!this.supports(scope, this.#environmentId)) {
      throw new ExecutionAttachmentStagingUnavailableError();
    }
    assertStagingLease(scope, this.#environmentId, request.lease);
  }
}

async function* chunksFromOffset(
  source: AsyncIterable<Uint8Array>,
  requestedOffset: number,
  signal: AbortSignal | undefined,
): AsyncIterable<Uint8Array> {
  let skipped = 0;
  for await (const input of source) {
    signal?.throwIfAborted();
    if (!(input instanceof Uint8Array)) {
      throw new Error("composer_attachment_content_invalid");
    }
    let chunk = input;
    if (skipped < requestedOffset) {
      const discard = Math.min(chunk.byteLength, requestedOffset - skipped);
      skipped += discard;
      chunk = chunk.subarray(discard);
    }
    while (chunk.byteLength > 0) {
      const piece = chunk.subarray(0, COMPOSER_ATTACHMENT_CHUNK_BYTES);
      yield piece;
      chunk = chunk.subarray(piece.byteLength);
    }
  }
  if (skipped !== requestedOffset) {
    throw new Error("composer_attachment_content_short");
  }
}

function isOutcomeUnknown(error: unknown): boolean {
  return (
    error instanceof SidecarProtocolDeliveryError &&
    error.delivery === "sent_outcome_unknown"
  );
}

function classify(error: unknown): Error {
  if (error instanceof SidecarOperationError) {
    return new Error(error.code, { cause: error });
  }
  if (error instanceof SidecarUnavailableError) return unavailable(error);
  return error instanceof Error ? error : unavailable(error);
}

function unavailable(
  error: unknown,
): ExecutionAttachmentStagingUnavailableError {
  return new ExecutionAttachmentStagingUnavailableError(
    error === undefined ? undefined : { cause: error },
  );
}

function withoutState(input: {
  readonly agentPath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}) {
  return {
    agentPath: input.agentPath,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
  };
}
