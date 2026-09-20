import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { projectRemovalAdmissionError } from "../../src/server/db/project-removal-errors.js";
import { projectRemovalMigration } from "../../src/server/db/migrations/099-project-removal.js";
import { projectApiError } from "../../src/server/http/errors.js";

describe("project removal admission errors", () => {
  const messages = [...new Set([...projectRemovalMigration.sql.matchAll(/RAISE\(ABORT, '([^']+)'\)/gu)].map(match => match[1]!))];

  it("covers the bounded migration diagnostics", () => {
    expect(messages).toHaveLength(5);
  });

  it.each(messages)("projects the actual trigger rejection: %s", message => {
    const database = new Database(":memory:");
    try {
      database.exec(`CREATE TABLE admission (id INTEGER);
        CREATE TRIGGER admission_guard BEFORE INSERT ON admission
        BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
      let rejected: unknown;
      try { database.prepare("INSERT INTO admission VALUES (1)").run(); }
      catch (error) { rejected = error; }
      expect(projectApiError(rejected)).toEqual({
        status: 400,
        body: { error: { code: "invalid_transition", message, retryable: false } },
      });
      expect(database.prepare("SELECT * FROM admission").all()).toEqual([]);
    } finally { database.close(); }
  });

  it.each([
    Object.assign(new Error("private database diagnostic"), { code: "SQLITE_CONSTRAINT_TRIGGER" }),
    Object.assign(new Error("The project was removed. Restore it before adding saved work."), { code: "SQLITE_CONSTRAINT_UNIQUE" }),
    new Error("The project was removed. Restore it before adding saved work."),
  ])("keeps unrelated errors private", error => {
    expect(projectRemovalAdmissionError(error)).toBeUndefined();
    expect(projectApiError(error)).toMatchObject({ status: 500, body: { error: { code: "internal_error", message: "The request could not be completed." } } });
  });
});
