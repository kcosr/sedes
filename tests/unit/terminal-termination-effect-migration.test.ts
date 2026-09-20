import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { terminalTerminationEffectMigration } from "../../src/server/db/migrations/086-terminal-termination-effect.js";

it("backfills scoped environment effects without inventing transport closure evidence", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE execution_environments(tenant_id TEXT, owner_principal_id TEXT, id TEXT, kind TEXT);
      CREATE TABLE terminals(terminal_id TEXT, tenant_id TEXT, owner_principal_id TEXT, environment_id TEXT, delete_mutation_id TEXT);
      INSERT INTO execution_environments VALUES ('tenant', 'owner', 'local', 'local'), ('tenant', 'owner', 'remote', 'ssh'), ('other', 'owner', 'local', 'ssh');
      INSERT INTO terminals VALUES ('local', 'tenant', 'owner', 'local', NULL), ('remote', 'tenant', 'owner', 'remote', 'pending');
    `);
    database.exec(terminalTerminationEffectMigration.sql);
    expect(database.prepare("SELECT terminal_id, termination_effect, delete_transport_closed FROM terminals ORDER BY terminal_id").all()).toEqual([
      { terminal_id: "local", termination_effect: "end_process", delete_transport_closed: null },
      { terminal_id: "remote", termination_effect: "disconnect_transport", delete_transport_closed: 0 },
    ]);
    expect(() => database.exec("UPDATE terminals SET termination_effect = 'end_process' WHERE terminal_id = 'remote'")).toThrow("Terminal termination effect is immutable");
    expect(() => database.exec("UPDATE terminals SET delete_transport_closed = 2")).toThrow();
  } finally {
    database.close();
  }
});
