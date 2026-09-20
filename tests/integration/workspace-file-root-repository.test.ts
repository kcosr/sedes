import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import { applyDatabaseMigrations } from "../../src/server/db/migrate.js";
import { initialMigration } from "../../src/server/db/migrations/001-initial.js";
import { seedSingleUserMigration } from "../../src/server/db/migrations/002-seed-single-user.js";
import { workspaceFileRootsMigration } from "../../src/server/db/migrations/030-workspace-file-roots.js";
import { workspaceFileLinkRootsMigration } from "../../src/server/db/migrations/035-workspace-file-link-roots.js";
import { removeWorkspaceFileLinkRootRecencyMigration } from "../../src/server/db/migrations/036-remove-workspace-file-link-root-recency.js";
import { WorkspaceFileRootRepository } from "../../src/server/db/repositories/workspace-file-root-repository.js";
import type { DomainError } from "../../src/server/domain/errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";

function domainError(code: DomainError["code"]) {
  return expect.objectContaining<Partial<DomainError>>({ code });
}

function fixture() {
  const database = openOverlayDatabaseConnection(":memory:");
  applyDatabaseMigrations(database, [
    initialMigration,
    seedSingleUserMigration,
    workspaceFileRootsMigration,
    workspaceFileLinkRootsMigration,
    removeWorkspaceFileLinkRootRecencyMigration,
  ]);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const environmentId = (
    database
      .prepare(
        `
          SELECT id FROM execution_environments
          WHERE tenant_id = ? AND owner_principal_id = ? AND kind = 'local'
        `,
      )
      .get(scope.tenantId, scope.principalId) as { readonly id: string }
  ).id;
  const workspaceId = randomUUID();
  database
    .prepare(
      `
        INSERT INTO workspaces(
          tenant_id, owner_principal_id, environment_id, id, canonical_path,
          display_name, availability, trust_state, revision, last_opened_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, '/projects/main', 'Main', 'available',
          'trusted', 0, 2, 2, 2)
      `,
    )
    .run(scope.tenantId, scope.principalId, environmentId, workspaceId);
  return {
    database,
    scope,
    workspaceId,
    repository: new WorkspaceFileRootRepository(database),
  };
}

