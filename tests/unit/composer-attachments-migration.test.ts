import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ComposerAttachmentRepository } from "../../src/server/db/repositories/composer-attachment-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const latestBackendNormalizedVersion =
  backendNormalizedMigrations[backendNormalizedMigrations.length - 1]!.version;

const THREAD_ID = "0198aa10-0000-7000-8000-000000000001";
const ATTACHMENT_ID = "0198aa10-0000-7000-8000-000000000002";
const DIGEST = "a".repeat(64);

function fixture() {
  const current = savedAgentDatabase(50);
  const environment = current.database
    .prepare(
      `SELECT id FROM execution_environments
       WHERE tenant_id = ? AND owner_principal_id = ? AND kind = 'local'`,
    )
    .get(current.scope.tenantId, current.scope.principalId) as { id: string };
  const profile = current.database
    .prepare(
      `SELECT id FROM agent_connection_profiles
       WHERE tenant_id = ? AND owner_principal_id = ?`,
    )
    .get(current.scope.tenantId, current.scope.principalId) as { id: string };
  const inventory = new InventoryRepository(current.database);
  const workspace = inventory.upsertWorkspace(current.scope, {
    id: "0198aa10-0000-7000-8000-000000000003",
    environmentId: environment.id,
    canonicalPath: "/tmp/attachment-migration-workspace",
    displayName: "Attachment migration",
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: 0,
    now: 200,
  });
  new ConversationBindingRepository(current.database).createUnboundThread(
    current.scope,
    {
      id: THREAD_ID,
      workspaceId: workspace.id,
      connectionProfileId: profile.id,
      title: "Attachment migration",
      now: 201,
    },
  );
  return current;
}

