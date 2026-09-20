import type { RequestScope } from "../identity/identity-provider.js";
import { WorkpadRepository, type WorkpadActor, type WorkpadListAuthority } from "../db/repositories/workpad-repository.js";
import type {
  CreateWorkpadRequest, UpdateWorkpadRequest, ListWorkpadsRequest,
  SaveWorkpadDraftRequest, CommitWorkpadDraftRequest,
} from "../../shared/protocol/workpads.js";

export interface WorkpadChangePublisher {
  publishWorkpadChange(scope: RequestScope, workpadId: string, revision: number, change: "document" | "draft"): Promise<void>;
}
type PendingPublication = {
  readonly scope: RequestScope;
  readonly workpadId: string;
  readonly revision: number;
  readonly change: "document" | "draft";
  readonly retryAt: number;
};

/** Principal-owned Workpads. Committed writes admit lightweight invalidations
 * to the application's serialized publication boundary. Publication failure
 * never reports an already committed mutation as failed; the scheduler retries.
 */
export class WorkpadService {
  readonly #pendingPublications = new Map<string, PendingPublication>();
  constructor(
    readonly repository: WorkpadRepository,
    readonly publications: WorkpadChangePublisher,
    readonly onRetryPending?: () => void,
  ) {}
  list(scope: RequestScope, request: ListWorkpadsRequest, authority?: WorkpadListAuthority) { return this.repository.list(scope, request, authority); }
  get(scope: RequestScope, id: string) { return this.repository.get(scope, id); }
  getAuthority(scope: RequestScope, id: string) { return this.repository.getAuthority(scope, id); }
  revisions(scope: RequestScope, id: string, options?: { limit?: number; cursor?: string }) { return this.repository.revisions(scope, id, options); }
  revision(scope: RequestScope, id: string, revision: number) { return this.repository.revision(scope, id, revision); }
  getDraft(scope: RequestScope, id: string) { return this.repository.getDraft(scope, id); }

  async create(scope: RequestScope, request: CreateWorkpadRequest, actor?: WorkpadActor, now = Date.now()) {
    const pad = this.repository.create(scope, request, actor, now);
    void this.publishWorkpadChange(scope, pad.id, pad.revision, "document", now);
    return pad;
  }
  async update(scope: RequestScope, id: string, request: UpdateWorkpadRequest, actor?: WorkpadActor, now = Date.now()) {
    const pad = this.repository.update(scope, id, request, actor, now);
    if (pad.revision !== request.expectedRevision) {
      // Document invalidation also refreshes a clean draft that followed it.
      void this.publishWorkpadChange(scope, id, pad.revision, "document", now);
    }
    return pad;
  }
  async saveDraft(scope: RequestScope, id: string, request: SaveWorkpadDraftRequest, now = Date.now()) {
    const draft = this.repository.saveDraft(scope, id, request, now);
    void this.publishWorkpadChange(scope, id, draft.revision, "draft", now);
    return draft;
  }
  async discardDraft(scope: RequestScope, id: string, expectedDraftRevision: number, now = Date.now()) {
    const draft = this.repository.discardDraft(scope, id, expectedDraftRevision, now);
    void this.publishWorkpadChange(scope, id, draft.revision, "draft", now);
    return draft;
  }
  async commitDraft(scope: RequestScope, id: string, request: CommitWorkpadDraftRequest, now = Date.now()) {
    const pad = this.repository.commitDraft(scope, id, request, now);
    const draft = this.repository.getDraft(scope, id);
    if (pad.revision !== request.expectedRevision) {
      void this.publishWorkpadChange(scope, id, pad.revision, "document", now);
    }
    void this.publishWorkpadChange(scope, id, draft.revision, "draft", now);
    return pad;
  }

  async publishWorkpadChange(
    scope: RequestScope,
    workpadId: string,
    revision: number,
    change: "document" | "draft",
    now = Date.now(),
  ): Promise<void> {
    const key = `${scope.tenantId}\0${scope.principalId}\0${workpadId}\0${change}`;
    try {
      await this.publications.publishWorkpadChange(scope, workpadId, revision, change);
      const pending = this.#pendingPublications.get(key);
      if (pending && pending.revision <= revision) this.#pendingPublications.delete(key);
    } catch {
      const pending = this.#pendingPublications.get(key);
      if (!pending || pending.revision <= revision) {
        this.#pendingPublications.set(key, { scope, workpadId, revision, change, retryAt: now + 1_000 });
      }
      try { this.onRetryPending?.(); } catch { /* Retained retry stays authoritative. */ }
    }
  }
  getNearestDeadline(): number | null {
    let deadline: number | null = null;
    for (const { retryAt } of this.#pendingPublications.values()) {
      if (deadline === null || retryAt < deadline) deadline = retryAt;
    }
    return deadline;
  }
  async reconcileDue(now = Date.now()): Promise<void> {
    for (const pending of [...this.#pendingPublications.values()]) {
      if (pending.retryAt > now) continue;
      await this.publishWorkpadChange(pending.scope, pending.workpadId, pending.revision, pending.change, now);
    }
  }
}
