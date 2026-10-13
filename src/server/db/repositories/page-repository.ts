import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { MAXIMUM_NORMALIZED_TIMELINE_ITEMS } from "../../../shared/protocol/conversation.js";
import { pageIdSchema, pageRevisionSchema, type PagePublicationResult, type PageRevision, type PageRevisionPage, type PageViewport } from "../../../shared/protocol/pages.js";
import { applicationPublicationAnchorSchema, type ApplicationPublicationAnchor } from "../../../shared/protocol/application-publications.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { nextApplicationPublicationTime } from "./application-publication-clock.js";

export interface PreparedPage {
  readonly sourceHtml: string; readonly escapedHtml: string; readonly bootstrapOffset: number;
  readonly sha256: string; readonly byteSize: number;
}
export interface PagePublication { readonly page: PageRevision; readonly invocationId: string; readonly anchor: ApplicationPublicationAnchor; }
export type PageReadOptions = { readonly limit?: number; readonly cursor?: string };
interface Row { descriptor_json: string; source_path: string | null; source_html: string; escaped_html: string; bootstrap_offset: number; invocation_id: string; anchor_json: string | null; }
interface ListRow { descriptor_json: string; created_at: number; id: string; }
const rowPage = (row: Pick<Row, "descriptor_json">) => pageRevisionSchema.parse(JSON.parse(row.descriptor_json));
const missing = () => new DomainError("not_found", "The page revision was not found.");

/** All page and revision access includes exact principal and thread ownership. */
export class PageRepository {
  constructor(readonly database: Database.Database) {}

  assertThread(scope: RequestScope, threadId: string): void {
    if (!this.database.prepare(`SELECT 1 FROM application_threads WHERE tenant_id=? AND owner_principal_id=? AND id=?`)
      .get(scope.tenantId, scope.principalId, threadId)) throw missing();
  }

