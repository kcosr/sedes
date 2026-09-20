import type { DatabaseMigration } from "../migrate.js";
import { annotatedContext, isNonWhitespace } from "./038-context-excerpts.js";

const attachmentParentColumns = `
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  attachment_id TEXT NOT NULL CHECK (
    length(attachment_id) = 36
    AND attachment_id = lower(attachment_id)
    AND attachment_id NOT GLOB '*[^0-9a-f-]*'
    AND substr(attachment_id, 9, 1) = '-'
    AND substr(attachment_id, 14, 1) = '-'
    AND substr(attachment_id, 19, 1) = '-'
    AND substr(attachment_id, 24, 1) = '-'
  )
`;

const attachmentForeignKey = (
  principalColumn: string,
  threadColumn: string,
) => `
  FOREIGN KEY (tenant_id, ${principalColumn}, ${threadColumn}, attachment_id)
    REFERENCES composer_attachments(
      tenant_id, owner_principal_id, origin_thread_id, id
    )
    ON DELETE CASCADE
`;

/**
 * Composer uploads are immutable principal-owned objects. Ordered owner links
 * snapshot attachment identity at every durable input boundary. Native staged
 * paths are deterministic ephemeral delivery state and never become authority.
 */
export const composerAttachmentsMigration: DatabaseMigration = {
  version: 51,
  name: "composer-attachments",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE attachment_blobs (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 26214400),
  storage_key TEXT NOT NULL CHECK (
    length(CAST(storage_key AS BLOB)) BETWEEN 1 AND 512
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, sha256),
  UNIQUE (tenant_id, owner_principal_id, storage_key),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE composer_attachments (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (
    length(id) = 36
    AND id = lower(id)
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 24, 1) = '-'
  ),
  origin_thread_id TEXT NOT NULL CHECK (length(origin_thread_id) BETWEEN 1 AND 128),
  blob_sha256 TEXT NOT NULL CHECK (
    length(blob_sha256) = 64 AND blob_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  display_name TEXT NOT NULL CHECK (
    length(CAST(display_name AS BLOB)) BETWEEN 1 AND 512
  ),
  media_type TEXT NOT NULL CHECK (
    media_type IN (
      'application/octet-stream', 'image/png', 'image/jpeg',
      'image/gif', 'image/webp'
    )
  ),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'image')),
  image_width INTEGER CHECK (image_width IS NULL OR image_width BETWEEN 1 AND 16384),
  image_height INTEGER CHECK (image_height IS NULL OR image_height BETWEEN 1 AND 16384),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  unowned_expires_at INTEGER NOT NULL CHECK (unowned_expires_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (tenant_id, owner_principal_id, origin_thread_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, origin_thread_id, id, blob_sha256
  ),
  FOREIGN KEY (tenant_id, owner_principal_id, blob_sha256)
    REFERENCES attachment_blobs(tenant_id, owner_principal_id, sha256)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_principal_id, origin_thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id)
    ON DELETE CASCADE,
  CHECK (
    (kind = 'image' AND media_type <> 'application/octet-stream'
      AND ((image_width IS NULL AND image_height IS NULL)
        OR (image_width IS NOT NULL AND image_height IS NOT NULL)))
    OR (kind = 'file' AND media_type = 'application/octet-stream'
      AND image_width IS NULL AND image_height IS NULL)
  )
) STRICT;

CREATE INDEX composer_attachments_blob
  ON composer_attachments(tenant_id, owner_principal_id, blob_sha256, id);
CREATE INDEX composer_attachments_unowned_expiry
  ON composer_attachments(unowned_expires_at, tenant_id, owner_principal_id, id);

CREATE TRIGGER attachment_blobs_immutable
BEFORE UPDATE ON attachment_blobs
BEGIN
  SELECT RAISE(ABORT, 'Attachment blobs are immutable');
END;

CREATE TRIGGER composer_attachments_immutable
BEFORE UPDATE ON composer_attachments
BEGIN
  SELECT RAISE(ABORT, 'Composer attachments are immutable');
END;

