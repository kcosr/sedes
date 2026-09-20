import { createHash } from "node:crypto";
import path from "node:path";
import type { ComposerAttachmentDescriptor } from "../../shared/protocol/composer-attachments.js";
import {
  BackendError,
  type CanonicalComposerAttachmentByteReader,
  type CanonicalComposerAttachmentEvidence,
  type CanonicalComposerAttachmentEvidenceResolver,
  type StagedComposerAttachment,
} from "../backends/contracts.js";
import type { ExecutionEnvironmentLease } from "../execution/contracts.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ExecutionAttachmentStager } from "./execution-attachment-stager.js";
import type { ComposerAttachmentService } from "./service.js";
import type { ComposerAttachmentMaterializationPersistence } from "../db/repositories/composer-attachment-repository.js";

export interface MaterializedComposerAttachmentDelivery {
  readonly attachments: readonly StagedComposerAttachment[];
  readonly canonicalBytes: CanonicalComposerAttachmentByteReader;
  readonly canonicalEvidence: CanonicalComposerAttachmentEvidenceResolver;
}

/**
 * Application-owned bridge from durable attachment identities to exact bytes
 * staged inside the actor's leased execution environment. Native provider
 * image inputs remain a backend-owned optional representation of this result.
 */
export class ComposerAttachmentDeliveryService {
  constructor(
    readonly attachments: ComposerAttachmentService,
    readonly stager: ExecutionAttachmentStager,
    readonly materializations: ComposerAttachmentMaterializationPersistence,
    readonly now: () => number = Date.now,
  ) {}

  supports(scope: RequestScope, environmentId: string): boolean {
    return this.stager.supports(scope, environmentId);
  }

  resolveCanonicalEvidence(
    scope: RequestScope,
    applicationThreadId: string,
    descriptors: readonly ComposerAttachmentDescriptor[],
  ): readonly CanonicalComposerAttachmentEvidence[] {
    if (descriptors.length === 0) return Object.freeze([]);
    let resolved;
    try {
      resolved = this.attachments.resolveForDelivery(
        scope,
        applicationThreadId,
        descriptors.map(({ id }) => id),
      );
    } catch {
      throw attachmentUnavailableError();
    }
    return Object.freeze(
      resolved.map((attachment, index) => {
        const expected = descriptors[index];
        if (!expected || !sameDescriptor(attachment.descriptor, expected)) {
          throw attachmentChangedError();
        }
        return Object.freeze({
          ...attachment.descriptor,
          sha256: attachment.sha256,
        });
      }),
    );
  }