  #row(scope: RequestScope, threadId: string, pageId: string, revision?: number, fields: "descriptor" | "source" | "content" = "descriptor"): Row {
    pageIdSchema.parse(pageId);
    const selected = fields === "content" ? "r.descriptor_json,r.escaped_html,r.bootstrap_offset" : fields === "source" ? "r.source_path,r.source_html" : "r.descriptor_json";
    const row = this.database.prepare(`SELECT ${selected} FROM html_page_revisions r JOIN html_pages p
      ON p.tenant_id=r.tenant_id AND p.owner_principal_id=r.owner_principal_id AND p.thread_id=r.thread_id AND p.id=r.page_id
      WHERE r.tenant_id=? AND r.owner_principal_id=? AND r.thread_id=? AND r.page_id=? AND r.revision=COALESCE(?,p.current_revision)`)
      .get(scope.tenantId, scope.principalId, threadId, pageId, revision ?? null) as Row | undefined;
    if (!row) throw missing();
    return row;
  }
  get(scope: RequestScope, threadId: string, pageId: string, revision?: number): PageRevision {
    return rowPage(this.#row(scope, threadId, pageId, revision));
  }
  content(scope: RequestScope, threadId: string, pageId: string, revision: number): { page: PageRevision; escapedHtml: string; bootstrapOffset: number } {
    const row = this.#row(scope, threadId, pageId, revision, "content");
    return { page: rowPage(row), escapedHtml: row.escaped_html, bootstrapOffset: row.bootstrap_offset };
  }
  source(scope: RequestScope, threadId: string, pageId: string, revision?: number): { path?: string; html: string } {
    const row = this.#row(scope, threadId, pageId, revision, "source");
    return { ...(row.source_path === null ? {} : { path: row.source_path }), html: row.source_html };
  }
  list(scope: RequestScope, threadId: string, options: PageReadOptions = {}): PageRevisionPage {
    this.assertThread(scope, threadId);
    const limit = pageLimit(options);
    const key = cursorKey(scope, "pages", threadId);
    const cursor = readCursor(options.cursor, key);
    if (cursor && (cursor.length !== 2 || !isRevisionOrTimestamp(cursor[0], 0) || !pageIdSchema.safeParse(cursor[1]).success)) throw invalidCursor();
    const boundary = cursor ? " AND (p.created_at,p.id) < (?,?)" : "";
    const rows = this.database.prepare(`SELECT r.descriptor_json,p.created_at,p.id FROM html_pages p JOIN html_page_revisions r
      ON p.tenant_id=r.tenant_id AND p.owner_principal_id=r.owner_principal_id AND p.thread_id=r.thread_id AND p.id=r.page_id AND p.current_revision=r.revision
      WHERE p.tenant_id=? AND p.owner_principal_id=? AND p.thread_id=?${boundary} ORDER BY p.created_at DESC,p.id DESC LIMIT ?`)
      .all(scope.tenantId, scope.principalId, threadId, ...(cursor ?? []), limit + 1) as ListRow[];
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return { items: selected.map(rowPage), ...(rows.length > limit && last ? { nextCursor: writeCursor(key, [last.created_at, last.id]) } : {}) };
  }
  revisions(scope: RequestScope, threadId: string, pageId: string, options: PageReadOptions = {}): PageRevisionPage {
    this.get(scope, threadId, pageId);
    const key = cursorKey(scope, "revisions", threadId, pageId);
    const limit = pageLimit(options);
    const cursor = readCursor(options.cursor, key);
    if (cursor && (cursor.length !== 1 || !isRevisionOrTimestamp(cursor[0], 1))) throw invalidCursor();
    const boundary = cursor ? " AND revision < ?" : "";
    const rows = this.database.prepare(`SELECT descriptor_json FROM html_page_revisions WHERE tenant_id=? AND owner_principal_id=? AND thread_id=? AND page_id=?${boundary} ORDER BY revision DESC LIMIT ?`)
      .all(scope.tenantId, scope.principalId, threadId, pageId, ...(cursor ?? []), limit + 1) as Row[];
    const selected = rows.slice(0, limit).map(rowPage);
    const last = selected.at(-1);
    return { items: selected, ...(rows.length > limit && last ? { nextCursor: writeCursor(key, [last.revision]) } : {}) };
  }
  publications(scope: RequestScope, threadId: string, turnIds?: readonly string[]): readonly PagePublication[] {
    this.assertThread(scope, threadId);
    if (turnIds?.length === 0) return [];
    const filter = turnIds ? ` AND anchor_turn_id IN (${turnIds.map(() => "?").join(",")})` : "";
    // Bound the projection cache even when many loaded turns each contain
    // their maximum publications. The paginated page library retains all revisions.
    return (this.database.prepare(`SELECT descriptor_json,invocation_id,anchor_json FROM html_page_revisions WHERE tenant_id=? AND owner_principal_id=? AND thread_id=? AND anchor_turn_id IS NOT NULL${filter} ORDER BY rowid LIMIT ${MAXIMUM_NORMALIZED_TIMELINE_ITEMS}`)
      .all(scope.tenantId, scope.principalId, threadId, ...(turnIds ?? [])) as Row[]).map(row => ({
      page: rowPage(row), invocationId: row.invocation_id, anchor: applicationPublicationAnchorSchema.parse(JSON.parse(row.anchor_json!)),
    }));
  }

  publish(scope: RequestScope, threadId: string, input: {
    readonly title: string; readonly viewport: PageViewport; readonly path?: string;
    readonly pageId?: string; readonly expectedRevision?: number; readonly prepared: PreparedPage;
    readonly invocationId: string; readonly anchor?: ApplicationPublicationAnchor; readonly assertCurrent?: () => void;
  }, now = Date.now()): PagePublicationResult {
    return this.database.transaction(() => {
      input.assertCurrent?.();
      this.assertThread(scope, threadId);
      const previous = input.pageId ? this.get(scope, threadId, input.pageId) : undefined;
      if (previous && previous.revision !== input.expectedRevision) throw new DomainError("conflict", "The page changed. Read its current revision and retry.");
      if (previous && previous.sha256 === input.prepared.sha256 && previous.title === input.title &&
        previous.viewport.width === input.viewport.width && previous.viewport.height === input.viewport.height) {
        return { page: previous, changed: false };
      }
      if (input.anchor) {
        const count = this.database.prepare(`SELECT COUNT(*) AS count FROM html_page_revisions WHERE tenant_id=? AND owner_principal_id=? AND thread_id=? AND anchor_turn_id=?`)
          .get(scope.tenantId, scope.principalId, threadId, input.anchor.turnId) as { count: number };
        if (count.count >= 1000) throw new DomainError("bad_request", "This turn has reached its page publication limit.");
      }
      now = nextApplicationPublicationTime(this.database, scope, threadId, now);
      const descriptor = pageRevisionSchema.parse({ pageId: previous?.pageId ?? randomUUID(), threadId,
        revision: (previous?.revision ?? 0) + 1, title: input.title, viewport: input.viewport,
        createdAt: new Date(now).toISOString(), sha256: input.prepared.sha256, byteSize: input.prepared.byteSize });
      if (previous) {
        this.database.prepare(`UPDATE html_pages SET current_revision=? WHERE tenant_id=? AND owner_principal_id=? AND thread_id=? AND id=?`)
          .run(descriptor.revision, scope.tenantId, scope.principalId, threadId, descriptor.pageId);
      } else {
        this.database.prepare(`INSERT INTO html_pages(tenant_id,owner_principal_id,thread_id,id,current_revision,created_at) VALUES (?,?,?,?,?,?)`)
          .run(scope.tenantId, scope.principalId, threadId, descriptor.pageId, descriptor.revision, now);
      }
      this.database.prepare(`INSERT INTO html_page_revisions(tenant_id,owner_principal_id,thread_id,page_id,revision,descriptor_json,source_path,source_html,escaped_html,bootstrap_offset,invocation_id,anchor_turn_id,anchor_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(scope.tenantId, scope.principalId, threadId, descriptor.pageId, descriptor.revision, JSON.stringify(descriptor),
          input.path ?? null, input.prepared.sourceHtml, input.prepared.escapedHtml, input.prepared.bootstrapOffset, input.invocationId,
          input.anchor?.turnId ?? null, input.anchor ? JSON.stringify(applicationPublicationAnchorSchema.parse(input.anchor)) : null);
      return { page: descriptor, changed: true };
    })();
  }
}

function pageLimit(options: PageReadOptions): number {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("bad_request", "Invalid page limit.");
  return limit;
}
function cursorKey(scope: RequestScope, kind: "pages" | "revisions", threadId: string, pageId?: string): string {
  return createHash("sha256").update(JSON.stringify([scope.tenantId, scope.principalId, kind, threadId, pageId])).digest("base64url").slice(0, 22);
}
function invalidCursor() { return new DomainError("cursor_invalid", "The page cursor is invalid."); }
function isRevisionOrTimestamp(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function readCursor(cursor: string | undefined, key: string): unknown[] | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (cursor.length > 256 || Buffer.from(cursor, "base64url").toString("base64url") !== cursor) throw new Error();
    const values: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(values) || values[0] !== key) throw new Error();
    return values.slice(1);
  } catch { throw invalidCursor(); }
}
function writeCursor(key: string, values: readonly unknown[]): string {
  return Buffer.from(JSON.stringify([key, ...values])).toString("base64url");
}
