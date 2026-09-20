import {
  SidecarOperationError,
  type ComposerAttachmentsV1Handlers,
} from "../../internal/sidecar-protocol/index.js";
import {
  ExecutionAttachmentStagingEngine,
  ExecutionAttachmentStagingError,
} from "../composer-attachments/execution-attachment-staging-engine.js";

export class ComposerAttachmentsSidecarHost {
  readonly handlers: ComposerAttachmentsV1Handlers;
  readonly #engine: ExecutionAttachmentStagingEngine;
  readonly #uploads = new Map<string, string>();
  readonly #pending = new Set<Promise<void>>();
  #inflight = 0;
  #revision = 0;

  constructor(input: {
    readonly baseDirectory: string;
    readonly sessionNonce: string;
    readonly captureAdmission?: () => () => void;
  }) {
    this.#engine = new ExecutionAttachmentStagingEngine(input);
    this.handlers = {
      open: (request) =>
        this.#guard(async () => {
          const result = await this.#engine.open(request.admissionId, {
            scopeKey: request.scopeKey,
            threadId: request.threadId,
            attachmentId: request.attachmentId,
            sha256: request.sha256,
            sizeBytes: request.sizeBytes,
            extension: request.extension,
          });
          if (result.state === "upload")
            this.#uploads.set(request.admissionId, result.uploadHandle);
          else this.#uploads.delete(request.admissionId);
          return result;
        }),
      append: (request) =>
        this.#guard(async () => {
          const content = Buffer.from(request.contentBase64, "base64");
          if (content.byteLength !== request.decodedBytes) {
            throw new ExecutionAttachmentStagingError(
              "composer_attachment_upload_invalid",
            );
          }
          return await this.#engine.append({
            uploadHandle: request.uploadHandle,
            offset: request.offset,
            content,
            chunkSha256: request.chunkSha256,
          });
        }),
      commit: ({ uploadHandle }) =>
        this.#guard(async () => {
          const result = await this.#engine.commit(uploadHandle);
          this.#forgetUpload(uploadHandle);
          return result;
        }),
      abort: ({ uploadHandle }) =>
        this.#guard(async () => {
          const result = await this.#engine.abort(uploadHandle);
          this.#forgetUpload(uploadHandle);
          return result;
        }),
      release: (request) =>
        this.#guard(() =>
          this.#engine.release({
            scopeKey: request.scopeKey,
            threadId: request.threadId,
            attachmentId: request.attachmentId,
            sha256: request.expectedSha256,
          }),
        ),
    };
  }

  #forgetUpload(uploadHandle: string): void {
    for (const [admissionId, handle] of this.#uploads) {
      if (handle === uploadHandle) this.#uploads.delete(admissionId);
    }
  }

  close(): Promise<void> {
    return this.#engine.close();
  }

  snapshot(): {
    revision: string;
    state: "idle" | "active";
    blockers: "transfer_in_progress"[];
  } {
    const active = this.#inflight > 0 || this.#uploads.size > 0;
    return {
      revision: String(this.#revision),
      state: active ? "active" : "idle",
      blockers: active ? ["transfer_in_progress"] : [],
    };
  }

  async stop(): Promise<void> {
    await Promise.all([...this.#pending]);
    await this.close();
    this.#uploads.clear();
    this.#revision += 1;
  }

  async #guard<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#inflight += 1;
    this.#revision += 1;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#pending.add(done);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ExecutionAttachmentStagingError) {
        throw new SidecarOperationError(error.code);
      }
      throw error;
    } finally {
      this.#inflight -= 1;
      this.#revision += 1;
      this.#pending.delete(done);
      finish();
    }
  }
}