describe("workspace file-root repository", () => {
  it("remembers hidden link roots without projecting them as attached roots", () => {
    const value = fixture();
    try {
      const remembered = value.repository.rememberLinkRoot(
        value.scope,
        value.workspaceId,
        "/worktrees/sibling",
        100,
      );
      expect(remembered).toMatchObject({
        workspaceId: value.workspaceId,
        canonicalPath: "/worktrees/sibling",
        createdAt: 100,
      });
      expect(remembered.rootId).toMatch(/^link-/);
      expect(value.repository.list(value.scope, value.workspaceId)).toEqual([]);
      expect(
        value.repository.findLinkRoot(
          value.scope,
          value.workspaceId,
          remembered.rootId,
        ),
      ).toEqual(remembered);

      expect(
        value.repository.rememberLinkRoot(
          value.scope,
          value.workspaceId,
          "/worktrees/sibling",
          90,
        ),
      ).toEqual(remembered);
      expect(
        value.repository.rememberLinkRoot(
          value.scope,
          value.workspaceId,
          "/worktrees/sibling",
          120,
        ),
      ).toEqual(remembered);

      const otherScope: RequestScope = {
        tenantId: value.scope.tenantId,
        principalId: "other-principal",
      };
      value.database
        .prepare(
          "INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 1)",
        )
        .run(otherScope.tenantId, otherScope.principalId);
      expect(
        value.repository.findLinkRoot(
          otherScope,
          value.workspaceId,
          remembered.rootId,
        ),
      ).toBeUndefined();
      expect(() =>
        value.repository.rememberLinkRoot(
          otherScope,
          value.workspaceId,
          "/worktrees/sibling",
          130,
        ),
      ).toThrow(domainError("not_found"));
    } finally {
      value.database.close();
    }
  });

  it("bounds remembered link roots per workspace", () => {
    const value = fixture();
    try {
      for (
        let index = 0;
        index < WorkspaceFileRootRepository.maximumLinkRootsPerWorkspace;
        index += 1
      ) {
        value.repository.rememberLinkRoot(
          value.scope,
          value.workspaceId,
          `/worktrees/sibling-${index}`,
          index,
        );
      }

      expect(() =>
        value.repository.rememberLinkRoot(
          value.scope,
          value.workspaceId,
          "/worktrees/over-limit",
          1_000,
        ),
      ).toThrow(domainError("conflict"));
    } finally {
      value.database.close();
    }
  });

  it("creates, lists, and removes supplemental roots with stable mutation replay", () => {
    const value = fixture();
    try {
      const created = value.repository.create(value.scope, value.workspaceId, {
        path: "/context/main",
        canonicalPath: "/context/main",
        displayLabel: "Agent context",
        resolvedDisplayLabel: "Agent context",
        mutationId: "create-context",
        now: 10,
      });
      expect(created).toMatchObject({
        workspaceId: value.workspaceId,
        canonicalPath: "/context/main",
        displayLabel: "Agent context",
        sortOrder: 0,
        availability: "available",
        revision: 1,
      });
      expect(created.rootId).not.toBe("primary");
      expect(
        value.repository.create(value.scope, value.workspaceId, {
          path: "/context/main",
          canonicalPath: "/context/main",
          displayLabel: "Agent context",
          resolvedDisplayLabel: "Agent context",
          mutationId: "create-context",
          now: 20,
        }),
      ).toEqual(created);

      expect(value.repository.list(value.scope, value.workspaceId)).toEqual([
        created,
      ]);
      expect(() =>
        value.repository.remove(
          value.scope,
          value.workspaceId,
          created.rootId,
          {
            expectedRevision: created.revision + 1,
            mutationId: "stale-remove-context",
            now: 40,
          },
        ),
      ).toThrow(domainError("conflict"));

      const removed = value.repository.remove(
        value.scope,
        value.workspaceId,
        created.rootId,
        {
          expectedRevision: created.revision,
          mutationId: "remove-context",
          now: 50,
        },
      );
      expect(removed).toEqual(created);
      expect(value.repository.list(value.scope, value.workspaceId)).toEqual([]);
      expect(
        value.repository.remove(
          value.scope,
          value.workspaceId,
          created.rootId,
          {
            expectedRevision: created.revision,
            mutationId: "remove-context",
            now: 60,
          },
        ),
      ).toEqual(created);
    } finally {
      value.database.close();
    }
  });

  it.each(["/projects", "/projects/main/nested"])("allows a supplemental root at %s", (canonicalPath) => {
    const value = fixture();
    try {
      const created = value.repository.create(value.scope, value.workspaceId, {
        path: canonicalPath,
        canonicalPath,
        displayLabel: "Projects",
        resolvedDisplayLabel: "Projects",
        mutationId: "primary-ancestor",
        now: 10,
      });

      expect(created).toMatchObject({
        canonicalPath,
        displayLabel: "Projects",
        availability: "available",
      });
      expect(value.repository.list(value.scope, value.workspaceId)).toEqual([
        created,
      ]);
    } finally {
      value.database.close();
    }
  });

  it("denies every foreign-tenant operation and receipt replay", () => {
    const value = fixture();
    try {
      const created = value.repository.create(value.scope, value.workspaceId, {
        path: "/context/main",
        canonicalPath: "/context/main",
        displayLabel: "Context",
        resolvedDisplayLabel: "Context",
        mutationId: "tenant-scoped-create",
        now: 10,
      });
      const foreignScope: RequestScope = {
        tenantId: "foreign-tenant",
        principalId: "foreign-principal",
      };
      value.database
        .prepare("INSERT INTO tenants(id, created_at) VALUES (?, 1)")
        .run(foreignScope.tenantId);
      value.database
        .prepare(
          "INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 1)",
        )
        .run(foreignScope.tenantId, foreignScope.principalId);

      expect(value.repository.list(foreignScope, value.workspaceId)).toEqual(
        [],
      );
      expect(() =>
        value.repository.get(foreignScope, value.workspaceId, created.rootId),
      ).toThrow(domainError("not_found"));
      expect(() =>
        value.repository.create(foreignScope, value.workspaceId, {
          path: "/context/main",
          canonicalPath: "/context/main",
          displayLabel: "Context",
          resolvedDisplayLabel: "Context",
          mutationId: "foreign-create",
          now: 20,
        }),
      ).toThrow(domainError("not_found"));
      expect(() =>
        value.repository.remove(
          foreignScope,
          value.workspaceId,
          created.rootId,
          {
            expectedRevision: created.revision,
            mutationId: "foreign-remove",
            now: 20,
          },
        ),
      ).toThrow(domainError("not_found"));
      expect(() =>
        value.repository.setAvailability(
          foreignScope,
          value.workspaceId,
          created.rootId,
          { availability: "unavailable", now: 20 },
        ),
      ).toThrow(domainError("not_found"));
      expect(
        value.repository.replayCreate(foreignScope, value.workspaceId, {
          mutationId: "tenant-scoped-create",
          path: "/context/main",
          displayLabel: "Context",
        }),
      ).toBeUndefined();
      expect(
        value.repository.replayCreate(foreignScope, value.workspaceId, {
          mutationId: "tenant-scoped-create",
          path: "/changed-without-leaking-receipt",
        }),
      ).toBeUndefined();
      expect(
        value.repository.get(value.scope, value.workspaceId, created.rootId),
      ).toEqual(created);
    } finally {
      value.database.close();
    }
  });

  it("updates observed availability once and preserves monotonically increasing timestamps", () => {
    const value = fixture();
    try {
      const created = value.repository.create(value.scope, value.workspaceId, {
        path: "/context/main",
        canonicalPath: "/context/main",
        displayLabel: "Context",
        resolvedDisplayLabel: "Context",
        mutationId: "availability-create",
        now: 100,
      });
      const unavailable = value.repository.setAvailability(
        value.scope,
        value.workspaceId,
        created.rootId,
        { availability: "unavailable", now: 90 },
      );
      expect(unavailable).toMatchObject({
        availability: "unavailable",
        revision: 2,
        updatedAt: 100,
      });
      expect(
        value.repository.setAvailability(
          value.scope,
          value.workspaceId,
          created.rootId,
          { availability: "unavailable", now: 110 },
        ),
      ).toEqual(unavailable);
      expect(
        value.repository.setAvailability(
          value.scope,
          value.workspaceId,
          created.rootId,
          { availability: "available", now: 120 },
        ),
      ).toMatchObject({
        availability: "available",
        revision: 3,
        updatedAt: 120,
      });
    } finally {
      value.database.close();
    }
  });

  it("denies wrong-principal access and receipt replay without leaking existence", () => {
    const value = fixture();
    try {
      const created = value.repository.create(value.scope, value.workspaceId, {
        path: "/context/main",
        canonicalPath: "/context/main",
        displayLabel: "Context",
        resolvedDisplayLabel: "Context",
        mutationId: "scoped-create",
        now: 10,
      });
      const otherScope: RequestScope = {
        tenantId: value.scope.tenantId,
        principalId: "other-principal",
      };
      value.database
        .prepare(
          "INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 1)",
        )
        .run(otherScope.tenantId, otherScope.principalId);
      expect(value.repository.list(otherScope, value.workspaceId)).toEqual([]);
      expect(() =>
        value.repository.get(otherScope, value.workspaceId, created.rootId),
      ).toThrow(domainError("not_found"));
      expect(() =>
        value.repository.create(otherScope, value.workspaceId, {
          path: "/other/context",
          canonicalPath: "/other/context",
          displayLabel: "Other context",
          resolvedDisplayLabel: "Other context",
          mutationId: "wrong-principal-create",
          now: 20,
        }),
      ).toThrow(domainError("not_found"));
      expect(() =>
        value.repository.remove(otherScope, value.workspaceId, created.rootId, {
          expectedRevision: created.revision,
          mutationId: "wrong-principal-remove",
          now: 20,
        }),
      ).toThrow(domainError("not_found"));
      expect(() =>
        value.repository.setAvailability(
          otherScope,
          value.workspaceId,
          created.rootId,
          { availability: "unavailable", now: 20 },
        ),
      ).toThrow(domainError("not_found"));
      expect(
        value.repository.replayCreate(otherScope, value.workspaceId, {
          mutationId: "scoped-create",
          path: "/context/main",
          displayLabel: "Context",
        }),
      ).toBeUndefined();
      expect(
        value.repository.replayCreate(otherScope, value.workspaceId, {
          mutationId: "scoped-create",
          path: "/changed-without-leaking-receipt",
        }),
      ).toBeUndefined();
    } finally {
      value.database.close();
    }
  });

  it("enforces the cap, canonical-path uniqueness, and case-insensitive label uniqueness", () => {
    const value = fixture();
    try {
      const first = value.repository.create(value.scope, value.workspaceId, {
        path: "/supplemental/0",
        canonicalPath: "/supplemental/0",
        displayLabel: "Context 0",
        resolvedDisplayLabel: "Context 0",
        mutationId: "create-0",
        now: 10,
      });
      for (const overlap of [
        {
          path: "/projects/main",
          label: "Equal primary",
          mutationId: "primary-equal",
        },
        {
          path: "/supplemental",
          label: "Supplemental ancestor",
          mutationId: "supplemental-ancestor",
        },
      ]) {
        expect(() =>
          value.repository.create(value.scope, value.workspaceId, {
            path: overlap.path,
            canonicalPath: overlap.path,
            displayLabel: overlap.label,
            resolvedDisplayLabel: overlap.label,
            mutationId: overlap.mutationId,
            now: 10,
          }),
        ).toThrow(domainError("conflict"));
      }
      expect(value.repository.list(value.scope, value.workspaceId)).toEqual([
        first,
      ]);
      expect(() =>
        value.repository.create(value.scope, value.workspaceId, {
          path: "/supplemental/0/nested",
          canonicalPath: "/supplemental/0/nested",
          displayLabel: "Nested context",
          resolvedDisplayLabel: "Nested context",
          mutationId: "supplemental-overlap",
          now: 10,
        }),
      ).toThrow(domainError("conflict"));
      expect(() =>
        value.repository.create(value.scope, value.workspaceId, {
          path: first.canonicalPath,
          canonicalPath: first.canonicalPath,
          displayLabel: "Different label",
          resolvedDisplayLabel: "Different label",
          mutationId: "duplicate-path",
          now: 11,
        }),
      ).toThrow(domainError("conflict"));
      expect(() =>
        value.repository.create(value.scope, value.workspaceId, {
          path: "/different/path",
          canonicalPath: "/different/path",
          displayLabel: "CONTEXT 0",
          resolvedDisplayLabel: "CONTEXT 0",
          mutationId: "duplicate-label",
          now: 12,
        }),
      ).toThrow(domainError("conflict"));
      expect(value.repository.list(value.scope, value.workspaceId)).toEqual([
        first,
      ]);
      for (let index = 1; index < 8; index += 1) {
        value.repository.create(value.scope, value.workspaceId, {
          path: `/supplemental/${index}`,
          canonicalPath: `/supplemental/${index}`,
          displayLabel: `Context ${index}`,
          resolvedDisplayLabel: `Context ${index}`,
          mutationId: `create-${index}`,
          now: 20 + index,
        });
      }
      expect(
        value.repository.list(value.scope, value.workspaceId),
      ).toHaveLength(8);
      expect(() =>
        value.repository.create(value.scope, value.workspaceId, {
          path: "/supplemental/8",
          canonicalPath: "/supplemental/8",
          displayLabel: "Context 8",
          resolvedDisplayLabel: "Context 8",
          mutationId: "create-8",
          now: 40,
        }),
      ).toThrow(domainError("conflict"));
      // Receipt replay precedes the now-failing cap/filesystem/policy checks.
      expect(
        value.repository.replayCreate(value.scope, value.workspaceId, {
          mutationId: "create-0",
          path: "/supplemental/0",
          displayLabel: "Context 0",
        }),
      ).toEqual(first);
      expect(() =>
        value.repository.replayCreate(value.scope, value.workspaceId, {
          mutationId: "create-0",
          path: "/supplemental/path-that-no-longer-exists",
          displayLabel: "Context 0",
        }),
      ).toThrow(domainError("conflict"));
    } finally {
      value.database.close();
    }
  });

  it("fingerprints the original request while storing its validated result", () => {
    const value = fixture();
    try {
      const created = value.repository.create(value.scope, value.workspaceId, {
        path: "/context/../context/main",
        canonicalPath: "/context/main",
        resolvedDisplayLabel: "main",
        mutationId: "default-label-create",
        now: 10,
      });
      expect(created).toMatchObject({
        canonicalPath: "/context/main",
        displayLabel: "main",
      });
      expect(
        value.repository.replayCreate(value.scope, value.workspaceId, {
          mutationId: "default-label-create",
          path: "/context/../context/main",
        }),
      ).toEqual(created);
      expect(() =>
        value.repository.replayCreate(value.scope, value.workspaceId, {
          mutationId: "default-label-create",
          path: "/context/main",
        }),
      ).toThrow(domainError("conflict"));
      expect(() =>
        value.repository.replayCreate(value.scope, value.workspaceId, {
          mutationId: "default-label-create",
          path: "/context/../context/main",
          displayLabel: "main",
        }),
      ).toThrow(domainError("conflict"));
    } finally {
      value.database.close();
    }
  });

  it("rejects a path used as another workspace's primary root", () => {
    const value = fixture();
    try {
      const environmentId = (
        value.database
          .prepare(
            "SELECT environment_id AS environmentId FROM workspaces WHERE tenant_id = ? AND id = ?",
          )
          .get(value.scope.tenantId, value.workspaceId) as {
          readonly environmentId: string;
        }
      ).environmentId;
      value.database
        .prepare(
          `
            INSERT INTO workspaces(
              tenant_id, owner_principal_id, environment_id, id,
              canonical_path, display_name, availability, trust_state,
              revision, last_opened_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, '/projects/other', 'Other', 'available',
              'trusted', 0, 3, 3, 3)
          `,
        )
        .run(
          value.scope.tenantId,
          value.scope.principalId,
          environmentId,
          randomUUID(),
        );
      expect(() =>
        value.repository.create(value.scope, value.workspaceId, {
          path: "/projects/other",
          canonicalPath: "/projects/other",
          displayLabel: "Other workspace",
          resolvedDisplayLabel: "Other workspace",
          mutationId: "cross-workspace",
          now: 10,
        }),
      ).toThrow(domainError("conflict"));
      expect(value.repository.list(value.scope, value.workspaceId)).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  it("rejects mutation-id reuse for changed input without committing partial state", () => {
    const value = fixture();
    try {
      value.repository.create(value.scope, value.workspaceId, {
        path: "/context/first",
        canonicalPath: "/context/first",
        displayLabel: "First",
        resolvedDisplayLabel: "First",
        mutationId: "reused-mutation",
        now: 10,
      });
      expect(() =>
        value.repository.create(value.scope, value.workspaceId, {
          path: "/context/second",
          canonicalPath: "/context/second",
          displayLabel: "Second",
          resolvedDisplayLabel: "Second",
          mutationId: "reused-mutation",
          now: 20,
        }),
      ).toThrow(domainError("conflict"));
      expect(
        value.repository.list(value.scope, value.workspaceId),
      ).toHaveLength(1);
    } finally {
      value.database.close();
    }
  });

  it("rejects cross-operation mutation-id reuse", () => {
    const value = fixture();
    try {
      const created = value.repository.create(value.scope, value.workspaceId, {
        path: "/context/first",
        canonicalPath: "/context/first",
        displayLabel: "First",
        resolvedDisplayLabel: "First",
        mutationId: "cross-operation-mutation",
        now: 10,
      });
      expect(() =>
        value.repository.remove(
          value.scope,
          value.workspaceId,
          created.rootId,
          {
            expectedRevision: created.revision,
            mutationId: "cross-operation-mutation",
            now: 20,
          },
        ),
      ).toThrow(domainError("conflict"));
      expect(
        value.repository.get(value.scope, value.workspaceId, created.rootId),
      ).toEqual(created);
    } finally {
      value.database.close();
    }
  });
});
