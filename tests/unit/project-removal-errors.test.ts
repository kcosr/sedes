import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { projectRemovalAdmissionError } from "../../src/server/db/project-removal-errors.js";
import { projectRemovalMigration } from "../../src/server/db/migrations/099-project-removal.js";
import { projectsAndLocationsMigration } from "../../src/server/db/migrations/126-projects-and-locations.js";
import { sharedProjectTasksMigration } from "../../src/server/db/migrations/127-shared-project-tasks.js";
import { projectApiError } from "../../src/server/http/errors.js";

describe("project removal admission errors", () => {
  const raised = (sql: string) => [...new Set([...sql.matchAll(/RAISE\(ABORT, '([^']+)'\)/gu)].map(match => match[1]!))];
  const messages = [...new Set([
    ...raised(projectRemovalMigration.sql),
    ...raised(projectsAndLocationsMigration.sql),
    ...raised(sharedProjectTasksMigration.sql),
  ])];

  it("covers the bounded migration diagnostics", () => {
    expect(raised(projectRemovalMigration.sql)).toHaveLength(5);
    expect(raised(projectsAndLocationsMigration.sql)).toHaveLength(2);
    // Migration 127 restates two of migration 99's saved-work diagnostics.
    expect(raised(sharedProjectTasksMigration.sql)).toEqual([
      "The project was removed. Restore it before adding saved work.",
      "The project was removed. Restore it before moving saved work into it.",
    ]);
    expect(raised(projectRemovalMigration.sql)).toEqual(expect.arrayContaining(raised(sharedProjectTasksMigration.sql)));
  });

  const publicMessages = [
    ["The project was removed. Restore it before starting new work.",
      "This location was removed. Restore it before starting new work."],
    ["The project was removed. Restore it before moving a thread.",
      "This location was removed. Restore it before moving a thread."],
    ["The project was removed. Restore it before adding saved work.",
      "This project or location was removed. Restore it before adding saved work."],
    ["The project was removed. Restore it before moving saved work into it.",
      "This project or location was removed. Restore it before moving saved work into it."],
    ["The project was removed. Restore it before enabling scheduled work.",
      "This location was removed. Restore it before enabling scheduled work."],
    ["The project was removed. Restore it before adding or restoring its locations.",
      "The project was removed. Restore it before adding or restoring its locations."],
    ["The project still has active locations. Remove them before removing the project.",
      "The project still has active locations. Remove them before removing the project."],
  ];

  it("defines public wording for every migration diagnostic", () => {
    expect(publicMessages.map(([message]) => message).sort()).toEqual([...messages].sort());
  });

  it.each(publicMessages)("projects the actual trigger rejection: %s", (message, publicMessage) => {
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
        body: { error: { code: "invalid_transition", message: publicMessage, retryable: false } },
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
