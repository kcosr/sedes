import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { diffChars, diffLines, diffWordsWithSpace } from "diff";
import {
  createWorkpadRequestSchema, updateWorkpadRequestSchema, listWorkpadsRequestSchema,
  saveWorkpadDraftRequestSchema, commitWorkpadDraftRequestSchema, workpadSchema, workpadSummarySchema, workpadRevisionSummarySchema,
  workpadRevisionSchema, workpadDraftSchema, workpadScopeSchema,
  type Workpad, type WorkpadScope, type WorkpadAuthor, type WorkpadAttributionSpan,
  type WorkpadChange, type WorkpadRevision, type WorkpadRevisionPage,
  type CreateWorkpadRequest, type UpdateWorkpadRequest, type ListWorkpadsRequest,
  type WorkpadListPage, type WorkpadDraft, type SaveWorkpadDraftRequest,
  type CommitWorkpadDraftRequest,
} from "../../../shared/protocol/workpads.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export type WorkpadActor = { kind: "user" } | { kind: "agent"; threadId: string } | { kind: "tool_client"; clientId: string };
export type WorkpadListAuthority = {
  readonly environmentIds?: readonly string[];
  readonly continuationKey: string;
};
export type WorkpadAuthority = { scope: WorkpadScope; environmentId: string | null; revision: number };
const notFound = () => new DomainError("not_found", "The workpad was not found.");
const conflict = () => new DomainError("conflict", "The workpad changed. Read its latest revision before editing.");
const draftConflict = () => new DomainError("draft_revision_conflict", "The workpad draft changed on another client. Read the latest draft before saving.");
function parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError("bad_request", "Invalid workpad request.");
  return result.data;
}
function stamp(now: number): string { return new Date(now).toISOString(); }
function validRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError("bad_request", "Invalid workpad revision.");
}
function scopeColumns(scope: WorkpadScope): [string, string | null, string | null] {
  return [scope.kind, scope.kind === "workspace" ? scope.workspaceId : null, scope.kind === "thread" ? scope.threadId : null];
}
function sameScope(a: WorkpadScope, b: WorkpadScope) { return JSON.stringify(a) === JSON.stringify(b); }

/** Pure text provenance transformation. Offsets are UTF-16, as in browser selection APIs. */
type TextOperation = { value: string; added?: boolean; removed?: boolean };
function inferTextOperations(before: string, after: string): TextOperation[] | undefined {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  // Never split an otherwise well-formed surrogate pair at an alignment edge.
  if (prefix > 0 && /[\uD800-\uDBFF]/.test(before[prefix - 1]!)) prefix -= 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(before[before.length - suffix]!)) suffix -= 1;
  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);
  const middle = !oldMiddle ? [{ value: newMiddle, added: true }]
    : !newMiddle ? [{ value: oldMiddle, removed: true }]
    : diffChars(oldMiddle, newMiddle, { maxEditLength: 2_048 })
      ?? diffWordsWithSpace(oldMiddle, newMiddle, { maxEditLength: 2_048 })
      ?? diffLines(oldMiddle, newMiddle, { maxEditLength: 2_048 });
  if (!middle) return undefined;
  return [{ value: before.slice(0, prefix) }, ...middle, { value: suffix ? before.slice(before.length - suffix) : "" }];
}

