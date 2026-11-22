import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

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
      CREATE TABLE IF NOT EXISTS executor_metadata(idx INTEGER PRIMARY KEY, data BLOB NOT NULL);
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
  const executions = new Map();
  const createdAt = new Map();
  const responseText = new Map();
  function step(index, type, status, payload, executionId, toolCall) {
    const time = { seconds: Math.floor(Date.now() / 1000) };
    if (!createdAt.has(index)) createdAt.set(index, time);
    const metadata = { created_at: createdAt.get(index), ...([3, 6].includes(status) ? { completed_at: time } : {}),
      ...(executionId ? { execution_id: executionId } : {}),
      ...(toolCall ? { tool_call: toolCall, tool_source: 1 } : {}) };
    write.run(index, type, status, encode(".gemini_coder.Step", { type, status, metadata, ...payload }));
  }
  return {
    begin(text) {
      const index = database.prepare("SELECT coalesce(max(idx) + 1, 0) AS next FROM steps").get().next;
      const executionId = randomUUID();
      executions.set(index + 1, executionId);
      step(index, 14, 3, { user_input: { items: [{ text }] } }, executionId);
      return index + 1;
    },
    response(index, text, stopReason = 0) {
      responseText.set(index, text);
      step(index, 15, stopReason ? 3 : 2, { planner_response: { response: text, stop_reason: stopReason } }, executions.get(index));
    },
    cancelAtPermission(index) {
      const executionId = executions.get(index);
      if (!executionId) throw new Error("Missing fixture execution");
      const toolCall = { id: "permission-command", name: "run_command",
        arguments_json: JSON.stringify({ CommandLine: "printf permission-check", Cwd: cwd, IsDaemon: false }) };
      database.transaction(() => {
        step(index, 15, 3, { planner_response: { response: responseText.get(index) ?? "", stop_reason: 2,
          tool_calls: [toolCall] } }, executionId);
        // Native generic tools keep their input/identity in metadata. A
        // cancelled command need not have produced a generic result payload.
        step(index + 1, 132, 6, { generic: {} }, executionId, toolCall);
        const receiptIndex = database.prepare("SELECT coalesce(max(idx) + 1, 0) AS next FROM executor_metadata").get().next;
        database.prepare("INSERT INTO executor_metadata VALUES (?, ?)").run(receiptIndex,
          encode(".exa.cortex_pb.ExecutorMetadata", { execution_id: executionId,
            last_step_idx: index + 1, termination_reason: 2 }));
      })();
    },
    close() { database.close(); },
  };
}
