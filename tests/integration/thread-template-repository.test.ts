import { describe, expect, it } from "vitest";
import { ThreadTemplateRepository } from "../../src/server/db/repositories/thread-template-repository.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import type { DomainError } from "../../src/server/domain/errors.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const agentId = "30000000-0000-4000-8000-000000000001";

function errorCode(code: DomainError["code"]) {
  return expect.objectContaining({ code });
}

function selection(name = "Reviewer") {
  return {
    workspaceId,
    targetId: "local-primary",
    executionWorkspace: { kind: "direct" as const },
    agentId,
    capturedAgentName: name,
    capturedWorkspaceName: "Sedes",
    capturedTargetName: "Local Pi",
  };
}

describe("ThreadTemplateRepository", () => {
  it("permits duplicate names and pages them deterministically", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new ThreadTemplateRepository(current.database);
      const first = repository.create(current.scope, {
        name: "Same name",
        selection: selection(),
        assertReferences: () => undefined,
        now: 1_000,
      });
      const second = repository.create(current.scope, {
        name: "Same name",
        selection: selection(),
        assertReferences: () => undefined,
        now: 2_000,
      });
      const page = repository.listPage(current.scope, { pageSize: 1 });
      expect(page.nextCursor).toBeDefined();
      const next = repository.listPage(current.scope, {
        pageSize: 1,
        cursor: page.nextCursor,
      });
      expect([page.items[0]!.id, next.items[0]!.id].sort()).toEqual(
        [first.id, second.id].sort(),
      );
      expect(() =>
        repository.listPage(current.scope, {
          pageSize: 2,
          cursor: page.nextCursor,
        }),
      ).toThrow(errorCode("cursor_invalid"));
    } finally {
      current.database.close();
    }
  });

  it("revision-fences update and delete and runs reference checks atomically", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new ThreadTemplateRepository(current.database);
      expect(() =>
        repository.create(current.scope, {
          name: "Rejected",
          selection: selection(),
          assertReferences: () => {
            throw new Error("reference_changed");
          },
          now: 1_000,
        }),
      ).toThrow("reference_changed");
      expect(
        repository.listPage(current.scope, { pageSize: 10 }).items,
      ).toEqual([]);

      const created = repository.create(current.scope, {
        name: "Original",
        selection: selection(),
        assertReferences: () => undefined,
        now: 2_000,
      });
      expect(() =>
        repository.update(current.scope, created.id, {
          expectedRevision: 0,
          name: "Must roll back",
          selection: selection("Changed label"),
          assertReferences: () => {
            throw new Error("reference_changed");
          },
          now: 3_000,
        }),
      ).toThrow("reference_changed");
      expect(repository.get(current.scope, created.id)).toMatchObject({
        name: "Original",
        revision: 0,
      });
      const updated = repository.update(current.scope, created.id, {
        expectedRevision: 0,
        name: "Updated",
        selection: selection("Current Reviewer"),
        assertReferences: () => undefined,
        now: 4_000,
      });
      expect(updated).toMatchObject({
        name: "Updated",
        capturedAgentName: "Current Reviewer",
        revision: 1,
      });
      expect(() =>
        repository.delete(current.scope, created.id, { expectedRevision: 0 }),
      ).toThrow(errorCode("conflict"));
      repository.delete(current.scope, created.id, { expectedRevision: 1 });
      expect(repository.find(current.scope, created.id)).toBeUndefined();
    } finally {
      current.database.close();
    }
  });

  it("preserves a template after its Saved Agent is deleted", () => {
    const current = savedAgentDatabase();
    try {
      const agents = new SavedAgentRepository(current.database);
      agents.create(current.scope, {
        id: agentId,
        name: "Reviewer",
        description: "",
        backendTypeId: "pi",
        backendOverridesSchemaVersion: 1,
        backendOverrides: [],
        sedesTools: null,
        now: 1_000,
      });
      const templates = new ThreadTemplateRepository(current.database);
      const created = templates.create(current.scope, {
        name: "Durable recipe",
        selection: selection(),
        assertReferences: () =>
          agents.assertRevision(current.scope, agentId, 0),
        now: 2_000,
      });
      agents.delete(current.scope, agentId, { expectedRevision: 0 });
      expect(templates.get(current.scope, created.id)).toMatchObject({
        agentId,
        capturedAgentName: "Reviewer",
      });
    } finally {
      current.database.close();
    }
  });

  it("isolates identical template ids by tenant and principal scope", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new ThreadTemplateRepository(current.database);
      const foreignScope = {
        tenantId: current.scope.tenantId,
        principalId: "foreign-principal",
      };
      current.database
        .prepare(
          "INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', ?)",
        )
        .run(foreignScope.tenantId, foreignScope.principalId, 1_000);
      const id = "10000000-0000-4000-8000-000000000001";
      repository.create(current.scope, {
        id,
        name: "Current",
        selection: selection(),
        assertReferences: () => undefined,
        now: 1_000,
      });
      repository.create(foreignScope, {
        id,
        name: "Foreign",
        selection: selection(),
        assertReferences: () => undefined,
        now: 1_000,
      });
      expect(repository.get(current.scope, id).name).toBe("Current");
      expect(repository.get(foreignScope, id).name).toBe("Foreign");
      expect(() =>
        repository.update(
          { ...foreignScope, principalId: "missing-principal" },
          id,
          {
            expectedRevision: 0,
            name: "Denied",
            selection: selection(),
            assertReferences: () => undefined,
            now: 2_000,
          },
        ),
      ).toThrow(errorCode("not_found"));
    } finally {
      current.database.close();
    }
  });
});