export function attributeWorkpadEdit(previous: Pick<Workpad, "content" | "attribution">, content: string, revision: number, author: WorkpadAuthor, createdAt: string, operations?: TextOperation[]): { attribution: WorkpadAttributionSpan[]; changes: WorkpadChange[] } {
  // A deterministic budget avoids server-load-dependent provenance. Explicit
  // patch/append operations bypass inference and preserve exact match identity.
  const parts = operations ?? inferTextOperations(previous.content, content);
  if (!parts) throw new DomainError("bad_request", "This edit changes too many separate passages to preserve attribution. Save smaller groups of changes or split the workpad.");
  const attribution: WorkpadAttributionSpan[] = [];
  const changes: WorkpadChange[] = [];
  let oldOffset = 0;
  let newOffset = 0;
  let spanIndex = 0;
  const add = (span: WorkpadAttributionSpan) => {
    if (span.start === span.end) return;
    const last = attribution.at(-1);
    if (last && last.end === span.start && last.revision === span.revision) last.end = span.end;
    else attribution.push(span);
  };
  for (const part of parts) {
    if (part.removed) {
      if (part.value) changes.push({ kind: "removed", text: part.value, offset: oldOffset });
      oldOffset += part.value.length;
    } else if (part.added) {
      if (part.value) changes.push({ kind: "added", text: part.value, offset: newOffset });
      add({ start: newOffset, end: newOffset + part.value.length, revision, author, createdAt });
      newOffset += part.value.length;
    } else {
      const oldEnd = oldOffset + part.value.length;
      while (spanIndex < previous.attribution.length && previous.attribution[spanIndex]!.end <= oldOffset) spanIndex += 1;
      for (let index = spanIndex; index < previous.attribution.length; index += 1) {
        const span = previous.attribution[index]!;
        if (span.start >= oldEnd) break;
        add({ ...span, start: newOffset + Math.max(span.start, oldOffset) - oldOffset, end: newOffset + Math.min(span.end, oldEnd) - oldOffset });
      }
      oldOffset = oldEnd;
      newOffset += part.value.length;
    }
  }
  // Revision details show readable words, independent of precise source-span
  // provenance. Explicit operations remain a bounded fallback for huge appends.
  const readable = diffWordsWithSpace(previous.content, content, { maxEditLength: 2_048 });
  if (readable) {
    changes.length = 0;
    let oldPosition = 0;
    let newPosition = 0;
    for (const part of readable) {
      if (part.removed) {
        changes.push({ kind: "removed", text: part.value, offset: oldPosition });
        oldPosition += part.value.length;
      } else if (part.added) {
        changes.push({ kind: "added", text: part.value, offset: newPosition });
        newPosition += part.value.length;
      } else {
        oldPosition += part.value.length;
        newPosition += part.value.length;
      }
    }
  }
  return { attribution, changes };
}

export class WorkpadRepository {
  constructor(readonly database: Database.Database) {}

