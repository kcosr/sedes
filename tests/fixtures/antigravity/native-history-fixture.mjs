import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { messages } = JSON.parse(readFileSync(new URL("../../../src/server/backends/antigravity/native-projection.json", import.meta.url), "utf8"));

function varint(value) {
  const bytes = [];
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    bytes.push(value ? byte | 128 : byte);
  } while (value);
  return Buffer.from(bytes);
}

function encode(type, value) {
  return Buffer.concat(Object.entries(value).flatMap(([name, member]) => {
    const field = messages[type]?.find(candidate => candidate.name === name);
    if (!field) throw new Error(`Unknown fixture field ${type}.${name}`);
    return (field.label === 3 ? member : [member]).flatMap(item => {
      if (typeof item === "number") return [varint(field.number * 8), varint(item)];
      const bytes = field.type === 11 ? encode(field.typeName, item) : Buffer.from(item, "utf8");
      return [varint(field.number * 8 + 2), varint(bytes.length), bytes];
    });
  }));
}

export function openFixtureHistory(geminiDirectory, sessionId, cwd) {
  const directory = path.join(geminiDirectory, "antigravity-cli", "conversations");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = new Database(path.join(directory, `${sessionId}.db`));
  try {
    database.pragma("journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_meta(cascade_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS trajectory_metadata_blob(id TEXT PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER,
        has_subtrajectory INTEGER, step_format INTEGER, step_payload BLOB);
    `);
    database.prepare("INSERT OR IGNORE INTO trajectory_meta VALUES (?)").run(sessionId);
    database.prepare("INSERT OR IGNORE INTO trajectory_metadata_blob VALUES ('main', ?)").run(
      encode(".exa.cortex_pb.CortexTrajectoryMetadata", { workspaces: [{ workspace_folder_absolute_uri: pathToFileURL(cwd).href }] }),
    );
  } catch (error) {
    database.close();
    throw error;
  }
  const write = database.prepare(`
    INSERT INTO steps VALUES (?, ?, ?, 0, 0, ?)
    ON CONFLICT(idx) DO UPDATE SET status = excluded.status, step_payload = excluded.step_payload
  `);
  function step(index, type, status, payload) {
    const time = { seconds: Math.floor(Date.now() / 1000) };
    const metadata = { created_at: time, ...(status === 3 ? { completed_at: time } : {}) };
    write.run(index, type, status, encode(".gemini_coder.Step", { type, status, metadata, ...payload }));
  }
  return {
    begin(text) {
      const index = database.prepare("SELECT coalesce(max(idx) + 1, 0) AS next FROM steps").get().next;
      step(index, 14, 3, { user_input: { items: [{ text }] } });
      return index + 1;
    },
    response(index, text, stopReason = 0) {
      step(index, 15, stopReason ? 3 : 2, { planner_response: { response: text, stop_reason: stopReason } });
    },
    close() { database.close(); },
  };
}
