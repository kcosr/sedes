import { describe, expect, it, vi } from "vitest";
import { ComposerAttachmentRepository } from "../../src/server/db/repositories/composer-attachment-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const THREAD_ID = "0198aa10-0000-7000-8000-000000000001";
const OWNER_ID = "0198aa10-0000-7000-8000-000000000002";
const DIGEST = "a".repeat(64);
type Owner = Parameters<ComposerAttachmentRepository["listForOwner"]>[1];

const owners: Owner[] = [
  { kind: "draft", threadId: THREAD_ID },
  { kind: "stash", threadId: THREAD_ID, stashId: OWNER_ID },
  { kind: "queue", threadId: THREAD_ID, queuedInputId: OWNER_ID },
  { kind: "creation", threadId: THREAD_ID, attemptId: OWNER_ID },
  { kind: "operation", threadId: THREAD_ID, mutationId: OWNER_ID },
  { kind: "submitted", threadId: THREAD_ID, operationId: OWNER_ID },
];

function fixture() {
  const current = savedAgentDatabase();
  const environment = current.database.prepare("SELECT id FROM execution_environments WHERE tenant_id = ? AND owner_principal_id = ? AND kind = 'local'")
    .get(current.scope.tenantId, current.scope.principalId) as { id: string };
  const profile = current.database.prepare("SELECT id FROM agent_connection_profiles WHERE tenant_id = ? AND owner_principal_id = ?")
    .get(current.scope.tenantId, current.scope.principalId) as { id: string };
  const inventory = new InventoryRepository(current.database);
  const workspace = inventory.upsertWorkspace(current.scope, {
    id: "0198aa10-0000-7000-8000-000000000003", environmentId: environment.id,
    canonicalPath: "/tmp/attachment-query-workspace", displayName: "Attachment query",
    available: true, trustState: "trusted", environmentConfigurationRevision: 0, now: 200,
  });
  new ConversationBindingRepository(current.database).createUnboundThread(current.scope, {
    id: THREAD_ID, workspaceId: workspace.id, connectionProfileId: profile.id, title: "Attachment query", now: 201,
  });
  const attachments = new ComposerAttachmentRepository(current.database);
  attachments.upsertBlob(current.scope, { sha256: DIGEST, byteLength: 12, storageKey: DIGEST, now: 202 });
  // Unrelated uploads must never become the outer scan for an empty owner.
  const ids = Array.from({ length: 64 }, (_, index) => `0198aa10-0000-7000-8000-${String(index + 100).padStart(12, "0")}`);
  for (const id of ids) attachments.createAttachment(current.scope, {
    id, originThreadId: THREAD_ID, blobSha256: DIGEST, displayName: `${id}.bin`,
    mediaType: "application/octet-stream", kind: "file", now: 202,
  });
  return { ...current, attachments, ids };
}

describe("composer attachment owner reads", () => {
  it.each(owners)("uses the bounded owner index before attachment/blob lookups for $kind", (owner) => {
    const current = fixture();
    try {
      const prepare = vi.spyOn(current.database, "prepare");
      expect(current.attachments.listForOwner(current.scope, owner)).toEqual([]);
      const sql = prepare.mock.calls.find(([query]) => query.includes("AS link"))![0];
      prepare.mockRestore();
      const parameters = [current.scope.tenantId, current.scope.principalId, THREAD_ID,
        ...(owner.kind === "draft" ? [] : [OWNER_ID])];
      const plan = current.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[];
      expect(plan[0]?.detail).toMatch(/^SEARCH link USING (?:COVERING )?INDEX /u);
      expect(plan[1]?.detail).toMatch(/^SEARCH attachment USING (?:COVERING )?INDEX /u);
      expect(plan[2]?.detail).toMatch(/^SEARCH blob USING (?:COVERING )?INDEX /u);
      expect(plan.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
      current.database.close();
    }
  });

  it("preserves attachment order, metadata, and exact principal/thread ownership", () => {
    const current = fixture();
    try {
      const selected = [current.ids[9]!, current.ids[2]!];
      const owner = { kind: "draft" as const, threadId: THREAD_ID };
      current.attachments.replaceOwnerLinks(current.scope, owner, selected);
      expect(current.attachments.descriptorsForOwner(current.scope, owner)).toEqual(selected.map(id => ({
        id, kind: "file", fileName: `${id}.bin`, mediaType: "application/octet-stream", byteSize: 12,
      })));
      expect(current.attachments.listForOwner({ ...current.scope, principalId: "another-principal" }, owner)).toEqual([]);
      expect(current.attachments.listForOwner({ ...current.scope, tenantId: "another-tenant" }, owner)).toEqual([]);
      expect(current.attachments.listForOwner(current.scope, { ...owner, threadId: OWNER_ID })).toEqual([]);
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
    } finally { current.database.close(); }
  });
});
