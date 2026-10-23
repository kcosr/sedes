import { describe, expect, it } from "vitest";
import { applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { automaticModelRetryMigration } from "../../src/server/db/migrations/155-automatic-model-retry.js";
import { PrincipalApplicationPreferenceRepository } from "../../src/server/db/repositories/principal-application-preference-repository.js";
import { PrincipalApplicationPreferenceService } from "../../src/server/domain/principal-application-preference-service.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("automatic model retry account preference", () => {
  it("enables retry for existing preferences without changing their revision or skill visibility", () => {
    const current = savedAgentDatabase(154);
    try {
      current.database.prepare(`
        INSERT INTO principal_application_preferences (
          tenant_id, owner_principal_id, show_openai_composer_skills,
          revision, created_at, updated_at
        ) VALUES (?, ?, 1, 7, 100, 110)
      `).run(current.scope.tenantId, current.scope.principalId);
      applyDatabaseMigrations(
        current.database,
        backendNormalizedMigrations.filter((migration) => migration.version <= automaticModelRetryMigration.version),
      );
      expect(new PrincipalApplicationPreferenceRepository(current.database).read(current.scope)).toEqual({
        showOpenAIComposerSkills: true,
        autoRetryModelFailures: true,
        revision: 7,
      });
      expect(() => current.database.prepare(`
        UPDATE principal_application_preferences SET auto_retry_model_failures = 2
      `).run()).toThrow(/CHECK constraint failed/);
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      current.database.close();
    }
  });

  it("keeps defaults, updates, and revision conflicts within the principal and tenant", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new PrincipalApplicationPreferenceRepository(current.database);
      const service = new PrincipalApplicationPreferenceService({ repository, now: () => 200 });
      const foreignPrincipal = { ...current.scope, principalId: "other-principal" };
      const foreignTenant = { ...current.scope, tenantId: "other-tenant" };
      current.database.prepare("INSERT INTO tenants(id, created_at) VALUES (?, 100)").run(foreignTenant.tenantId);
      const insertPrincipal = current.database.prepare(`
        INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', 100)
      `);
      insertPrincipal.run(foreignPrincipal.tenantId, foreignPrincipal.principalId);
      insertPrincipal.run(foreignTenant.tenantId, foreignTenant.principalId);
      const defaults = { showOpenAIComposerSkills: false, autoRetryModelFailures: true, revision: 0 };
      expect(service.read(current.scope)).toEqual(defaults);
      expect(service.update(current.scope, {
        showOpenAIComposerSkills: true,
        autoRetryModelFailures: false,
        expectedRevision: 0,
      })).toEqual({ showOpenAIComposerSkills: true, autoRetryModelFailures: false, revision: 1 });
      for (const otherScope of [foreignPrincipal, foreignTenant]) {
        expect(service.read(otherScope)).toEqual(defaults);
        expect(() => service.update(otherScope, {
          showOpenAIComposerSkills: false,
          autoRetryModelFailures: true,
          expectedRevision: 1,
        })).toThrow(/changed before this update/);
        expect(service.read(otherScope)).toEqual(defaults);
      }
      expect(() => service.update(current.scope, {
        showOpenAIComposerSkills: false,
        autoRetryModelFailures: true,
        expectedRevision: 0,
      })).toThrow(/changed before this update/);
      expect(service.read(current.scope)).toEqual({ showOpenAIComposerSkills: true, autoRetryModelFailures: false, revision: 1 });
      expect(service.update(current.scope, {
        showOpenAIComposerSkills: true,
        autoRetryModelFailures: true,
        expectedRevision: 1,
      })).toEqual({ showOpenAIComposerSkills: true, autoRetryModelFailures: true, revision: 2 });
    } finally {
      current.database.close();
    }
  });
});
