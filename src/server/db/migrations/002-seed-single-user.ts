export const seedSingleUserMigration = {
  version: 2,
  name: "seed_single_user_identity",
  sql: `
INSERT INTO tenants(id, created_at)
VALUES ('019196f7-a0a8-7bc4-a89b-8cf013978403', 0);

INSERT INTO principals(tenant_id, id, kind, created_at)
VALUES (
  '019196f7-a0a8-7bc4-a89b-8cf013978403',
  '019196f7-a0a8-7bc4-a89b-8cf013978404',
  'local_human',
  0
);

INSERT INTO execution_environments(
  tenant_id,
  owner_principal_id,
  id,
  kind,
  label,
  availability,
  diagnostic_code,
  revision,
  created_at,
  updated_at
)
VALUES (
  '019196f7-a0a8-7bc4-a89b-8cf013978403',
  '019196f7-a0a8-7bc4-a89b-8cf013978404',
  '019196f7-a0a8-7bc4-a89b-8cf013978405',
  'local',
  'Local',
  'available',
  NULL,
  0,
  0,
  0
);

INSERT INTO principal_generations(tenant_id, principal_id, inventory_generation)
VALUES (
  '019196f7-a0a8-7bc4-a89b-8cf013978403',
  '019196f7-a0a8-7bc4-a89b-8cf013978404',
  0
);
`,
} as const;