  #owned(scope: RequestScope, id: string): Workpad {
    const row = this.database.prepare("SELECT document_json AS json FROM workpads WHERE tenant_id=? AND owner_principal_id=? AND id=?").get(scope.tenantId, scope.principalId, id) as { json: string } | undefined;
    if (!row) throw notFound();
    return workpadSchema.parse(JSON.parse(row.json));
  }
  #resolveAuthor(scope: RequestScope, actor: WorkpadActor): WorkpadAuthor {
    if (actor.kind === "user") return { kind: "user", threadId: null, clientId: null, name: "You", nameSnapshot: "You" };
    const table = actor.kind === "agent" ? "application_threads" : "principal_agent_tool_clients";
    const column = actor.kind === "agent" ? "title" : "name";
    const id = actor.kind === "agent" ? actor.threadId : actor.clientId;
    const row = this.database.prepare(`SELECT ${column} AS name FROM ${table} WHERE tenant_id=? AND owner_principal_id=? AND id=?`).get(scope.tenantId, scope.principalId, id) as { name: string } | undefined;
    if (!row) throw new DomainError("not_found", "The workpad editor was not found.");
    return actor.kind === "agent"
      ? { kind: "agent", threadId: actor.threadId, clientId: null, name: row.name, nameSnapshot: row.name }
      : { kind: "tool_client", threadId: null, clientId: actor.clientId, name: row.name, nameSnapshot: row.name };
  }
  #present<T extends { author: WorkpadAuthor; attribution?: WorkpadAttributionSpan[] }>(scope: RequestScope, value: T): T {
    const cache = new Map<string, WorkpadAuthor>();
    const resolve = (author: WorkpadAuthor): WorkpadAuthor => {
      if (author.kind === "user") return author;
      const id = author.threadId ?? author.clientId!;
      const key = `${author.kind}:${id}:${author.nameSnapshot}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const table = author.kind === "agent" ? "application_threads" : "principal_agent_tool_clients";
      const column = author.kind === "agent" ? "title" : "name";
      const row = this.database.prepare(`SELECT ${column} AS name FROM ${table} WHERE tenant_id=? AND owner_principal_id=? AND id=?`).get(scope.tenantId, scope.principalId, id) as { name: string } | undefined;
      const resolved = { ...author, name: row?.name ?? author.nameSnapshot };
      cache.set(key, resolved);
      return resolved;
    };
    return { ...value, author: resolve(value.author), ...(value.attribution ? { attribution: value.attribution.map(span => ({ ...span, author: resolve(span.author) })) } : {}) };
  }
  #assertScope(scope: RequestScope, target: WorkpadScope): void {
    parse(workpadScopeSchema, target);
    if (target.kind === "global") return;
    const table = target.kind === "thread" ? "application_threads" : "workspaces";
    const id = target.kind === "thread" ? target.threadId : target.workspaceId;
    if (!this.database.prepare(`SELECT 1 FROM ${table} WHERE tenant_id=? AND owner_principal_id=? AND id=?`).get(scope.tenantId, scope.principalId, id)) {
      throw new DomainError("not_found", "The workpad scope was not found.");
    }
  }
  getAuthority(scope: RequestScope, id: string): WorkpadAuthority {
    const row = this.database.prepare(`SELECT p.scope_kind AS kind, p.workspace_id AS workspaceId, p.thread_id AS threadId, p.revision,
      CASE WHEN p.scope_kind='workspace' THEN w.environment_id WHEN p.scope_kind='thread' THEN t.environment_id ELSE NULL END AS environmentId
      FROM workpads p LEFT JOIN workspaces w ON w.tenant_id=p.tenant_id AND w.owner_principal_id=p.owner_principal_id AND w.id=p.workspace_id
      LEFT JOIN application_threads t ON t.tenant_id=p.tenant_id AND t.owner_principal_id=p.owner_principal_id AND t.id=p.thread_id
      WHERE p.tenant_id=? AND p.owner_principal_id=? AND p.id=?`).get(scope.tenantId, scope.principalId, id) as { kind: "global" | "workspace" | "thread"; workspaceId: string | null; threadId: string | null; revision: number; environmentId: string | null } | undefined;
    if (!row) throw notFound();
    if (row.kind !== "global" && row.environmentId === null) throw notFound();
    return { scope: row.kind === "global" ? { kind: "global" } : row.kind === "workspace" ? { kind: "workspace", workspaceId: row.workspaceId! } : { kind: "thread", threadId: row.threadId! }, environmentId: row.environmentId, revision: row.revision };
  }
  get(scope: RequestScope, id: string): Workpad { return this.#present(scope, this.#owned(scope, id)); }
  create(scope: RequestScope, input: CreateWorkpadRequest, actor: WorkpadActor = { kind: "user" }, now = Date.now()): Workpad {
    const request = parse(createWorkpadRequestSchema, input);
    return this.database.transaction(() => {
      this.#assertScope(scope, request.scope);
      const author = this.#resolveAuthor(scope, actor);
      const date = stamp(now);
      const id = randomUUID();
      const content = request.content ?? "";
      const pad: Workpad = { id, title: request.title, scope: request.scope, content, revision: 0, createdAt: date, updatedAt: date, archivedAt: null, author,
        attribution: content ? [{ start: 0, end: content.length, revision: 0, author, createdAt: date }] : [] };
      this.database.prepare("INSERT INTO workpads(tenant_id,owner_principal_id,id,scope_kind,workspace_id,thread_id,title,revision,archived_at,created_at,updated_at,document_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(scope.tenantId, scope.principalId, id, ...scopeColumns(pad.scope), pad.title, 0, null, date, date, JSON.stringify(pad));
      this.#writeRevision(scope, pad, content ? [{ kind: "added", text: content, offset: 0 }] : []);
      this.database.prepare("INSERT INTO workpad_drafts(tenant_id,owner_principal_id,workpad_id,revision,base_revision,content,updated_at) VALUES(?,?,?,0,0,?,?)").run(scope.tenantId, scope.principalId, id, content, date);
      return pad;
    })();
  }
  #writeRevision(scope: RequestScope, pad: Workpad, changes: WorkpadChange[]): void {
    const revision: WorkpadRevision = { workpadId: pad.id, revision: pad.revision, title: pad.title, content: pad.content, scope: pad.scope, archivedAt: pad.archivedAt, author: pad.author, attribution: pad.attribution, changes, createdAt: pad.updatedAt };
    const serialized = JSON.stringify(revision);
    if (Buffer.byteLength(serialized, "utf8") > 2_097_152) {
      throw new DomainError("bad_request", "This edit exceeds the workpad revision size limit. Split this document into smaller workpads.");
    }
    this.database.prepare("INSERT INTO workpad_revisions(tenant_id,owner_principal_id,workpad_id,revision,document_json) VALUES(?,?,?,?,?)").run(scope.tenantId, scope.principalId, pad.id, pad.revision, serialized);
  }
  update(scope: RequestScope, id: string, input: UpdateWorkpadRequest, actor: WorkpadActor = { kind: "user" }, now = Date.now()): Workpad {
    const request = parse(updateWorkpadRequestSchema, input);
    return this.database.transaction(() => {
      const previous = this.#owned(scope, id);
      if (previous.revision !== request.expectedRevision) throw conflict();
      const author = this.#resolveAuthor(scope, actor);
      if (request.scope) this.#assertScope(scope, request.scope);
      if (previous.archivedAt && request.edit) throw new DomainError("invalid_transition", "Restore the workpad before editing its content.");
      let content = previous.content;
      let operations: TextOperation[] | undefined;
      if (request.edit?.kind === "replace") content = request.edit.content;
      else if (request.edit?.kind === "append") {
        operations = [{ value: content }, { value: request.edit.text, added: true }];
        content += request.edit.text;
      }
      else if (request.edit?.kind === "patch") {
        // Every match is resolved against the same expected revision, so one
        // replacement cannot accidentally match another replacement's output.
        const edits = request.edit.edits.map(edit => {
          const start = content.indexOf(edit.oldText);
          if (start < 0 || content.indexOf(edit.oldText, start + 1) >= 0) throw new DomainError("conflict", "Each patch must match exactly one passage in the expected revision.");
          return { ...edit, start, end: start + edit.oldText.length };
        }).sort((a, b) => a.start - b.start);
        for (let index = 1; index < edits.length; index += 1) if (edits[index]!.start < edits[index - 1]!.end) throw new DomainError("bad_request", "Patch passages must not overlap.");
        operations = [];
        let position = 0;
        for (const edit of edits) {
          const localDiff = inferTextOperations(edit.oldText, edit.newText);
          // The caller explicitly selected this exact range for replacement.
          // Preserve matching text when alignment is bounded; a substantial
          // rewrite of that selected range belongs to its new editor.
          operations.push({ value: content.slice(position, edit.start) }, ...(localDiff ?? [
            { value: edit.oldText, removed: true }, { value: edit.newText, added: true },
          ]));
          position = edit.end;
        }
        operations.push({ value: content.slice(position) });
        for (const edit of edits.reverse()) content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
      }
      const title = request.title ?? previous.title;
      const target = request.scope ?? previous.scope;
      const archivedAt = request.archived === undefined ? previous.archivedAt : request.archived ? previous.archivedAt ?? stamp(now) : null;
      if (content === previous.content && title === previous.title && sameScope(target, previous.scope) && archivedAt === previous.archivedAt) return this.#present(scope, previous);
      const date = stamp(now);
      const { attribution, changes } = attributeWorkpadEdit(previous, content, previous.revision + 1, author, date, operations);
      const candidate = { ...previous, title, scope: target, archivedAt, content, attribution, author, revision: previous.revision + 1, updatedAt: date };
      if (candidate.attribution.length > 4_096 || Buffer.byteLength(JSON.stringify(candidate), "utf8") > 2_097_152) {
        throw new DomainError("bad_request", "This edit exceeds the workpad attribution limit. Split this document into smaller workpads.");
      }
      const pad = parse(workpadSchema, candidate);
      const changed = this.database.prepare("UPDATE workpads SET scope_kind=?,workspace_id=?,thread_id=?,title=?,revision=?,archived_at=?,updated_at=?,document_json=? WHERE tenant_id=? AND owner_principal_id=? AND id=? AND revision=?").run(...scopeColumns(target), title, pad.revision, archivedAt, date, JSON.stringify(pad), scope.tenantId, scope.principalId, id, request.expectedRevision);
      if (changed.changes !== 1) throw conflict();
      this.#writeRevision(scope, pad, changes);
      // A clean synchronized draft follows committed changes. Dirty drafts
      // retain both their text and old base until explicitly reconciled.
      this.database.prepare("UPDATE workpad_drafts SET content=?,base_revision=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND owner_principal_id=? AND workpad_id=? AND base_revision=? AND content=?").run(pad.content, pad.revision, date, scope.tenantId, scope.principalId, id, previous.revision, previous.content);
      return this.#present(scope, pad);
    })();
  }

  list(scope: RequestScope, input: ListWorkpadsRequest, authority?: WorkpadListAuthority): WorkpadListPage {
    const request = parse(listWorkpadsRequestSchema, input);
    this.#assertScope(scope, request.scope);
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...request, cursor: undefined, authority, tenantId: scope.tenantId, principalId: scope.principalId })).digest("hex");
    let after: { updatedAt: string; id: string } | undefined;
    if (request.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString()) as { key: string; updatedAt: string; id: string };
        if (cursor.key !== fingerprint || typeof cursor.updatedAt !== "string" || typeof cursor.id !== "string") throw new Error();
        after = cursor;
      } catch { throw new DomainError("cursor_invalid", "The workpad cursor does not match this query."); }
    }
    const conditions = ["p.tenant_id=?", "p.owner_principal_id=?", request.archived ? "p.archived_at IS NOT NULL" : "p.archived_at IS NULL"];
    const params: (string | number)[] = [scope.tenantId, scope.principalId];
    if (request.scope.kind === "thread") { conditions.push("p.scope_kind='thread' AND p.thread_id=?"); params.push(request.scope.threadId); }
    else if (request.scope.kind === "workspace") {
      conditions.push(request.scopeMode === "subtree" ? "((p.scope_kind='workspace' AND p.workspace_id=?) OR (p.scope_kind='thread' AND t.workspace_id=?))" : "p.scope_kind='workspace' AND p.workspace_id=?");
      params.push(request.scope.workspaceId); if (request.scopeMode === "subtree") params.push(request.scope.workspaceId);
    } else if (request.scopeMode === "exact") conditions.push("p.scope_kind='global'");
    if (authority?.environmentIds !== undefined) {
      const ids = [...new Set(authority.environmentIds)];
      conditions.push(ids.length ? `(p.scope_kind='global' OR CASE WHEN p.scope_kind='workspace' THEN w.environment_id ELSE t.environment_id END IN (${ids.map(() => "?").join(",")}))` : "p.scope_kind='global'");
      params.push(...ids);
    }
    if (request.query) { conditions.push("(instr(lower(p.title), lower(?)) > 0 OR instr(lower(json_extract(p.document_json,'$.content')), lower(?)) > 0)"); params.push(request.query, request.query); }
    if (after) { conditions.push("(p.updated_at < ? OR (p.updated_at=? AND p.id>?))"); params.push(after.updatedAt, after.updatedAt, after.id); }
    const rows = this.database.prepare(`SELECT json_remove(p.document_json,'$.content','$.attribution') AS json FROM workpads p
      LEFT JOIN application_threads t ON t.tenant_id=p.tenant_id AND t.owner_principal_id=p.owner_principal_id AND t.id=p.thread_id
      LEFT JOIN workspaces w ON w.tenant_id=p.tenant_id AND w.owner_principal_id=p.owner_principal_id AND w.id=p.workspace_id
      WHERE ${conditions.map(c => `(${c})`).join(" AND ")} ORDER BY p.updated_at DESC,p.id ASC LIMIT ?`).all(...params, request.limit + 1) as { json: string }[];
    const items = rows.slice(0, request.limit).map(row => this.#present(scope, workpadSummarySchema.parse(JSON.parse(row.json))));
    const last = items.at(-1);
    return { items, ...(rows.length > request.limit && last ? { nextCursor: Buffer.from(JSON.stringify({ key: fingerprint, updatedAt: last.updatedAt, id: last.id })).toString("base64url") } : {}) };
  }
  revision(scope: RequestScope, id: string, revision: number): WorkpadRevision {
    validRevision(revision);
    this.#owned(scope, id);
    const row = this.database.prepare("SELECT document_json AS json FROM workpad_revisions WHERE tenant_id=? AND owner_principal_id=? AND workpad_id=? AND revision=?").get(scope.tenantId, scope.principalId, id, revision) as { json: string } | undefined;
    if (!row) throw new DomainError("not_found", "The workpad revision was not found.");
    return this.#present(scope, workpadRevisionSchema.parse(JSON.parse(row.json)));
  }
  revisions(scope: RequestScope, id: string, options: { limit?: number; cursor?: string } = {}): WorkpadRevisionPage {
    this.#owned(scope, id);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("bad_request", "Invalid history page size.");
    const key = createHash("sha256").update(JSON.stringify([scope.tenantId, scope.principalId, id, limit])).digest("hex");
    let before = Number.MAX_SAFE_INTEGER;
    if (options.cursor) {
      try {
        if (options.cursor.length > 256) throw new Error();
        const cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString()) as { key: string; before: number };
        if (cursor.key !== key || !Number.isSafeInteger(cursor.before) || cursor.before < 0) throw new Error();
        before = cursor.before;
      } catch { throw new DomainError("cursor_invalid", "Invalid workpad history cursor."); }
    }
    const rows = this.database.prepare("SELECT json_remove(document_json,'$.content','$.attribution','$.changes') AS json FROM workpad_revisions WHERE tenant_id=? AND owner_principal_id=? AND workpad_id=? AND revision < ? ORDER BY revision DESC LIMIT ?").all(scope.tenantId, scope.principalId, id, before, limit + 1) as { json: string }[];
    const items = rows.slice(0, limit).map(row => {
      const result = workpadRevisionSummarySchema.parse(JSON.parse(row.json));
      return this.#present(scope, result);
    });
    const last = items.at(-1);
    return { items, ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ key, before: last.revision })).toString("base64url") } : {}) };
  }
  getDraft(scope: RequestScope, id: string): WorkpadDraft {
    this.#owned(scope, id);
    const row = this.database.prepare("SELECT workpad_id AS workpadId,revision,base_revision AS baseRevision,content,updated_at AS updatedAt FROM workpad_drafts WHERE tenant_id=? AND owner_principal_id=? AND workpad_id=?").get(scope.tenantId, scope.principalId, id);
    if (!row) throw notFound();
    return workpadDraftSchema.parse(row);
  }
  saveDraft(scope: RequestScope, id: string, input: SaveWorkpadDraftRequest, now = Date.now()): WorkpadDraft {
    const request = parse(saveWorkpadDraftRequestSchema, input);
    return this.database.transaction(() => {
      const pad = this.#owned(scope, id);
      if (pad.archivedAt) throw new DomainError("invalid_transition", "Restore the workpad before editing a draft.");
      // Base must be an actual historical revision, not a caller-created future state.
      this.revision(scope, id, request.baseRevision);
      const result = this.database.prepare("UPDATE workpad_drafts SET revision=revision+1,base_revision=?,content=?,updated_at=? WHERE tenant_id=? AND owner_principal_id=? AND workpad_id=? AND revision=?").run(request.baseRevision, request.content, stamp(now), scope.tenantId, scope.principalId, id, request.expectedRevision);
      if (result.changes !== 1) throw draftConflict();
      return this.getDraft(scope, id);
    })();
  }
  discardDraft(scope: RequestScope, id: string, expectedDraftRevision: number, now = Date.now()): WorkpadDraft {
    validRevision(expectedDraftRevision);
    return this.database.transaction(() => {
      const pad = this.#owned(scope, id);
      const result = this.database.prepare("UPDATE workpad_drafts SET revision=revision+1,base_revision=?,content=?,updated_at=? WHERE tenant_id=? AND owner_principal_id=? AND workpad_id=? AND revision=?").run(pad.revision, pad.content, stamp(now), scope.tenantId, scope.principalId, id, expectedDraftRevision);
      if (result.changes !== 1) throw draftConflict();
      return this.getDraft(scope, id);
    })();
  }
  commitDraft(scope: RequestScope, id: string, input: CommitWorkpadDraftRequest, now = Date.now()): Workpad {
    const request = parse(commitWorkpadDraftRequestSchema, input);
    return this.database.transaction(() => {
      const draft = this.getDraft(scope, id);
      if (draft.revision !== request.expectedDraftRevision) throw draftConflict();
      if (draft.baseRevision !== request.expectedRevision) throw conflict();
      const pad = this.update(scope, id, { expectedRevision: request.expectedRevision, edit: { kind: "replace", content: draft.content } }, { kind: "user" }, now);
      // update may advance a clean draft itself; resetting is still atomic and
      // always invalidates outstanding autosaves based on the pre-commit draft.
      const latest = this.getDraft(scope, id);
      this.discardDraft(scope, id, latest.revision, now);
      return pad;
    })();
  }
}