  async materialize(
    scope: RequestScope,
    applicationThreadId: string,
    lease: ExecutionEnvironmentLease,
    descriptors: readonly ComposerAttachmentDescriptor[],
    signal?: AbortSignal,
  ): Promise<MaterializedComposerAttachmentDelivery> {
    if (descriptors.length === 0) {
      return {
        attachments: [],
        canonicalBytes: this.#canonicalByteReader(
          scope,
          applicationThreadId,
          descriptors,
        ),
        canonicalEvidence: frozenEvidence([]),
      };
    }
    if (!this.supports(scope, lease.environment.id)) {
      throw new BackendError({
        category: "unavailable",
        retryable: true,
        crossedSubmissionBoundary: false,
        safeMessage:
          "File attachments are unavailable in this execution environment.",
      });
    }
    let resolved;
    try {
      resolved = this.attachments.resolveForDelivery(
        scope,
        applicationThreadId,
        descriptors.map(({ id }) => id),
      );
    } catch (error) {
      throw new BackendError({
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "A referenced attachment is no longer available.",
      });
    }
    const staged = await Promise.all(
      resolved.map(async (attachment, index) => {
        const expected = descriptors[index];
        if (!expected || !sameDescriptor(attachment.descriptor, expected)) {
          throw new BackendError({
            category: "invalid_state",
            retryable: false,
            crossedSubmissionBoundary: false,
            safeMessage: "A referenced attachment changed before delivery.",
          });
        }
        const materializationKey = {
          executionEnvironmentId: lease.environment.id,
          workspaceId: lease.workspace.summary.id,
          environmentAuthorityRevision: lease.workspace.authorityRevision,
          applicationThreadId,
          attachmentId: expected.id,
          blobSha256: attachment.sha256,
        } as const;
        try {
          const previous = this.materializations.findMaterialization(
            scope,
            materializationKey,
          );
          const materialized = await this.stager.materialize(scope, {
            lease,
            applicationThreadId,
            attachmentId: expected.id,
            sha256: attachment.sha256,
            sizeBytes: expected.byteSize,
            safeExtension: safeExtension(expected),
            content: async function* () {
              const handle = await attachment.open();
              try {
                for await (const chunk of handle.createReadStream({
                  autoClose: false,
                })) {
                  yield chunk;
                }
              } finally {
                await handle.close();
              }
            },
            ...(signal ? { signal } : {}),
          });
          if (
            materialized.sha256 !== attachment.sha256 ||
            materialized.sizeBytes !== expected.byteSize
          ) {
            throw new Error("composer_attachment_staging_evidence_mismatch");
          }
          const verifiedAt = this.now();
          if (
            previous?.state === "ready" &&
            (previous.agentPath !== materialized.agentPath ||
              previous.byteLength !== materialized.sizeBytes)
          ) {
            this.materializations.markMaterializationMissing(
              scope,
              materializationKey,
              verifiedAt,
            );
          }
          this.materializations.recordReadyMaterialization(
            scope,
            materializationKey,
            {
              agentPath: materialized.agentPath,
              byteLength: materialized.sizeBytes,
              verifiedAt,
            },
          );
          return {
            ...expected,
            sha256: attachment.sha256,
            agentPath: materialized.agentPath,
          };
        } catch (error) {
          if (error instanceof BackendError) throw error;
          throw new BackendError({
            category: "unavailable",
            retryable: true,
            crossedSubmissionBoundary: false,
            safeMessage:
              "The attachment could not be staged in the execution environment.",
          });
        }
      }),
    );
    return {
      attachments: staged,
      canonicalBytes: this.#canonicalByteReader(
        scope,
        applicationThreadId,
        descriptors,
      ),
      canonicalEvidence: frozenEvidence(
        resolved.map((attachment) => ({
          ...attachment.descriptor,
          sha256: attachment.sha256,
        })),
      ),
    };
  }

  #canonicalByteReader(
    scope: RequestScope,
    applicationThreadId: string,
    descriptors: readonly ComposerAttachmentDescriptor[],
  ): CanonicalComposerAttachmentByteReader {
    const expectedById = new Map(
      descriptors.map((descriptor) => [descriptor.id, descriptor] as const),
    );
    return {
      read: async (staged, signal) => {
        const expected = expectedById.get(staged.id);
        if (!expected || !sameStagedDescriptor(staged, expected)) {
          throw attachmentChangedError();
        }
        let resolved;
        try {
          [resolved] = this.attachments.resolveForDelivery(
            scope,
            applicationThreadId,
            [expected.id],
          );
        } catch {
          throw attachmentUnavailableError();
        }
        if (
          !resolved ||
          !sameDescriptor(resolved.descriptor, expected) ||
          resolved.sha256 !== staged.sha256
        ) {
          throw attachmentChangedError();
        }
        let handle;
        try {
          handle = await resolved.open();
          const bytes = signal
            ? await handle.readFile({ signal })
            : await handle.readFile();
          if (
            bytes.byteLength !== expected.byteSize ||
            createHash("sha256").update(bytes).digest("hex") !== staged.sha256
          ) {
            throw new Error("composer_attachment_canonical_integrity_mismatch");
          }
          return bytes;
        } catch (error) {
          if (error instanceof BackendError) throw error;
          throw new BackendError({
            category: "unavailable",
            retryable: true,
            crossedSubmissionBoundary: false,
            safeMessage: "The attachment content could not be read safely.",
          });
        } finally {
          await handle?.close().catch(() => undefined);
        }
      },
    };
  }
}

function frozenEvidence(
  evidence: readonly CanonicalComposerAttachmentEvidence[],
): CanonicalComposerAttachmentEvidenceResolver {
  const value = Object.freeze(
    evidence.map((entry) => Object.freeze({ ...entry })),
  );
  return { resolve: () => value };
}

function attachmentUnavailableError(): BackendError {
  return new BackendError({
    category: "invalid_state",
    retryable: false,
    crossedSubmissionBoundary: false,
    safeMessage: "A referenced attachment is no longer available.",
  });
}

function attachmentChangedError(): BackendError {
  return new BackendError({
    category: "invalid_state",
    retryable: false,
    crossedSubmissionBoundary: false,
    safeMessage: "A referenced attachment changed before delivery.",
  });
}

function sameStagedDescriptor(
  staged: StagedComposerAttachment,
  descriptor: ComposerAttachmentDescriptor,
): boolean {
  const { sha256: _sha256, agentPath: _agentPath, ...rawDescriptor } = staged;
  return sameDescriptor(rawDescriptor, descriptor);
}

function sameDescriptor(
  left: ComposerAttachmentDescriptor,
  right: ComposerAttachmentDescriptor,
): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.fileName === right.fileName &&
    left.mediaType === right.mediaType &&
    left.byteSize === right.byteSize
  );
}

function safeExtension(descriptor: ComposerAttachmentDescriptor): string {
  const candidate = path.extname(descriptor.fileName).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/u.test(candidate) ? candidate : "";
}
