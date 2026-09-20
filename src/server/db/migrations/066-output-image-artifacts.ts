import type { DatabaseMigration } from "../migrate.js";

/**
 * Durable, immutable image output captured from a backend item. Provider paths,
 * native payloads, and image bytes are deliberately absent from SQLite.
 */
export const outputImageArtifactsMigration: DatabaseMigration = {
  version: 66,
  name: "output-image-artifacts",
  verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE output_image_blobs (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 = lower(sha256)
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, sha256),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE output_image_artifacts (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  application_thread_id TEXT NOT NULL CHECK (
    length(application_thread_id) BETWEEN 1 AND 128
  ),
  id TEXT NOT NULL CHECK (
    length(id) = 36
    AND id = lower(id)
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) GLOB '[1-8]'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) GLOB '[89ab]'
    AND substr(id, 24, 1) = '-'
  ),
  publication_key_hash TEXT NOT NULL CHECK (
    length(publication_key_hash) = 64
    AND publication_key_hash = lower(publication_key_hash)
    AND publication_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  media_type TEXT NOT NULL CHECK (
    media_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
  blob_sha256 TEXT NOT NULL CHECK (
    length(blob_sha256) = 64
    AND blob_sha256 = lower(blob_sha256)
    AND blob_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, id),
  UNIQUE (
    tenant_id, owner_principal_id, application_thread_id,
    publication_key_hash
  ),
  FOREIGN KEY (
    tenant_id, owner_principal_id, application_thread_id
  ) REFERENCES application_threads(
    tenant_id, owner_principal_id, id
  ) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, owner_principal_id, blob_sha256)
    REFERENCES output_image_blobs(
      tenant_id, owner_principal_id, sha256
    ) ON DELETE RESTRICT
) STRICT;

CREATE INDEX output_image_artifacts_blob
  ON output_image_artifacts(
    tenant_id, owner_principal_id, blob_sha256, id
  );

CREATE TRIGGER output_image_blobs_immutable
BEFORE UPDATE ON output_image_blobs
BEGIN
  SELECT RAISE(ABORT, 'Output image blobs are immutable');
END;

CREATE TRIGGER output_image_artifacts_immutable
BEFORE UPDATE ON output_image_artifacts
BEGIN
  SELECT RAISE(ABORT, 'Output image artifacts are immutable');
END;
`,
};
