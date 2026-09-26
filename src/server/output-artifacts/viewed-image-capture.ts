import type { ConversationBinding } from "../backends/contracts.js";
import { normalizedAbsolutePath } from "../../shared/absolute-path.js";
import { WORKSPACE_FILE_MAX_PATH_BYTES } from "../../shared/workspace-file-limits.js";
import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { WorkspaceFileService } from "../domain/workspace-file-service.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { MAXIMUM_OUTPUT_IMAGE_BYTES, type OutputImageArtifactDescriptor } from "./contracts.js";
import type { OutputArtifactService } from "./service.js";

const MAXIMUM_ACTIVE_CAPTURES = 2;
const MAXIMUM_QUEUED_CAPTURES = 32;
const CAPTURE_DEADLINE_MILLISECONDS = 10_000;

export type ViewedImageCaptureInput = Readonly<{
  scope: RequestScope;
  binding: ConversationBinding;
  publicationKey: string;
  absolutePath: string;
  signal?: AbortSignal;
}>;

/** Native paths stay behind this thread-scoped, backend-neutral boundary. */
export interface ViewedImageCapture {
  capture(input: ViewedImageCaptureInput): Promise<OutputImageArtifactDescriptor | undefined>;
}

type CaptureJob = {
  readonly key: string;
  readonly threadKey: string;
  readonly input: ViewedImageCaptureInput;
  readonly controller: AbortController;
  readonly assertCurrent: () => void;
  readonly subscribers: Set<(result: OutputImageArtifactDescriptor | undefined) => void>;
  readonly timer: ReturnType<typeof setTimeout>;
  running: boolean;
};

/** One application-owned scheduler; active accounting includes publication and cleanup. */
export class ViewedImageCaptureService implements ViewedImageCapture {
  readonly #jobs = new Map<string, CaptureJob>();
  readonly #generations = new Map<string, number>();
  readonly #activeThreads = new Set<string>();
  readonly #drained = new Set<() => void>();
  #active = 0;
  #closed = false;

  constructor(readonly dependencies: {
    artifacts: Pick<OutputArtifactService, "findImage" | "publishCapturedImage">;
    files: Pick<WorkspaceFileService, "readAbsoluteImage">;
    bindings: Pick<ConversationBindingRepository, "getBinding">;
    inventory: Pick<InventoryRepository, "getThread" | "getWorkspace" | "getEnvironment">;
  }) {}

