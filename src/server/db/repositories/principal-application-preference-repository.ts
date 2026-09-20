import type Database from "better-sqlite3";
import type { ApplicationPreferences } from "../../../shared/protocol/application-preferences.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

type PreferenceRow = {
  readonly showOpenAIComposerSkills: 0 | 1;
  readonly revision: number;
};

export const DEFAULT_APPLICATION_PREFERENCES: ApplicationPreferences =
  Object.freeze({
    showOpenAIComposerSkills: false,
    revision: 0,
  });

export class PrincipalApplicationPreferenceRepository {
  constructor(readonly database: Database.Database) {}

  read(scope: RequestScope): ApplicationPreferences {
    const row = this.database
      .prepare(
        `
          SELECT
            show_openai_composer_skills AS showOpenAIComposerSkills,
            revision
          FROM principal_application_preferences
          WHERE tenant_id = ? AND owner_principal_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId) as PreferenceRow | undefined;
    return row
      ? {
          showOpenAIComposerSkills: row.showOpenAIComposerSkills === 1,
          revision: row.revision,
        }
      : DEFAULT_APPLICATION_PREFERENCES;
  }

  update(
    scope: RequestScope,
    input: {
      readonly showOpenAIComposerSkills: boolean;
      readonly expectedRevision: number;
      readonly now: number;
    },
  ): ApplicationPreferences {
    return this.database.transaction(() => {
      const current = this.read(scope);
      if (current.revision !== input.expectedRevision) {
        throw new DomainError(
          "conflict",
          "Application preferences changed before this update.",
        );
      }
      if (current.revision === 0) {
        try {
          this.database
            .prepare(
              `
                INSERT INTO principal_application_preferences(
                  tenant_id, owner_principal_id,
                  show_openai_composer_skills, revision,
                  created_at, updated_at
                )
                VALUES (?, ?, ?, 1, ?, ?)
              `,
            )
            .run(
              scope.tenantId,
              scope.principalId,
              input.showOpenAIComposerSkills ? 1 : 0,
              input.now,
              input.now,
            );
        } catch (error) {
          if (isUniqueConstraint(error)) {
            throw new DomainError(
              "conflict",
              "Application preferences changed before this update.",
              false,
              { cause: error },
            );
          }
          throw error;
        }
      } else {
        const result = this.database
          .prepare(
            `
              UPDATE principal_application_preferences
              SET show_openai_composer_skills = ?,
                  revision = revision + 1,
                  updated_at = max(updated_at, ?)
              WHERE tenant_id = ? AND owner_principal_id = ?
                AND revision = ?
            `,
          )
          .run(
            input.showOpenAIComposerSkills ? 1 : 0,
            input.now,
            scope.tenantId,
            scope.principalId,
            input.expectedRevision,
          );
        if (result.changes !== 1) {
          throw new DomainError(
            "conflict",
            "Application preferences changed before this update.",
          );
        }
      }
      return this.read(scope);
    })();
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      error.code === "SQLITE_CONSTRAINT_UNIQUE")
  );
}
