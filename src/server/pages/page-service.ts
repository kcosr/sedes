import { pageSourceSchema, publishPageRequestSchema, type PageRevision, type PageSource, type PublishPageRequest } from "../../shared/protocol/pages.js";
import { type ApplicationPublicationAnchor } from "../../shared/protocol/application-publications.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import { PageRepository, type PageReadOptions } from "../db/repositories/page-repository.js";
import { DomainError } from "../domain/errors.js";
import type { WorkspaceFileService } from "../domain/workspace-file-service.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { importHtmlPage, importInlineHtmlPage } from "./html-import.js";

export type PagePublicationAuthority = { readonly invocationId: string; readonly anchor?: ApplicationPublicationAnchor; readonly assertCurrent?: () => void; };

/** Principal-owned thread pages. Import is bounded, cancellable, and fenced before commit. */
export class PageService {
  #activeImports = 0;
  constructor(readonly dependencies: {
    repository: PageRepository;
    files: Pick<WorkspaceFileService, "readAbsoluteFile">;
    inventory: Pick<InventoryRepository, "getThread" | "getWorkspace" | "getEnvironment" | "workspaceAuthorityIsCurrent">;
    onPublished?: (scope: RequestScope, page: PageRevision) => void | Promise<void>;
  }) {}
  get repository() { return this.dependencies.repository; }
  get(scope: RequestScope, threadId: string, pageId: string, revision?: number) { return this.repository.get(scope, threadId, pageId, revision); }
  content(scope: RequestScope, threadId: string, pageId: string, revision: number) { return this.repository.content(scope, threadId, pageId, revision); }
  source(scope: RequestScope, threadId: string, pageId: string, revision?: number) { return this.repository.source(scope, threadId, pageId, revision); }
  list(scope: RequestScope, threadId: string, options?: PageReadOptions) { return this.repository.list(scope, threadId, options); }
  revisions(scope: RequestScope, threadId: string, pageId: string, options?: PageReadOptions) { return this.repository.revisions(scope, threadId, pageId, options); }

  async prepare(scope: RequestScope, threadId: string, source: PageSource, signal?: AbortSignal) {
    const assertCurrent = this.#captureAuthority(scope, threadId);
    const grants = new Set<() => void>();
    const prepared = await this.#prepare(scope, threadId, pageSourceSchema.parse(source), assertCurrent, grants, signal);
    assertCurrent();
    for (const check of grants) check();
    return prepared;
  }

  async publish(scope: RequestScope, threadId: string, input: PublishPageRequest, authority: PagePublicationAuthority, signal?: AbortSignal) {
    input = publishPageRequestSchema.parse(input);
    const assertFilesCurrent = this.#captureAuthority(scope, threadId);
    const capturedGrants = new Set<() => void>();
    const assertCurrent = () => {
      assertFilesCurrent();
      for (const check of capturedGrants) check();
      authority.assertCurrent?.();
    };
    assertCurrent();
    const prepared = await this.#prepare(scope, threadId, input, assertCurrent, capturedGrants, signal);
    assertCurrent();
    const result = this.repository.publish(scope, threadId, { ...input, viewport: input.viewport ?? {}, prepared, ...authority, assertCurrent });
    if (result.changed) {
      // Observe refresh failure without waiting on an actor mailbox after commit.
      // Reattach always reads the authoritative durable publication rows again.
      void Promise.resolve().then(() => this.dependencies.onPublished?.(scope, result.page)).catch(() => undefined);
    }
    return result;
  }

  async #prepare(scope: RequestScope, threadId: string, source: PageSource, assertCurrent: () => void, capturedGrants: Set<() => void>, signal?: AbortSignal) {
    if (this.#activeImports >= 4) throw new DomainError("runtime_unavailable", "Page import is busy. Retry after the current imports finish.", true);
    this.#activeImports += 1;
    const deadline = AbortSignal.timeout(15_000);
    const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      if (source.html !== undefined) return await importInlineHtmlPage(source.html, operationSignal);
      return await importHtmlPage({ read: async (path, maximumBytes) => {
        operationSignal.throwIfAborted();
        assertCurrent();
        const bytes = await this.dependencies.files.readAbsoluteFile(scope, threadId, path, maximumBytes, operationSignal, check => capturedGrants.add(check));
        operationSignal.throwIfAborted();
        assertCurrent();
        for (const check of capturedGrants) check();
        return bytes;
      } }, source.path!, operationSignal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (deadline.aborted) throw new DomainError("runtime_unavailable", "HTML capture timed out. Retry the preview or publication.", true);
      if (error instanceof Error && error.message === "page_source_root_retired") {
        throw new DomainError("runtime_unavailable", "The source Files root changed during HTML capture. Retry against the current workspace.", true);
      }
      throw error;
    } finally { this.#activeImports -= 1; }
  }

  #captureAuthority(scope: RequestScope, threadId: string): () => void {
    const initialThread = this.dependencies.inventory.getThread(scope, threadId);
    const workspaceId = initialThread.thread.workspaceId;
    const workspace = this.dependencies.inventory.getWorkspace(scope, workspaceId);
    const assertCurrent = () => {
      const currentThread = this.dependencies.inventory.getThread(scope, threadId);
      const currentWorkspace = this.dependencies.inventory.getWorkspace(scope, workspaceId);
      const currentEnvironment = this.dependencies.inventory.getEnvironment(scope, workspace.environmentId);
      if (currentThread.thread.workspaceId !== workspaceId || currentWorkspace.canonicalPath !== workspace.canonicalPath ||
        currentWorkspace.environmentId !== workspace.environmentId || currentWorkspace.availability !== "available" || currentEnvironment.availability !== "available" ||
        !this.dependencies.inventory.workspaceAuthorityIsCurrent(scope, currentWorkspace) ||
          currentWorkspace.authorityRootId !== workspace.authorityRootId || currentWorkspace.environmentConfigurationRevision !== workspace.environmentConfigurationRevision) {
        throw new DomainError("conflict", "The page source environment changed. Retry against the current thread environment.");
      }
    };
    assertCurrent();
    return assertCurrent;
  }
}
