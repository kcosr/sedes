import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { RequestScope } from "../identity/identity-provider.js";
import { deriveComposerAttachmentScopeKey } from "../security/installation-secret.js";
import {
  ExecutionAttachmentStagingEngine,
  type ExecutionAttachmentStagingIdentity,
} from "./execution-attachment-staging-engine.js";
import {
  ExecutionAttachmentStagingUnavailableError,
  assertStagingLease,
  sameRequestScope,
  type ExecutionAttachmentMaterializationRequest,
  type ExecutionAttachmentReleaseRequest,
  type ExecutionAttachmentStager,
} from "./execution-attachment-stager.js";

export class LocalExecutionAttachmentStager implements ExecutionAttachmentStager {
  readonly #scope: RequestScope;
  readonly #environmentId: string;
  readonly #scopeKey: string;
  readonly #engine: ExecutionAttachmentStagingEngine;
  #closed = false;

  constructor(input: {
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly stateDirectory: string;
    readonly installationKey: Uint8Array;
  }) {
    if (!input.environmentId || !path.isAbsolute(input.stateDirectory)) {
      throw new Error("local_attachment_stager_configuration_invalid");
    }
    this.#scope = Object.freeze({ ...input.scope });
    this.#environmentId = input.environmentId;
    this.#scopeKey = deriveComposerAttachmentScopeKey(
      input.installationKey,
      input.scope,
    );
    this.#engine = new ExecutionAttachmentStagingEngine({
      baseDirectory: path.join(input.stateDirectory, "execution-attachments"),
      sessionNonce: randomBytes(32).toString("base64url"),
    });
  }

  supports(scope: RequestScope, environmentId: string): boolean {
    return (
      !this.#closed &&
      sameRequestScope(scope, this.#scope) &&
      environmentId === this.#environmentId
    );
  }

  async materialize(
    scope: RequestScope,
    request: ExecutionAttachmentMaterializationRequest,
  ) {
    this.#assert(scope, request.lease);
    throwIfAborted(request.signal);
    const identity = this.#identity(request);
    const admissionId = randomUUID();
    const opened = await this.#engine.open(admissionId, identity);
    if (opened.state === "ready") return withoutState(opened);
    let offset = 0;
    try {
      for await (const source of request.content()) {
        throwIfAborted(request.signal);
        let chunk = source;
        while (chunk.byteLength > 0) {
          const piece = chunk.subarray(0, 256 * 1_024);
          const appended = await this.#engine.append({
            uploadHandle: opened.uploadHandle,
            offset,
            content: piece,
            chunkSha256: createHash("sha256").update(piece).digest("hex"),
          });
          offset = appended.nextOffset;
          chunk = chunk.subarray(piece.byteLength);
        }
      }
      throwIfAborted(request.signal);
      return await this.#engine.commit(opened.uploadHandle);
    } catch (error) {
      await this.#engine.abort(opened.uploadHandle).catch(() => undefined);
      throw error;
    }
  }

  async release(
    scope: RequestScope,
    request: ExecutionAttachmentReleaseRequest,
  ): Promise<void> {
    this.#assert(scope, request.lease);
    throwIfAborted(request.signal);
    await this.#engine.release({
      scopeKey: this.#scopeKey,
      threadId: request.applicationThreadId,
      attachmentId: request.attachmentId,
      sha256: request.expectedSha256,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#engine.close();
  }

  #identity(
    request: ExecutionAttachmentMaterializationRequest,
  ): ExecutionAttachmentStagingIdentity {
    return {
      scopeKey: this.#scopeKey,
      threadId: request.applicationThreadId,
      attachmentId: request.attachmentId,
      sha256: request.sha256,
      sizeBytes: request.sizeBytes,
      extension: request.safeExtension,
    };
  }

  #assert(
    scope: RequestScope,
    lease: ExecutionAttachmentMaterializationRequest["lease"],
  ): void {
    if (!this.supports(scope, this.#environmentId)) {
      throw new ExecutionAttachmentStagingUnavailableError();
    }
    assertStagingLease(scope, this.#environmentId, lease);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
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
