import type { DatabaseMigration } from "../migrate.js";

/** Durable principal-owned reviews keyed by resolved comparison evidence. */
export const workspaceDiffReviewsMigration: DatabaseMigration = {
  version: 53,
  name: "workspace-diff-reviews",
  sql: `
CREATE TABLE workspace_diff_reviews (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_id TEXT NOT NULL CHECK (length(root_id) BETWEEN 1 AND 128),
  id TEXT NOT NULL CHECK (
    length(id) = 36 AND id = lower(id) AND id NOT GLOB '*[^0-9a-f-]*'
    AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'
  ),
  comparison_key TEXT NOT NULL CHECK (
    length(comparison_key) = 64 AND comparison_key NOT GLOB '*[^0-9a-f]*'
  ),
  repository_key TEXT NOT NULL CHECK (
    length(CAST(repository_key AS BLOB)) BETWEEN 1 AND 256
  ),
  semantic TEXT NOT NULL CHECK (semantic IN ('direct', 'merge_base')),
  base_kind TEXT NOT NULL CHECK (base_kind IN ('revision', 'index', 'working_tree')),
  base_identity TEXT NOT NULL CHECK (
    length(CAST(base_identity AS BLOB)) BETWEEN 1 AND 256
  ),
  head_kind TEXT NOT NULL CHECK (head_kind IN ('revision', 'index', 'working_tree')),
  head_identity TEXT NOT NULL CHECK (
    length(CAST(head_identity AS BLOB)) BETWEEN 1 AND 256
  ),
  merge_base_commit_hash TEXT CHECK (
    merge_base_commit_hash IS NULL OR (
      length(merge_base_commit_hash) IN (40, 64)
      AND merge_base_commit_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  fingerprint TEXT NOT NULL CHECK (
    length(CAST(fingerprint AS BLOB)) BETWEEN 16 AND 128
  ),
  title TEXT NOT NULL DEFAULT '' CHECK (length(CAST(title AS BLOB)) <= 512),
  summary TEXT NOT NULL DEFAULT '' CHECK (length(CAST(summary AS BLOB)) <= 8192),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (tenant_id, owner_principal_id, workspace_id, comparison_key),
  FOREIGN KEY (tenant_id, owner_principal_id, workspace_id)
    REFERENCES workspaces(tenant_id, owner_principal_id, id) ON DELETE CASCADE,
  CHECK (
    (semantic = 'direct' AND merge_base_commit_hash IS NULL)
    OR (semantic = 'merge_base' AND merge_base_commit_hash IS NOT NULL)
  )
) STRICT;

CREATE INDEX workspace_diff_reviews_by_repository
  ON workspace_diff_reviews(
    tenant_id, owner_principal_id, workspace_id, root_id,
    repository_key, updated_at DESC, id
  );

CREATE TRIGGER workspace_diff_review_identity_immutable
BEFORE UPDATE OF workspace_id, root_id, comparison_key, repository_key,
  semantic, base_kind, base_identity, head_kind, head_identity,
  merge_base_commit_hash, fingerprint
ON workspace_diff_reviews
BEGIN
  SELECT RAISE(ABORT, 'Diff review identity is immutable');
END;

CREATE TABLE workspace_diff_review_comments (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (
    length(id) = 36 AND id = lower(id) AND id NOT GLOB '*[^0-9a-f-]*'
    AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'
  ),
  file_identity TEXT NOT NULL CHECK (
    length(CAST(file_identity AS BLOB)) BETWEEN 1 AND 256
  ),
  old_path TEXT CHECK (
    old_path IS NULL OR (
      length(CAST(old_path AS BLOB)) BETWEEN 1 AND 4096
      AND instr(old_path, char(0)) = 0
    )
  ),
  new_path TEXT CHECK (
    new_path IS NULL OR (
      length(CAST(new_path AS BLOB)) BETWEEN 1 AND 4096
      AND instr(new_path, char(0)) = 0
    )
  ),
  side TEXT NOT NULL CHECK (side IN ('old', 'new')),
  start_line INTEGER NOT NULL CHECK (start_line BETWEEN 1 AND 2147483647),
  end_line INTEGER NOT NULL CHECK (end_line BETWEEN start_line AND 2147483647),
  old_content_id TEXT CHECK (
    old_content_id IS NULL OR length(CAST(old_content_id AS BLOB)) BETWEEN 1 AND 256
  ),
  new_content_id TEXT CHECK (
    new_content_id IS NULL OR length(CAST(new_content_id AS BLOB)) BETWEEN 1 AND 256
  ),
  selected_text TEXT NOT NULL CHECK (
    length(CAST(selected_text AS BLOB)) <= 65536
  ),
  selected_text_digest TEXT NOT NULL CHECK (
    length(selected_text_digest) = 64
    AND selected_text_digest NOT GLOB '*[^0-9a-f]*'
  ),
  hunk_fingerprint TEXT NOT NULL CHECK (
    length(CAST(hunk_fingerprint AS BLOB)) BETWEEN 1 AND 256
  ),
  body TEXT NOT NULL CHECK (
    length(CAST(body AS BLOB)) BETWEEN 1 AND 65536
    AND body GLOB '*[^ \t\r\n]*'
  ),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (
    state IN ('draft', 'published', 'resolved', 'outdated', 'unplaced')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= updated_at),
  PRIMARY KEY (tenant_id, owner_principal_id, review_id, id),
  FOREIGN KEY (tenant_id, owner_principal_id, review_id)
    REFERENCES workspace_diff_reviews(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE,
  CHECK (old_path IS NOT NULL OR new_path IS NOT NULL),
  CHECK (
    (side = 'old' AND old_content_id IS NOT NULL)
    OR (side = 'new' AND new_content_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX workspace_diff_review_comments_ordered
  ON workspace_diff_review_comments(
    tenant_id, owner_principal_id, review_id, deleted_at,
    created_at, id
  );

CREATE TRIGGER workspace_diff_review_comment_anchor_immutable
BEFORE UPDATE OF review_id, file_identity, old_path, new_path, side,
  start_line, end_line, old_content_id, new_content_id, selected_text,
  selected_text_digest, hunk_fingerprint
ON workspace_diff_review_comments
BEGIN
  SELECT RAISE(ABORT, 'Diff review comment anchors are immutable');
END;

CREATE TABLE workspace_diff_reviewed_files (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  file_identity TEXT NOT NULL CHECK (
    length(CAST(file_identity AS BLOB)) BETWEEN 1 AND 256
  ),
  file_path TEXT NOT NULL CHECK (
    length(CAST(file_path AS BLOB)) BETWEEN 1 AND 4096
    AND instr(file_path, char(0)) = 0
  ),
  content_fingerprint TEXT NOT NULL CHECK (
    length(CAST(content_fingerprint AS BLOB)) BETWEEN 16 AND 256
  ),
  reviewed INTEGER NOT NULL CHECK (reviewed IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, review_id, file_identity),
  FOREIGN KEY (tenant_id, owner_principal_id, review_id)
    REFERENCES workspace_diff_reviews(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX workspace_diff_reviewed_files_ordered
  ON workspace_diff_reviewed_files(
    tenant_id, owner_principal_id, review_id, reviewed, file_path, file_identity
  );

CREATE TABLE workspace_diff_review_mutation_receipts (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 262144
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE CASCADE
) STRICT;
`,
};