  async capture(input: ViewedImageCaptureInput): Promise<OutputImageArtifactDescriptor | undefined> {
    if (this.#closed || input.signal?.aborted) return undefined;
    input = { ...input, scope: { ...input.scope }, binding: { ...input.binding } };
    try {
      this.#assertBinding(input);
      const retained = this.dependencies.artifacts.findImage(input.scope,
        input.binding.applicationThreadId, input.publicationKey);
      if (retained) return retained;
      if (Buffer.byteLength(input.absolutePath, "utf8") > WORKSPACE_FILE_MAX_PATH_BYTES ||
          !normalizedAbsolutePath(input.absolutePath)) return undefined;
      const threadKey = JSON.stringify([input.scope.tenantId, input.scope.principalId,
        input.binding.applicationThreadId]);
      const key = JSON.stringify([threadKey, input.binding.backendInstanceId,
        input.binding.connectionProfileId, input.binding.executionEnvironmentId,
        input.binding.backendConversationId, input.binding.createdAt, input.publicationKey]);
      let job = this.#jobs.get(key);
      if (!job) {
        if ([...this.#jobs.values()].filter(candidate => !candidate.running).length >= MAXIMUM_QUEUED_CAPTURES) return undefined;
        const controller = new AbortController();
        const assertCurrent = this.#captureAuthority(input, controller.signal);
        const created: CaptureJob = { key, threadKey, input, controller, assertCurrent, subscribers: new Set(),
          timer: setTimeout(() => this.#cancel(created), CAPTURE_DEADLINE_MILLISECONDS), running: false };
        created.timer.unref?.();
        this.#jobs.set(key, created);
        job = created;
      }
      const joined = this.#subscribe(job, input.signal);
      this.#pump();
      return await joined;
    } catch {
      // A capture is optional enrichment. Never leak native paths or prevent history reads.
      return undefined;
    }
  }

  /** Fences every job admitted before this call; later captures carry the new generation. */
  cancelThread(scope: RequestScope, threadId: string): void {
    this.#fence(scope, "thread", threadId, job => job.input.binding.applicationThreadId === threadId);
  }

  cancelEnvironment(scope: RequestScope, environmentId: string): void {
    this.#fence(scope, "environment", environmentId, job => job.input.binding.executionEnvironmentId === environmentId);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const job of [...this.#jobs.values()]) this.#cancel(job);
    if (this.#active > 0) await new Promise<void>(resolve => this.#drained.add(resolve));
  }

  #generationKey(scope: RequestScope, kind: "thread" | "environment", id: string): string {
    return JSON.stringify([kind, scope.tenantId, scope.principalId, id]);
  }

  #fence(scope: RequestScope, kind: "thread" | "environment", id: string, matches: (job: CaptureJob) => boolean): void {
    if (this.#active === 0 && this.#jobs.size === 0) return;
    const key = this.#generationKey(scope, kind, id);
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    for (const job of [...this.#jobs.values()]) {
      if (job.input.scope.tenantId === scope.tenantId &&
          job.input.scope.principalId === scope.principalId && matches(job)) this.#cancel(job);
    }
  }

  #assertBinding(input: ViewedImageCaptureInput): void {
    const { scope, binding } = input;
    const current = this.dependencies.bindings.getBinding(scope, binding.applicationThreadId);
    if (binding.tenantId !== scope.tenantId || binding.ownerPrincipalId !== scope.principalId ||
        !current || current.backendInstanceId !== binding.backendInstanceId ||
        current.connectionProfileId !== binding.connectionProfileId ||
        current.executionEnvironmentId !== binding.executionEnvironmentId ||
        current.backendConversationId !== binding.backendConversationId ||
        new Date(current.createdAt).toISOString() !== binding.createdAt) {
      throw new Error("viewed_image_binding_retired");
    }
  }

  #captureAuthority(input: ViewedImageCaptureInput, signal: AbortSignal): () => void {
    const { scope, binding } = input;
    const workspaceId = this.dependencies.inventory.getThread(scope, binding.applicationThreadId).thread.workspaceId;
    const workspace = this.dependencies.inventory.getWorkspace(scope, workspaceId);
    const environment = this.dependencies.inventory.getEnvironment(scope, binding.executionEnvironmentId);
    const canonicalPath = workspace.canonicalPath;
    const configurationRevision = environment.configurationRevision;
    const operationsConfigurationRevision = environment.operationsConfigurationRevision;
    const fences = [this.#generationKey(scope, "thread", binding.applicationThreadId),
      this.#generationKey(scope, "environment", binding.executionEnvironmentId)];
    const generations = fences.map(fence => this.#generations.get(fence) ?? 0);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (fences.some((fence, index) => (this.#generations.get(fence) ?? 0) !== generations[index])) {
        throw new Error("viewed_image_capture_cancelled");
      }
      this.#assertBinding(input);
      const thread = this.dependencies.inventory.getThread(scope, binding.applicationThreadId);
      const currentWorkspace = this.dependencies.inventory.getWorkspace(scope, workspaceId);
      const currentEnvironment = this.dependencies.inventory.getEnvironment(scope, binding.executionEnvironmentId);
      if (thread.thread.workspaceId !== workspaceId ||
          currentWorkspace.environmentId !== binding.executionEnvironmentId ||
          currentWorkspace.canonicalPath !== canonicalPath ||
          currentWorkspace.availability !== "available" ||
          currentEnvironment.availability !== "available" ||
          currentEnvironment.configurationRevision !== configurationRevision ||
          currentEnvironment.operationsConfigurationRevision !== operationsConfigurationRevision) {
        throw new Error("viewed_image_authority_changed");
      }
    };
    assertCurrent();
    return assertCurrent;
  }

  #subscribe(job: CaptureJob, signal?: AbortSignal): Promise<OutputImageArtifactDescriptor | undefined> {
    return new Promise(resolve => {
      const finish = (result: OutputImageArtifactDescriptor | undefined) => {
        signal?.removeEventListener("abort", abort);
        job.subscribers.delete(finish);
        resolve(result);
      };
      const abort = () => {
        finish(undefined);
        if (job.subscribers.size === 0) this.#cancel(job);
      };
      job.subscribers.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  /** A running job leaves the map at once; its active slots remain until #run settles. */
  #cancel(job: CaptureJob): void {
    if (this.#jobs.get(job.key) !== job) return;
    this.#jobs.delete(job.key);
    clearTimeout(job.timer);
    job.controller.abort(new Error("viewed_image_capture_cancelled"));
    for (const finish of [...job.subscribers]) finish(undefined);
    this.#pump();
    this.#settleIdle();
  }

  #settleIdle(): void {
    if (this.#active > 0) return;
    if (this.#jobs.size === 0) this.#generations.clear();
    for (const resolve of this.#drained) resolve();
    this.#drained.clear();
  }

  #pump(): void {
    if (this.#closed) return;
    for (const job of this.#jobs.values()) {
      if (this.#active >= MAXIMUM_ACTIVE_CAPTURES) break;
      if (job.running || this.#activeThreads.has(job.threadKey)) continue;
      job.running = true;
      this.#active += 1;
      this.#activeThreads.add(job.threadKey);
      void this.#run(job);
    }
  }

  async #run(job: CaptureJob): Promise<void> {
    let result: OutputImageArtifactDescriptor | undefined;
    try {
      job.assertCurrent();
      const { input } = job;
      // Another completed observation may have published while this job was queued.
      result = this.dependencies.artifacts.findImage(input.scope, input.binding.applicationThreadId, input.publicationKey);
      if (!result) {
        const image = await this.dependencies.files.readAbsoluteImage(input.scope,
          input.binding.applicationThreadId, input.absolutePath, job.controller.signal);
        job.assertCurrent();
        if (image && image.sizeBytes > 0 && image.sizeBytes <= MAXIMUM_OUTPUT_IMAGE_BYTES &&
            image.content.length <= 4 * Math.ceil(MAXIMUM_OUTPUT_IMAGE_BYTES / 3)) {
          const bytes = Buffer.from(image.content, "base64");
          if (bytes.byteLength !== image.sizeBytes || bytes.toString("base64") !== image.content) {
            throw new Error("viewed_image_content_invalid");
          }
          result = await this.dependencies.artifacts.publishCapturedImage({ scope: input.scope,
            threadId: input.binding.applicationThreadId, publicationKey: input.publicationKey,
            mediaType: image.mediaType, bytes, expectedByteSize: image.sizeBytes }, job.assertCurrent);
        }
      }
    } catch {
      result = undefined;
    } finally {
      clearTimeout(job.timer);
      if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
      this.#active -= 1;
      this.#activeThreads.delete(job.threadKey);
      for (const finish of [...job.subscribers]) finish(result);
      this.#pump();
      this.#settleIdle();
    }
  }
}
