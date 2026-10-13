import type { DatabaseMigration } from "../migrate.js";

export const shownImagesMigration: DatabaseMigration = {
  version: 143, name: "shown-images", verifyDatabaseIntegrity: true,
  sql: `
CREATE TABLE application_publication_clocks (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  last_published_at INTEGER NOT NULL CHECK(last_published_at >= 0),
  PRIMARY KEY(tenant_id, owner_principal_id, thread_id),
  FOREIGN KEY(tenant_id, owner_principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE CASCADE
) STRICT;
INSERT INTO application_publication_clocks(tenant_id,owner_principal_id,thread_id,last_published_at)
  SELECT tenant_id,owner_principal_id,thread_id,
    MAX(CAST(round(unixepoch(json_extract(descriptor_json, '$.createdAt'), 'subsec') * 1000) AS INTEGER))
  FROM html_page_revisions GROUP BY tenant_id,owner_principal_id,thread_id;
CREATE TABLE shown_images (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL CHECK(length(invocation_id) BETWEEN 1 AND 256),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64),
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256) = 64),
  artifact_id TEXT NOT NULL, image_json TEXT NOT NULL CHECK(json_valid(image_json)),
  anchor_turn_id TEXT NOT NULL, anchor_json TEXT NOT NULL CHECK(json_valid(anchor_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(tenant_id, owner_principal_id, thread_id, invocation_id),
  FOREIGN KEY(tenant_id, owner_principal_id, thread_id)
    REFERENCES application_threads(tenant_id, owner_principal_id, id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id, owner_principal_id, artifact_id)
    REFERENCES output_image_artifacts(tenant_id, owner_principal_id, id) ON DELETE CASCADE,
  CHECK(json_type(anchor_json, '$.turnId') IS 'text' AND json_extract(anchor_json, '$.turnId') = anchor_turn_id),
  CHECK(json_type(image_json, '$.artifactId') IS 'text' AND json_extract(image_json, '$.artifactId') = artifact_id)
) STRICT;
CREATE INDEX shown_images_turn ON shown_images(tenant_id, owner_principal_id, thread_id, anchor_turn_id);
CREATE INDEX shown_images_artifact ON shown_images(tenant_id, owner_principal_id, artifact_id);
CREATE TRIGGER shown_images_immutable BEFORE UPDATE ON shown_images
BEGIN SELECT RAISE(ABORT, 'Shown image receipts are immutable'); END;
`,
};
