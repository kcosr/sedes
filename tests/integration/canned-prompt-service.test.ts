import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import { applyDatabaseMigrations } from "../../src/server/db/migrate.js";
import { initialMigration } from "../../src/server/db/migrations/001-initial.js";
import { seedSingleUserMigration } from "../../src/server/db/migrations/002-seed-single-user.js";
import { cannedPromptsMigration } from "../../src/server/db/migrations/077-canned-prompts.js";
import { CannedPromptRepository } from "../../src/server/db/repositories/canned-prompt-repository.js";
import { CannedPromptService } from "../../src/server/domain/canned-prompt-service.js";
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
  ]);
  database.exec(cannedPromptsMigration.sql);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const repository = new CannedPromptRepository(database);
  return {
    database,
    scope,
    repository,
    service: new CannedPromptService(repository),
  };
}

describe("canned prompt service", () => {
  it("creates, updates, reorders, and deletes one contiguous collection", () => {
    const value = fixture();
    try {
      expect(value.service.list(value.scope)).toEqual({
        revision: 0,
        items: [],
      });

      const first = value.service.create(
        value.scope,
        {
          title: "  Review changes  ",
          text: "Review the current changes.",
          expectedRevision: 0,
          mutationId: randomUUID(),
        },
        100,
      );
      expect(first).toMatchObject({ revision: 1, replayed: false });
      expect(first.items).toEqual([
        expect.objectContaining({
          title: "Review changes",
          text: "Review the current changes.",
          position: 0,
          createdAt: 100,
          updatedAt: 100,
        }),
      ]);

      const second = value.service.create(
        value.scope,
        {
          title: "Run tests",
          text: "Run the focused tests.",
          expectedRevision: 1,
          mutationId: randomUUID(),
        },
        200,
      );
      const firstId = second.items[0]!.id;
      const secondId = second.items[1]!.id;

      const updated = value.service.update(
        value.scope,
        firstId,
        {
          title: "Review thoroughly",
          text: "Review all current changes and report concrete defects.",
          expectedRevision: 2,
          mutationId: randomUUID(),
        },
        300,
      );
      expect(updated).toMatchObject({ revision: 3, replayed: false });
      expect(updated.items[0]).toMatchObject({
        id: firstId,
        title: "Review thoroughly",
        updatedAt: 300,
      });

      const reordered = value.service.reorder(
        value.scope,
        {
          promptIds: [secondId, firstId],
          expectedRevision: 3,
          mutationId: randomUUID(),
        },
        400,
      );
      expect(
        reordered.items.map(({ id, position }) => ({ id, position })),
      ).toEqual([
        { id: secondId, position: 0 },
        { id: firstId, position: 1 },
      ]);

      const deleted = value.service.delete(
        value.scope,
        secondId,
        { expectedRevision: 4, mutationId: randomUUID() },
        500,
      );
      expect(deleted).toMatchObject({ revision: 5, replayed: false });
      expect(deleted.items).toEqual([
        expect.objectContaining({ id: firstId, position: 0, updatedAt: 500 }),
      ]);
      expect(value.service.list(value.scope)).toEqual({
        revision: 5,
        items: deleted.items,
      });
    } finally {
      value.database.close();
    }
  });

  it("durably replays the original result and rejects mutation-id reuse", () => {
    const value = fixture();
    try {
      const mutationId = randomUUID();
      const request = {
        title: "Review",
        text: "Review the changes.",
        expectedRevision: 0,
        mutationId,
      } as const;
      const original = value.service.create(value.scope, request, 100);
      value.service.create(
        value.scope,
        {
          title: "Test",
          text: "Run tests.",
          expectedRevision: 1,
          mutationId: randomUUID(),
        },
        200,
      );

      expect(value.service.create(value.scope, request, 900)).toEqual({
        ...original,
        replayed: true,
      });
      expect(value.service.list(value.scope).revision).toBe(2);
      expect(() =>
        value.service.create(
          value.scope,
          { ...request, title: "Different" },
          900,
        ),
      ).toThrow(domainError("conflict"));
      expect(() =>
        value.service.delete(
          value.scope,
          original.items[0]!.id,
          { expectedRevision: 1, mutationId },
          900,
        ),
      ).toThrow(domainError("conflict"));
    } finally {
      value.database.close();
    }
  });

  it("enforces revision, permutation, capacity, and database constraints", () => {
    const value = fixture();
    try {
      const first = value.service.create(
        value.scope,
        {
          title: "Prompt 1",
          text: "One",
          expectedRevision: 0,
          mutationId: randomUUID(),
        },
        1,
      );
      expect(() =>
        value.service.create(
          value.scope,
          {
            title: "Stale",
            text: "Stale",
            expectedRevision: 0,
            mutationId: randomUUID(),
          },
          2,
        ),
      ).toThrow(domainError("conflict"));
      expect(() =>
        value.service.reorder(
          value.scope,
          {
            promptIds: [first.items[0]!.id, first.items[0]!.id],
            expectedRevision: 1,
            mutationId: randomUUID(),
          },
          2,
        ),
      ).toThrow(domainError("bad_request"));

      let revision = 1;
      for (let index = 2; index <= 32; index += 1) {
        value.service.create(
          value.scope,
          {
            title: `Prompt ${index}`,
            text: `Text ${index}`,
            expectedRevision: revision,
            mutationId: randomUUID(),
          },
          index,
        );
        revision += 1;
      }
      expect(value.service.list(value.scope).items).toHaveLength(32);
      expect(() =>
        value.service.create(
          value.scope,
          {
            title: "Prompt 33",
            text: "Too many",
            expectedRevision: 32,
            mutationId: randomUUID(),
          },
          33,
        ),
      ).toThrow(domainError("invalid_transition"));

      expect(() =>
        value.database
          .prepare(
            `
              UPDATE canned_prompts SET position = 0
              WHERE tenant_id = ? AND principal_id = ? AND position = 1
            `,
          )
          .run(value.scope.tenantId, value.scope.principalId),
      ).toThrow(/UNIQUE constraint failed/u);
    } finally {
      value.database.close();
    }
  });

  it("derives tenancy and principal ownership exclusively from request scope", () => {
    const value = fixture();
    try {
      const mutationId = randomUUID();
      const ownerResult = value.service.create(
        value.scope,
        {
          title: "Owner prompt",
          text: "Only the owner sees this.",
          expectedRevision: 0,
          mutationId,
        },
        10,
      );
      const otherScope: RequestScope = {
        tenantId: value.scope.tenantId,
        principalId: randomUUID(),
      };
      value.database
        .prepare(
          `
            INSERT INTO principals(tenant_id, id, kind, created_at)
            VALUES (?, ?, 'local_human', 1)
          `,
        )
        .run(otherScope.tenantId, otherScope.principalId);

      expect(value.service.list(otherScope)).toEqual({
        revision: 0,
        items: [],
      });
      expect(() =>
        value.service.update(
          otherScope,
          ownerResult.items[0]!.id,
          {
            title: "Foreign update",
            text: "Must fail.",
            expectedRevision: 0,
            mutationId: randomUUID(),
          },
          20,
        ),
      ).toThrow(domainError("not_found"));

      const otherResult = value.service.create(
        otherScope,
        {
          title: "Other prompt",
          text: "Principal-local content.",
          expectedRevision: 0,
          mutationId,
        },
        30,
      );
      expect(otherResult.items[0]!.id).not.toBe(ownerResult.items[0]!.id);
      expect(value.service.list(value.scope).items).toEqual(ownerResult.items);
      expect(value.service.list(otherScope).items).toEqual(otherResult.items);
    } finally {
      value.database.close();
    }
  });

  it("rejects invalid durable prompt and receipt values below the repository boundary", () => {
    const value = fixture();
    try {
      value.database
        .prepare(
          `
            INSERT INTO canned_prompt_collections(
              tenant_id, principal_id, revision, updated_at
            ) VALUES (?, ?, 0, 1)
          `,
        )
        .run(value.scope.tenantId, value.scope.principalId);
      const insertPrompt = value.database.prepare(
        `
          INSERT INTO canned_prompts(
            tenant_id, principal_id, id, title, prompt_text, position,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, 1, 1)
        `,
      );
      expect(() =>
        insertPrompt.run(
          value.scope.tenantId,
          value.scope.principalId,
          "00000000-0000-0000-8000-000000000000",
          "Review",
          "Review this.",
        ),
      ).toThrow(/CHECK constraint failed/u);
      expect(() =>
        insertPrompt.run(
          value.scope.tenantId,
          value.scope.principalId,
          randomUUID(),
          "   ",
          "Review this.",
        ),
      ).toThrow(/CHECK constraint failed/u);
      expect(() =>
        insertPrompt.run(
          value.scope.tenantId,
          value.scope.principalId,
          randomUUID(),
          "Review",
          "\n\t ",
        ),
      ).toThrow(/CHECK constraint failed/u);
      expect(() =>
        value.database
          .prepare(
            `
              INSERT INTO canned_prompt_mutation_receipts(
                tenant_id, principal_id, mutation_id, operation_kind,
                request_fingerprint, result_json, created_at
              ) VALUES (?, ?, 'not-a-uuid', 'create', ?, '{}', 1)
            `,
          )
          .run(value.scope.tenantId, value.scope.principalId, "a".repeat(64)),
      ).toThrow(/CHECK constraint failed/u);

      expect(() =>
        value.repository.create(value.scope, {
          title: "   ",
          text: "Review this.",
          expectedRevision: 0,
          mutationId: randomUUID(),
          now: 2,
        }),
      ).toThrow();
    } finally {
      value.database.close();
    }
  });
});
