import { createHash } from "node:crypto";
import type { ApplicationPublicationAnchor } from "../../shared/protocol/application-publications.js";
import { imageShowRequestSchema, type ImageShowRequest, type ImageShowResult } from "../../shared/protocol/image-show.js";
import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import { ImageShowRepository, type ImageShowReceipt, type ShownImage } from "../db/repositories/image-show-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import { DomainError } from "../domain/errors.js";
import type { WorkspaceFileService } from "../domain/workspace-file-service.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { inspectSupportedRasterImage } from "../images/raster-image-inspector.js";
import { MAXIMUM_OUTPUT_IMAGE_BYTES, type OutputImageArtifactDescriptor } from "./contracts.js";
import { displayFileName } from "./display-file-name.js";
import { ImageShowError } from "./image-show-error.js";
import type { OutputArtifactService } from "./service.js";

export interface ImageShowPublicationAuthority {
  readonly invocationId: string;
  /** Captured only for a new publication; retained retries need no active turn. */
  readonly capture: () => { readonly anchor: ApplicationPublicationAnchor; readonly assertCurrent: () => void };
}
type Job = {
  readonly key: string; readonly threadKey: string; readonly scope: RequestScope; readonly threadId: string;
  readonly input: ImageShowRequest; readonly inputSha256: string; readonly bindingSha256: string;
  readonly authority: ImageShowPublicationAuthority; readonly publication: ReturnType<ImageShowPublicationAuthority["capture"]>;
  readonly assertCurrent: () => void; readonly controller: AbortController;
  readonly subscribers: Set<{ resolve: (result: ImageShowResult) => void; reject: (error: unknown) => void }>;
  readonly timer: ReturnType<typeof setTimeout>; running: boolean;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Retained image snapshots owned by the authenticated source thread, outside the Pages catalog. */
export class ImageShowService {
  readonly #jobs = new Map<string, Job>();
  readonly #activeThreads = new Set<string>();
  readonly #drained = new Set<() => void>();
  #active = 0;
  #closed = false;
  constructor(readonly dependencies: {
    repository: ImageShowRepository;
    artifacts: Pick<OutputArtifactService, "publishCapturedImage">;
    files: Pick<WorkspaceFileService, "readAbsoluteFile">;
    inventory: Pick<InventoryRepository, "getThread" | "getWorkspace" | "getEnvironment">;
    bindings: Pick<ConversationBindingRepository, "getBinding">;
    onShown?: (scope: RequestScope, threadId: string) => void | Promise<void>;
  }) {}

  async show(scope: RequestScope, threadId: string, raw: ImageShowRequest, authority: ImageShowPublicationAuthority,
    signal?: AbortSignal): Promise<ImageShowResult> {
    if (this.#closed || signal?.aborted) throw new ImageShowError("cancelled");
    const input = imageShowRequestSchema.parse(raw);
    if (!authority.invocationId || authority.invocationId.length > 256) throw new ImageShowError("request_conflict");
    const inputSha256 = digest([input.path, input.title ?? null]);
    const bindingSha256 = this.#binding(scope, threadId);
    const existing = this.dependencies.repository.find(scope, threadId, authority.invocationId);
    if (existing) return this.#existing(existing, inputSha256, bindingSha256);
    const threadKey = JSON.stringify([scope.tenantId, scope.principalId, threadId]);
    const key = JSON.stringify([threadKey, authority.invocationId]);
    let job = this.#jobs.get(key);
    if (job && (job.inputSha256 !== inputSha256 || job.bindingSha256 !== bindingSha256)) throw new ImageShowError("request_conflict");
    if (!job) {
      if ([...this.#jobs.values()].filter(candidate => !candidate.running).length >= 32) throw new ImageShowError("busy");
      const controller = new AbortController();
      let publication: ReturnType<ImageShowPublicationAuthority["capture"]>;
      try { publication = authority.capture(); } catch { throw new ImageShowError("inactive_turn"); }
      const assertFilesCurrent = this.#captureFiles(scope, threadId);
      const assertCurrent = () => {
        if (this.#closed || controller.signal.aborted) throw new ImageShowError("cancelled");
        if (this.#binding(scope, threadId) !== bindingSha256) throw new ImageShowError("changed");
        assertFilesCurrent();
        try { publication.assertCurrent(); } catch (error) {
          if (error instanceof DomainError && error.code === "runtime_unavailable") throw new ImageShowError("inactive_turn");
          throw error;
        }
      };
      assertCurrent();
      const created: Job = { key, threadKey, scope: { ...scope }, threadId, input, inputSha256, bindingSha256,
        authority, publication, assertCurrent, controller, subscribers: new Set(), running: false,
        timer: setTimeout(() => this.#cancel(created), 15_000) };
      created.timer.unref?.();
      this.#jobs.set(key, created); job = created;
    }
    const pending = this.#subscribe(job, signal);
    this.#pump();
    return pending;
  }

  #existing(receipt: ImageShowReceipt, inputSha256: string, bindingSha256: string): ImageShowResult {
    if (receipt.inputSha256 !== inputSha256 || receipt.bindingSha256 !== bindingSha256) throw new ImageShowError("request_conflict");
    return { image: receipt.image };
  }

  #binding(scope: RequestScope, threadId: string): string {
    const binding = this.dependencies.bindings.getBinding(scope, threadId);
    if (!binding || binding.tenantId !== scope.tenantId || binding.ownerPrincipalId !== scope.principalId) throw new ImageShowError("unavailable");
    return digest([binding.tenantId, binding.ownerPrincipalId, binding.applicationThreadId, binding.backendInstanceId,
      binding.connectionProfileId, binding.executionEnvironmentId, binding.backendConversationId, binding.createdAt]);
  }

  #captureFiles(scope: RequestScope, threadId: string): () => void {
    const workspaceId = this.dependencies.inventory.getThread(scope, threadId).thread.workspaceId;
    const workspace = this.dependencies.inventory.getWorkspace(scope, workspaceId);
    const environment = this.dependencies.inventory.getEnvironment(scope, workspace.environmentId);
    const check = () => {
      const currentThread = this.dependencies.inventory.getThread(scope, threadId);
      const currentWorkspace = this.dependencies.inventory.getWorkspace(scope, workspaceId);
      const currentEnvironment = this.dependencies.inventory.getEnvironment(scope, workspace.environmentId);
      if (currentThread.thread.workspaceId !== workspaceId || currentWorkspace.canonicalPath !== workspace.canonicalPath ||
        currentWorkspace.environmentId !== workspace.environmentId || currentWorkspace.availability !== "available" ||
        currentEnvironment.availability !== "available" || currentEnvironment.configurationRevision !== environment.configurationRevision ||
        currentEnvironment.operationsConfigurationRevision !== environment.operationsConfigurationRevision) throw new ImageShowError("changed");
    };
    check(); return check;
  }

  #subscribe(job: Job, signal?: AbortSignal): Promise<ImageShowResult> {
    return new Promise((resolve, reject) => {
      const subscriber = { resolve: (result: ImageShowResult) => { cleanup(); resolve(result); }, reject: (error: unknown) => { cleanup(); reject(error); } };
      const cleanup = () => { signal?.removeEventListener("abort", abort); job.subscribers.delete(subscriber); };
      const abort = () => { subscriber.reject(new ImageShowError("cancelled")); if (!job.subscribers.size) this.#cancel(job); };
      job.subscribers.add(subscriber); signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  #cancel(job: Job): void {
    job.controller.abort();
    for (const subscriber of [...job.subscribers]) subscriber.reject(new ImageShowError("cancelled"));
    if (!job.running) { clearTimeout(job.timer); this.#jobs.delete(job.key); this.#pump(); }
  }

  #pump(): void {
    if (this.#closed) return;
    for (const job of this.#jobs.values()) {
      if (this.#active >= 2) break;
      if (job.running || this.#activeThreads.has(job.threadKey)) continue;
      job.running = true; this.#active++; this.#activeThreads.add(job.threadKey);
      void this.#run(job);
    }
  }

  async #run(job: Job): Promise<void> {
    try {
      job.assertCurrent();
      const bytes = await this.dependencies.files.readAbsoluteFile(job.scope, job.threadId, job.input.path,
        MAXIMUM_OUTPUT_IMAGE_BYTES, job.controller.signal);
      job.assertCurrent();
      if (!bytes.byteLength || bytes.byteLength > MAXIMUM_OUTPUT_IMAGE_BYTES) throw new ImageShowError("size");
      const inspection = inspectSupportedRasterImage(bytes);
      if (!inspection) {
        const signature = Buffer.from(bytes.subarray(0, 12));
        const looksSupported = signature.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])) ||
          signature.subarray(0, 3).toString() === "GIF" || signature.subarray(0, 2).equals(Buffer.from([255, 216])) ||
          signature.subarray(0, 4).toString() === "RIFF";
        throw new ImageShowError(looksSupported ? "invalid" : "unsupported");
      }
      let result: ImageShowResult | undefined;
      try {
        await this.dependencies.artifacts.publishCapturedImage({ scope: job.scope, threadId: job.threadId,
        publicationKey: `shown:${job.authority.invocationId}`, mediaType: inspection.mediaType, bytes }, job.assertCurrent,
      (artifact: OutputImageArtifactDescriptor) => {
        const image: ShownImage = { representation: "artifact", artifactId: artifact.artifactId, mimeType: artifact.mediaType,
          byteSize: artifact.byteSize, sha256: artifact.sha256, ...(displayFileName(job.input.path) ? { fileName: displayFileName(job.input.path)! } : {}),
          ...(job.input.title ? { alt: { text: job.input.title } } : {}) };
        result = { image: this.dependencies.repository.record(job.scope, job.threadId, {
          invocationId: job.authority.invocationId, inputSha256: job.inputSha256, bindingSha256: job.bindingSha256,
          image, anchor: job.publication.anchor, assertCurrent: job.assertCurrent }).image };
        });
      } catch (error) {
        if (error instanceof ImageShowError) throw error;
        if (error instanceof DomainError && (error.code === "conflict" || error.code === "invalid_transition")) throw new ImageShowError("changed");
        throw new ImageShowError("retention_failed");
      }
      if (!result) {
        const retained = this.dependencies.repository.find(job.scope, job.threadId, job.authority.invocationId);
        if (!retained) throw new ImageShowError("unavailable");
        result = this.#existing(retained, job.inputSha256, job.bindingSha256);
      }
      void Promise.resolve().then(() => this.dependencies.onShown?.(job.scope, job.threadId)).catch(() => undefined);
      for (const subscriber of [...job.subscribers]) subscriber.resolve(result);
    } catch (error) {
      const safe = this.#error(error, job.controller.signal);
      for (const subscriber of [...job.subscribers]) subscriber.reject(safe);
    } finally {
      clearTimeout(job.timer); this.#jobs.delete(job.key); this.#active--; this.#activeThreads.delete(job.threadKey); this.#pump();
      if (!this.#active) { for (const resolve of this.#drained) resolve(); this.#drained.clear(); }
    }
  }

  #error(error: unknown, signal: AbortSignal): ImageShowError {
    if (error instanceof ImageShowError) return error;
    if (signal.aborted) return new ImageShowError("cancelled");
    if (error instanceof DomainError) {
      if (error.code === "conflict" || error.code === "invalid_transition") return new ImageShowError("changed");
      if (error.code === "bad_request" && error.message.includes("capture limit")) return new ImageShowError("size");
    }
    return new ImageShowError("unavailable");
  }

  cancelThread(scope: RequestScope, threadId: string): void {
    for (const job of this.#jobs.values()) {
      if (job.scope.tenantId === scope.tenantId && job.scope.principalId === scope.principalId && job.threadId === threadId) this.#cancel(job);
    }
  }

  cancelEnvironment(scope: RequestScope, environmentId: string): void {
    for (const job of this.#jobs.values()) {
      if (job.scope.tenantId !== scope.tenantId || job.scope.principalId !== scope.principalId) continue;
      const binding = this.dependencies.bindings.getBinding(scope, job.threadId);
      if (!binding || binding.executionEnvironmentId === environmentId) this.#cancel(job);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs.values()) this.#cancel(job);
    if (this.#active) await new Promise<void>(resolve => this.#drained.add(resolve));
  }
}