CREATE TABLE draft_composer_attachments (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  ${attachmentParentColumns},
  PRIMARY KEY (tenant_id, principal_id, thread_id, ordinal),
  UNIQUE (tenant_id, principal_id, thread_id, attachment_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_drafts(tenant_id, principal_id, thread_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ${attachmentForeignKey("principal_id", "thread_id")}
) STRICT;

CREATE TABLE stash_composer_attachments (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  stash_id TEXT NOT NULL,
  ${attachmentParentColumns},
  PRIMARY KEY (tenant_id, principal_id, thread_id, stash_id, ordinal),
  UNIQUE (tenant_id, principal_id, thread_id, stash_id, attachment_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id, stash_id)
    REFERENCES prompt_stashes(tenant_id, principal_id, thread_id, id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ${attachmentForeignKey("principal_id", "thread_id")}
) STRICT;

CREATE TABLE queued_input_composer_attachments (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  queued_input_id TEXT NOT NULL,
  ${attachmentParentColumns},
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id,
    queued_input_id, ordinal
  ),
  UNIQUE (
    tenant_id, owner_principal_id, application_thread_id,
    queued_input_id, attachment_id
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id, queued_input_id
  ) REFERENCES queued_inputs(
    tenant_id, owner_principal_id, application_thread_id, id
  ) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ${attachmentForeignKey("owner_principal_id", "application_thread_id")}
) STRICT;

CREATE TABLE creation_attempt_composer_attachments (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  ${attachmentParentColumns},
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id, attempt_id, ordinal
  ),
  UNIQUE (
    tenant_id, owner_principal_id, application_thread_id,
    attempt_id, attachment_id
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id, attempt_id
  ) REFERENCES conversation_creation_attempts(
    tenant_id, owner_principal_id, application_thread_id, attempt_id
  ) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ${attachmentForeignKey("owner_principal_id", "application_thread_id")}
) STRICT;

CREATE TABLE conversation_operation_composer_attachments (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  ${attachmentParentColumns},
  PRIMARY KEY (tenant_id, principal_id, mutation_id, ordinal),
  UNIQUE (tenant_id, principal_id, mutation_id, attachment_id),
  FOREIGN KEY (tenant_id, principal_id, mutation_id)
    REFERENCES mutation_receipts(tenant_id, principal_id, mutation_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id)
    ON DELETE RESTRICT,
  ${attachmentForeignKey("principal_id", "thread_id")}
) STRICT;

CREATE TABLE submitted_operation_composer_attachments (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  ${attachmentParentColumns},
  PRIMARY KEY (
    tenant_id, owner_principal_id, application_thread_id, operation_id, ordinal
  ),
  UNIQUE (
    tenant_id, owner_principal_id, application_thread_id,
    operation_id, attachment_id
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id, operation_id
  ) REFERENCES submission_completion_observations(
    tenant_id, owner_principal_id, application_thread_id, operation_id
  ) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ${attachmentForeignKey("owner_principal_id", "application_thread_id")}
) STRICT;

CREATE TABLE attachment_materializations (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  materialization_identity TEXT NOT NULL CHECK (
    length(materialization_identity) = 68
    AND materialization_identity GLOB 'mat_[0-9a-f]*'
    AND substr(materialization_identity, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  execution_environment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  environment_authority_revision INTEGER NOT NULL CHECK (
    environment_authority_revision >= 0
  ),
  application_thread_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL CHECK (
    length(blob_sha256) = 64 AND blob_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 0 AND 26214400),
  agent_path TEXT NOT NULL CHECK (
    length(CAST(agent_path AS BLOB)) BETWEEN 1 AND 4096
    AND instr(agent_path, char(0)) = 0
  ),
  state TEXT NOT NULL CHECK (
    state IN ('ready', 'missing', 'abandoned', 'released')
  ),
  verified_at INTEGER NOT NULL CHECK (verified_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id, owner_principal_id, materialization_identity),
  UNIQUE (
    tenant_id, owner_principal_id, execution_environment_id, workspace_id,
    environment_authority_revision, application_thread_id, attachment_id,
    blob_sha256
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, execution_environment_id, workspace_id
  ) REFERENCES workspaces(
    tenant_id, owner_principal_id, environment_id, id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id
  ) REFERENCES application_threads(
    tenant_id, owner_principal_id, id
  ) ON DELETE CASCADE,
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id, attachment_id,
    blob_sha256
  ) REFERENCES composer_attachments(
    tenant_id, owner_principal_id, origin_thread_id, id, blob_sha256
  ) ON DELETE CASCADE
) STRICT;

CREATE INDEX attachment_materializations_lookup
  ON attachment_materializations(
    tenant_id, owner_principal_id, application_thread_id, attachment_id,
    state, updated_at
  );

CREATE TRIGGER attachment_materializations_thread_scope_insert
BEFORE INSERT ON attachment_materializations
WHEN NOT EXISTS (
  SELECT 1 FROM application_threads AS thread
  WHERE thread.tenant_id = NEW.tenant_id
    AND thread.owner_principal_id = NEW.owner_principal_id
    AND thread.id = NEW.application_thread_id
    AND thread.environment_id = NEW.execution_environment_id
    AND thread.workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'Attachment materialization thread scope mismatch');
END;

CREATE TRIGGER attachment_materializations_thread_scope_update
BEFORE UPDATE OF tenant_id, owner_principal_id, execution_environment_id,
  workspace_id, application_thread_id ON attachment_materializations
WHEN NOT EXISTS (
  SELECT 1 FROM application_threads AS thread
  WHERE thread.tenant_id = NEW.tenant_id
    AND thread.owner_principal_id = NEW.owner_principal_id
    AND thread.id = NEW.application_thread_id
    AND thread.environment_id = NEW.execution_environment_id
    AND thread.workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'Attachment materialization thread scope mismatch');
END;

DROP TRIGGER prompt_stashes_content_insert;
DROP TRIGGER prompt_stashes_content_update;
DROP TRIGGER queued_inputs_content_insert;
DROP TRIGGER queued_inputs_content_update;
DROP TRIGGER conversation_creation_attempts_content_insert;
DROP TRIGGER conversation_creation_attempts_content_update;

CREATE TRIGGER prompt_stashes_content_insert
BEFORE INSERT ON prompt_stashes
WHEN length(NEW.text) = 0
  AND NEW.selected_skill_id IS NULL
  AND json_array_length(NEW.context_excerpts_json) = 0
  AND NOT EXISTS (
    SELECT 1 FROM stash_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.principal_id = NEW.principal_id
      AND link.thread_id = NEW.thread_id
      AND link.stash_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'Prompt stash content is required');
END;

CREATE TRIGGER prompt_stashes_content_update
BEFORE UPDATE OF text, selected_skill_id, context_excerpts_json
ON prompt_stashes
WHEN length(NEW.text) = 0
  AND NEW.selected_skill_id IS NULL
  AND json_array_length(NEW.context_excerpts_json) = 0
  AND NOT EXISTS (
    SELECT 1 FROM stash_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.principal_id = NEW.principal_id
      AND link.thread_id = NEW.thread_id
      AND link.stash_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'Prompt stash content is required');
END;

CREATE TRIGGER queued_inputs_content_insert
BEFORE INSERT ON queued_inputs
WHEN NOT (${isNonWhitespace("NEW.text")})
  AND NEW.selected_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.context_excerpts_json")}
  AND NOT EXISTS (
    SELECT 1 FROM queued_input_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.owner_principal_id = NEW.owner_principal_id
      AND link.application_thread_id = NEW.application_thread_id
      AND link.queued_input_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'Queued input content is required');
END;

CREATE TRIGGER queued_inputs_content_update
BEFORE UPDATE OF text, selected_skill_id, context_excerpts_json
ON queued_inputs
WHEN NOT (${isNonWhitespace("NEW.text")})
  AND NEW.selected_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.context_excerpts_json")}
  AND NOT EXISTS (
    SELECT 1 FROM queued_input_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.owner_principal_id = NEW.owner_principal_id
      AND link.application_thread_id = NEW.application_thread_id
      AND link.queued_input_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'Queued input content is required');
END;

CREATE TRIGGER conversation_creation_attempts_content_insert
BEFORE INSERT ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (${isNonWhitespace("NEW.initial_input_text")})
  AND NEW.initial_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.initial_context_excerpts_json")}
  AND NOT EXISTS (
    SELECT 1 FROM creation_attempt_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.owner_principal_id = NEW.owner_principal_id
      AND link.application_thread_id = NEW.application_thread_id
      AND link.attempt_id = NEW.attempt_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Conversation creation input content is required');
END;

CREATE TRIGGER conversation_creation_attempts_content_update
BEFORE UPDATE OF initial_input_text, initial_skill_id,
  initial_context_excerpts_json ON conversation_creation_attempts
WHEN NEW.initial_input_text IS NOT NULL
  AND NOT (${isNonWhitespace("NEW.initial_input_text")})
  AND NEW.initial_skill_id IS NULL
  AND NOT ${annotatedContext("NEW.initial_context_excerpts_json")}
  AND NOT EXISTS (
    SELECT 1 FROM creation_attempt_composer_attachments AS link
    WHERE link.tenant_id = NEW.tenant_id
      AND link.owner_principal_id = NEW.owner_principal_id
      AND link.application_thread_id = NEW.application_thread_id
      AND link.attempt_id = NEW.attempt_id
  )
BEGIN
  SELECT RAISE(ABORT, 'Conversation creation input content is required');
END;
`,
};