describe("composer attachments migration", () => {
  it("upgrades the live schema 50 without legacy links and enforces ordered owner scope", () => {
    const current = fixture();
    try {
      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      expect(
        current.database
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: latestBackendNormalizedVersion });
      expect(current.database.pragma("foreign_key_check")).toEqual([]);

      const attachments = new ComposerAttachmentRepository(current.database);
      attachments.upsertBlob(current.scope, {
        sha256: DIGEST,
        byteLength: 12,
        storageKey: DIGEST,
        now: 202,
      });
      attachments.createAttachment(current.scope, {
        id: ATTACHMENT_ID,
        originThreadId: THREAD_ID,
        blobSha256: DIGEST,
        displayName: "notes.bin",
        mediaType: "application/octet-stream",
        kind: "file",
        now: 202,
      });
      attachments.replaceOwnerLinks(
        current.scope,
        { kind: "draft", threadId: THREAD_ID },
        [ATTACHMENT_ID],
      );
      expect(
        attachments.descriptorsForOwner(current.scope, {
          kind: "draft",
          threadId: THREAD_ID,
        }),
      ).toEqual([
        {
          id: ATTACHMENT_ID,
          kind: "file",
          fileName: "notes.bin",
          mediaType: "application/octet-stream",
          byteSize: 12,
        },
      ]);
      expect(() =>
        attachments.replaceOwnerLinks(
          { tenantId: current.scope.tenantId, principalId: "other" },
          { kind: "draft", threadId: THREAD_ID },
          [ATTACHMENT_ID],
        ),
      ).toThrow();
    } finally {
      current.database.close();
    }
  });

  it("admits attachment-only stashes only when deferred ordered links exist", () => {
    const current = fixture();
    try {
      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      const attachments = new ComposerAttachmentRepository(current.database);
      attachments.upsertBlob(current.scope, {
        sha256: DIGEST,
        byteLength: 1,
        storageKey: DIGEST,
        now: 202,
      });
      attachments.createAttachment(current.scope, {
        id: ATTACHMENT_ID,
        originThreadId: THREAD_ID,
        blobSha256: DIGEST,
        displayName: "one.bin",
        mediaType: "application/octet-stream",
        kind: "file",
        now: 202,
      });
      expect(() =>
        current.database
          .prepare(
            `INSERT INTO prompt_stashes(
               tenant_id, principal_id, thread_id, id, text,
               selected_skill_id, context_excerpts_json, created_at
             ) VALUES (?, ?, ?, ?, '', NULL, '[]', ?)`,
          )
          .run(
            current.scope.tenantId,
            current.scope.principalId,
            THREAD_ID,
            "0198aa10-0000-7000-8000-000000000004",
            203,
          ),
      ).toThrow(/content is required/i);

      current.database.transaction(() => {
        attachments.replaceOwnerLinks(
          current.scope,
          {
            kind: "stash",
            threadId: THREAD_ID,
            stashId: "0198aa10-0000-7000-8000-000000000005",
          },
          [ATTACHMENT_ID],
        );
        current.database
          .prepare(
            `INSERT INTO prompt_stashes(
               tenant_id, principal_id, thread_id, id, text,
               selected_skill_id, context_excerpts_json, created_at
             ) VALUES (?, ?, ?, ?, '', NULL, '[]', ?)`,
          )
          .run(
            current.scope.tenantId,
            current.scope.principalId,
            THREAD_ID,
            "0198aa10-0000-7000-8000-000000000005",
            203,
          );
      })();
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      current.database.close();
    }
  });

  it("moves ordered attachment-only drafts through stash and restore atomically", () => {
    const current = fixture();
    try {
      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      const attachments = new ComposerAttachmentRepository(current.database);
      attachments.upsertBlob(current.scope, {
        sha256: DIGEST,
        byteLength: 7,
        storageKey: DIGEST,
        now: 202,
      });
      attachments.createAttachment(current.scope, {
        id: ATTACHMENT_ID,
        originThreadId: THREAD_ID,
        blobSha256: DIGEST,
        displayName: "draft.bin",
        mediaType: "application/octet-stream",
        kind: "file",
        now: 202,
      });
      const inventory = new InventoryRepository(current.database);
      const saved = inventory.saveDraft(current.scope, THREAD_ID, {
        text: "",
        contextExcerpts: [],
        taskReferenceIds: [],
        attachmentIds: [ATTACHMENT_ID],
        expectedRevision: 0,
        now: 203,
      });
      expect(saved.attachments.map(({ id }) => id)).toEqual([ATTACHMENT_ID]);

      const stashed = inventory.stashDraft(current.scope, THREAD_ID, {
        stashId: "0198aa10-0000-7000-8000-000000000006",
        expectedDraftRevision: saved.revision,
        mutationId: "0198aa10-0000-7000-8000-000000000007",
        maximumStashes: 10,
        now: 204,
      });
      expect(stashed.draft.attachments).toEqual([]);
      expect(stashed.stash.attachments.map(({ id }) => id)).toEqual([
        ATTACHMENT_ID,
      ]);

      const restored = inventory.restoreStash(
        current.scope,
        THREAD_ID,
        stashed.stash.id,
        {
          expectedDraftRevision: stashed.draft.revision,
          mutationId: "0198aa10-0000-7000-8000-000000000008",
          now: 205,
        },
      );
      expect(restored.draft.attachments.map(({ id }) => id)).toEqual([
        ATTACHMENT_ID,
      ]);
      expect(inventory.listStashes(current.scope, THREAD_ID)).toEqual([]);
    } finally {
      current.database.close();
    }
  });

  it("records exact ready materialization evidence and explicit terminal state", () => {
    const current = fixture();
    try {
      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      const attachments = new ComposerAttachmentRepository(current.database);
      attachments.upsertBlob(current.scope, {
        sha256: DIGEST,
        byteLength: 12,
        storageKey: DIGEST,
        now: 202,
      });
      attachments.createAttachment(current.scope, {
        id: ATTACHMENT_ID,
        originThreadId: THREAD_ID,
        blobSha256: DIGEST,
        displayName: "materialized.bin",
        mediaType: "application/octet-stream",
        kind: "file",
        now: 202,
      });
      const binding = current.database
        .prepare(
          `SELECT environment_id AS environmentId, workspace_id AS workspaceId
           FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(current.scope.tenantId, current.scope.principalId, THREAD_ID) as {
        environmentId: string;
        workspaceId: string;
      };
      const key = {
        executionEnvironmentId: binding.environmentId,
        workspaceId: binding.workspaceId,
        environmentAuthorityRevision: 0,
        applicationThreadId: THREAD_ID,
        attachmentId: ATTACHMENT_ID,
        blobSha256: DIGEST,
      } as const;
      const ready = attachments.recordReadyMaterialization(current.scope, key, {
        agentPath: "/tmp/staged/materialized.bin",
        byteLength: 12,
        verifiedAt: 203,
      });
      expect(ready).toMatchObject({
        ...key,
        state: "ready",
        verifiedAt: 203,
        byteLength: 12,
        agentPath: "/tmp/staged/materialized.bin",
      });
      expect(ready.materializationIdentity).toMatch(/^mat_[0-9a-f]{64}$/u);
      expect(
        attachments.markMaterializationMissing(current.scope, key, 204),
      ).toBe(true);
      expect(attachments.findMaterialization(current.scope, key)?.state).toBe(
        "missing",
      );
      expect(attachments.releaseMaterialization(current.scope, key, 205)).toBe(
        true,
      );
      expect(attachments.findMaterialization(current.scope, key)?.state).toBe(
        "released",
      );
      expect(() =>
        attachments.recordReadyMaterialization(
          current.scope,
          { ...key, workspaceId: "wrong-workspace" },
          {
            agentPath: "/tmp/staged/materialized.bin",
            byteLength: 12,
            verifiedAt: 206,
          },
        ),
      ).toThrow(/scope is no longer valid/i);
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      current.database.close();
    }
  });

  it("rejects a fifth image before replacing ordered owner links", () => {
    const current = fixture();
    try {
      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      const attachments = new ComposerAttachmentRepository(current.database);
      attachments.upsertBlob(current.scope, {
        sha256: DIGEST,
        byteLength: 1,
        storageKey: DIGEST,
        now: 202,
      });
      const ids = Array.from(
        { length: 5 },
        (_, index) =>
          `0198aa10-0000-7000-8000-${String(index + 10).padStart(12, "0")}`,
      );
      for (const id of ids) {
        attachments.createAttachment(current.scope, {
          id,
          originThreadId: THREAD_ID,
          blobSha256: DIGEST,
          displayName: `${id}.png`,
          mediaType: "image/png",
          kind: "image",
          imageWidth: 1,
          imageHeight: 1,
          now: 202,
        });
      }
      expect(() =>
        attachments.replaceOwnerLinks(
          current.scope,
          { kind: "draft", threadId: THREAD_ID },
          ids,
        ),
      ).toThrow(/image limit/i);
      expect(
        attachments.descriptorsForOwner(current.scope, {
          kind: "draft",
          threadId: THREAD_ID,
        }),
      ).toEqual([]);
    } finally {
      current.database.close();
    }
  });
});
