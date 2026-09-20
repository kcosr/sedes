import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { workspaceDiffReviewsMigration } from "../../src/server/db/migrations/053-workspace-diff-reviews.js";

describe("workspace diff reviews migration", () => {
  it("creates normalized owner-scoped reviews with immutable identity and cascade", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      database.exec(`
        CREATE TABLE principals (tenant_id TEXT NOT NULL, id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, id)) STRICT;
        CREATE TABLE workspaces (tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL,
          id TEXT NOT NULL, PRIMARY KEY (tenant_id, id),
          UNIQUE (tenant_id, owner_principal_id, id)) STRICT;
        INSERT INTO principals VALUES ('tenant', 'principal');
        INSERT INTO workspaces VALUES ('tenant', 'principal', 'workspace');
      `);
      database.exec(workspaceDiffReviewsMigration.sql);
      database.exec(`INSERT INTO workspace_diff_reviews(
        tenant_id, owner_principal_id, workspace_id, root_id, id, comparison_key,
        repository_key, semantic, base_kind, base_identity, head_kind, head_identity,
        merge_base_commit_hash, fingerprint, title, summary, state, revision,
        created_at, updated_at
      ) VALUES ('tenant', 'principal', 'workspace', 'primary',
        '10000000-0000-4000-8000-000000000001', '${"a".repeat(64)}', 'repository',
        'direct', 'revision', 'base', 'working_tree', 'worktree-snapshot', NULL,
        'fingerprint-1234', '', '', 'open', 1, 1, 1);
      INSERT INTO workspace_diff_review_comments(
        tenant_id, owner_principal_id, review_id, id, file_identity, old_path,
        new_path, side, start_line, end_line, old_content_id, new_content_id,
        selected_text, selected_text_digest, hunk_fingerprint, body, state,
        revision, created_at, updated_at, deleted_at
      ) VALUES ('tenant', 'principal', '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000002', 'file', 'a.ts', 'a.ts', 'new',
        1, 1, 'old', 'new', 'text', '${"b".repeat(64)}', 'hunk', 'comment',
        'draft', 1, 1, 1, NULL);`);
      expect(() =>
        database.exec(
          "UPDATE workspace_diff_reviews SET fingerprint = 'different-fingerprint'",
        ),
      ).toThrow(/identity is immutable/i);
      expect(() =>
        database.exec(
          "UPDATE workspace_diff_review_comments SET start_line = 2, end_line = 2",
        ),
      ).toThrow(/anchors are immutable/i);
      database.exec(
        "DELETE FROM workspaces WHERE tenant_id = 'tenant' AND id = 'workspace'",
      );
      expect(
        database
          .prepare("SELECT count(*) AS count FROM workspace_diff_reviews")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
