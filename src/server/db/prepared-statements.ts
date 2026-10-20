import type Database from "better-sqlite3";

/**
 * A defensive per-connection bound. Callers cache only static SQL or a
 * bounded set of shapes, so a well-formed process stays far below it; beyond
 * it, statements are prepared without caching rather than growing memory.
 */
export const MAXIMUM_CACHED_STATEMENTS_PER_CONNECTION = 2_048;

// Statements belong to their connection: a reopened database is a new
// connection with its own cache, and a closed connection's statements are
// released with it.
const cachedStatements = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/**
 * Prepares static SQL once per connection. better-sqlite3 has no statement
 * cache, and compiling a small indexed read often costs more than running it.
 *
 * Only pass static SQL or a bounded set of shapes, never SQL that embeds
 * values or an unbounded placeholder count. Callers must not iterate a cached
 * statement or change its modes (`pluck`, `raw`, `expand`, `safeIntegers`):
 * every execution binds its parameters afresh and observes the connection's
 * current transaction, so `get`, `all` and `run` are safe to share.
 */
export function prepareCached(database: Database.Database, sql: string): Database.Statement {
  if (!database.open) {
    cachedStatements.delete(database);
    return database.prepare(sql);
  }
  let statements = cachedStatements.get(database);
  if (!statements) {
    statements = new Map();
    cachedStatements.set(database, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = database.prepare(sql);
    if (statements.size < MAXIMUM_CACHED_STATEMENTS_PER_CONNECTION) statements.set(sql, statement);
  }
  return statement;
}
