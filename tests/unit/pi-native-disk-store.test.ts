import { randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiNativeForkInput } from "../../src/server/backends/pi/native/port.js";
import { PiNativeDiskStore } from "../../src/server/backends/pi/native/host/disk-store.js";
import { PI_MANAGED_INPUT_MARKER, signPiManagedOperation, type PiManagedOperation } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";
import { parsePiNativeEntry, type PiNativeEntry } from "../../src/server/backends/pi/native/rpc/pi-rpc-wire.js";
import { acquirePiSessionWriterLock } from "../../src/server/backends/pi/pi-session-writer-lock.js";
import {
  PI_NATIVE_TOOL_MARKER, PI_NATIVE_TOOL_RESULT_MARKER, signPiNativeToolCall, signPiNativeToolResult,
  type PiNativeToolCall, type PiNativeToolResult,
} from "../../src/server/backends/pi/native/tool-provenance.js";

const timestamp = "2026-10-26T00:00:00.000Z";
const authenticationKey = randomBytes(32);
const inheritedSettings: PiNativeForkInput["inheritedSettings"] = { toolAccess: "read_only" };
const message = (id: string, parentId: string | null, text: string): PiNativeEntry => ({
  type: "message", id, parentId, timestamp, message: { role: "user", content: text, timestamp: 1 },
});
const custom = (id: string, parentId: string | null, data: unknown): PiNativeEntry => parsePiNativeEntry({
  type: "custom", id, parentId, timestamp, customType: "extension.test", data,
});

describe("detached Pi native disk store", () => {
  let root: string;
  let cwd: string;
  let sessionDirectory: string;
  let store: PiNativeDiskStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-native-disk-")));
    cwd = path.join(root, "project");
    sessionDirectory = path.join(root, "sessions");
    await mkdir(cwd);
    store = new PiNativeDiskStore({ sessionDirectory, authenticationKey });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  async function native(id: string, entries: readonly PiNativeEntry[], name = id, sessionCwd = cwd): Promise<string> {
    await mkdir(sessionDirectory, { recursive: true });
    const file = path.join(sessionDirectory, `${name}.jsonl`);
    await writeFile(file, [
      { type: "session", version: 3, id, timestamp, cwd: sessionCwd }, ...entries,
    ].map((item) => JSON.stringify(item)).join("\n") + "\n");
    return file;
  }

  it("uses Pi's actual cwd directory by default and does not create it for reads", async () => {
    const agentDirectory = path.join(root, "agent");
    const shared = new PiNativeDiskStore({ agentDirectory, authenticationKey });
    const expected = path.join(agentDirectory, "sessions", `--${cwd.slice(1).replace(/[/\\:]/g, "-")}--`);
    expect(shared.getSessionDirectory(cwd)).toBe(expected);
    await expect(shared.listSessions({ cwd })).resolves.toEqual({ sessions: [] });
    await expect(stat(agentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const identity = await shared.create({ cwd, sessionId: "native-id", operationId: "new" });
    expect(path.dirname(identity.sessionFile)).toBe(expected);
    const history = await shared.readHistory(identity);
    expect(history.operations).toEqual([]);
    expect(history.inheritance).toBe("none");
    expect(history.inheritedEntryIds).toEqual([]);
    expect(history.leafId).toBe(history.entries.at(-1)?.id);
    shared.close();
  });

  it("publishes complete native files and replays exactly without rewriting history", async () => {
    const input = { cwd, sessionId: "session-one", operationId: "create-one", title: "First title" };
    const first = await store.create(input);
    const snapshot = await store.readHistory(first);
    await appendFile(first.sessionFile, JSON.stringify(message("later", snapshot.leafId, "later input")) + "\n");
    const before = await readFile(first.sessionFile);
    const restarted = new PiNativeDiskStore({ sessionDirectory, authenticationKey });
    await expect(restarted.create(input)).resolves.toEqual(first);
    expect(await readFile(first.sessionFile)).toEqual(before);
    await expect(restarted.create({ ...input, title: "Changed" })).rejects.toMatchObject({ code: "pi_native_operation_conflict", delivery: "not_sent" });
    await expect(restarted.create({ ...input, operationId: "another" })).rejects.toMatchObject({ code: "pi_native_operation_conflict" });
    expect((await readdir(sessionDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect((await stat(first.sessionFile)).mode & 0o777).toBe(0o600);
    restarted.close();
  });

  it("serializes duplicate reservations and rejects an existing native session without a proof", async () => {
    const input = { cwd, sessionId: "same", operationId: "create-same" };
    const [first, second] = await Promise.all([store.create(input), store.create(input)]);
    expect(second).toEqual(first);
    const file = await native("unowned", []);
    const before = await readFile(file);
    await expect(store.create({ cwd, sessionId: "unowned", operationId: "claim" })).rejects.toMatchObject({ code: "pi_native_operation_conflict" });
    expect(await readFile(file)).toEqual(before);
  });

  it("binds replay proofs to the native header and private host key", async () => {
    const input = { cwd, sessionId: "proof", operationId: "proof-create" };
    const identity = await store.create(input);
    const foreign = new PiNativeDiskStore({ sessionDirectory, authenticationKey: randomBytes(32) });
    await expect(foreign.create(input)).rejects.toMatchObject({ code: "pi_native_operation_marker_invalid" });
    const rows = (await readFile(identity.sessionFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    rows[0].parentSession = "/untrusted/source.jsonl";
    await writeFile(identity.sessionFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await expect(store.create(input)).rejects.toMatchObject({ code: "pi_native_operation_marker_invalid" });
    foreign.close();
  });

  it("rejects tampered initial metadata even when the operation marker is intact", async () => {
    const input = { cwd, sessionId: "proof", operationId: "proof-create", title: "Original" };
    const identity = await store.create(input);
    const rows = (await readFile(identity.sessionFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    rows.find((row) => row.type === "session_info").name = "Forged";
    await writeFile(identity.sessionFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await expect(store.create(input)).rejects.toMatchObject({ code: "pi_native_operation_marker_invalid" });
  });

  it("shares the SDK writer lease while keeping detached reads and proven replay available", async () => {
    const input = { cwd, sessionId: "locked", operationId: "create-locked" };
    const identity = await store.create(input);
    const lease = await acquirePiSessionWriterLock(identity.sessionFile);
    try {
      await expect(store.readHistory(identity)).resolves.toMatchObject(identity);
      await expect(store.create(input)).resolves.toEqual(identity);
      await unlink(identity.sessionFile);
      await expect(store.create(input)).rejects.toMatchObject({ code: "pi_native_session_publish_failed", delivery: "not_sent" });
      await expect(stat(identity.sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await lease.release();
    }
    await expect(store.create(input)).resolves.toEqual(identity);
  });

  it("never replaces a concurrent creator's file and converges on exact replay", async () => {
    await mkdir(sessionDirectory);
    const other = new PiNativeDiskStore({ sessionDirectory, authenticationKey });
    const input = { cwd, sessionId: "raced", operationId: "race-create", title: "Same" };
    const outcomes = await Promise.allSettled([store.create(input), other.create(input)]);
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
    const first = await store.create(input);
    await expect(other.create(input)).resolves.toEqual(first);
    const entries = await readdir(sessionDirectory);
    expect(entries.filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    other.close();
  });

  it("reads full trees but forks exactly through the selected ancestor boundary", async () => {
    const entries = [message("one", null, "first"), custom("metadata", "one", { preserved: [1, 2] }),
      message("selected", "metadata", "second"), message("other-branch", "one", "unrelated"),
      message("after", "selected", "excluded")];
    const sourceSessionFile = await native("source", entries);
    expect((await store.readHistory({ cwd, sessionId: "source", sessionFile: sourceSessionFile })).entries).toEqual(entries);
    const input = { cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile, sourceEntryId: "selected", childSessionId: "child", operationId: "fork-one", title: "Fork" };
    const identity = await store.fork(input);
    const history = await store.readHistory(identity);
    expect(history.entries.slice(0, 3)).toEqual(entries.slice(0, 3));
    expect(history.inheritance).toBe("verified");
    expect(history.inheritedEntryIds).toEqual(["one", "metadata", "selected"]);
    expect(history.parentSessionId).toBe("source");
    expect(history.entries.map((entry) => entry.id)).not.toContain("after");
    expect(history.entries.map((entry) => entry.id)).not.toContain("other-branch");
    const header = JSON.parse((await readFile(identity.sessionFile, "utf8")).split("\n")[0]!);
    expect(header.parentSession).toBe(sourceSessionFile);
    await unlink(sourceSessionFile);
    await expect(store.fork(input)).resolves.toEqual(identity);
    await expect(store.fork({ ...input, sourceEntryId: "one" })).rejects.toMatchObject({ code: "pi_native_operation_conflict" });
  });

  it("marks native forks with untrusted ancestry as unknown instead of charging inherited work", async () => {
    const sessionFile = await native("external", [message("one", null, "copied")]);
    const rows = (await readFile(sessionFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    rows[0].parentSession = "/native/source.jsonl";
    await writeFile(sessionFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const history = await store.readHistory({ cwd, sessionId: "external", sessionFile });
    expect(history.inheritance).toBe("unknown");
    expect(history.inheritedEntryIds).toEqual([]);
    expect(history.parentSessionId).toBeUndefined();
  });

  it("captures current fork settings after the selected history and binds each setting to replay", async () => {
    const sourceSessionFile = await native("source", [
      parsePiNativeEntry({ type: "model_change", id: "old-model", parentId: null, timestamp, provider: "old", modelId: "old-model" }),
      parsePiNativeEntry({ type: "thinking_level_change", id: "old-thinking", parentId: "old-model", timestamp, thinkingLevel: "high" }),
      message("selected", "old-thinking", "completed input"),
    ]);
    const input: PiNativeForkInput = { cwd, sourceSessionId: "source", sourceSessionFile, sourceEntryId: "selected", childSessionId: "child", operationId: "fork-settings",
      inheritedSettings: { model: { provider: "current", id: "current-model" }, thinkingLevel: "low", toolAccess: "ask" } };
    const child = await store.fork(input);
    const history = await store.readHistory(child);
    expect(history.inheritedEntryIds).toEqual(["old-model", "old-thinking", "selected"]);
    expect(history.entries.slice(3, 5)).toMatchObject([
      { type: "model_change", parentId: "selected", provider: "current", modelId: "current-model" },
      { type: "thinking_level_change", thinkingLevel: "low" },
    ]);
    expect(history.entries[4]?.parentId).toBe(history.entries[3]?.id);
    expect(history.entries.at(-1)?.parentId).toBe(history.entries[4]?.id);
    await expect(store.reconcileFork(input)).resolves.toEqual(child);
    for (const changed of [
      { ...input.inheritedSettings, model: { provider: "changed", id: "current-model" } },
      { ...input.inheritedSettings, thinkingLevel: "off" as const },
      { ...input.inheritedSettings, toolAccess: "full" as const },
    ]) {
      await expect(store.reconcileFork({ ...input, inheritedSettings: changed })).rejects.toMatchObject({ code: "pi_native_operation_conflict" });
    }
  });

  it("reconciles the immutable child without reading missing or malformed source history", async () => {
    const sourceSessionFile = await native("source", [message("selected", null, "completed input")]);
    const input: PiNativeForkInput = { cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile,
      sourceEntryId: "selected", childSessionId: "child", operationId: "fork-recovery" };
    const child = await store.fork(input);
    const before = await readFile(child.sessionFile);
    await writeFile(sourceSessionFile, "not a native session\n");
    await expect(store.reconcileFork(input)).resolves.toEqual(child);
    await expect(store.fork(input)).resolves.toEqual(child);
    await unlink(sourceSessionFile);
    await expect(store.reconcileFork(input)).resolves.toEqual(child);
    expect(await readFile(child.sessionFile)).toEqual(before);
  });

  it("reports an absent fork reservation without touching its source or creating files", async () => {
    const input: PiNativeForkInput = { cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile: path.join(sessionDirectory, "missing.jsonl"),
      sourceEntryId: "selected", childSessionId: "child", operationId: "not-yet-forked" };
    await expect(store.reconcileFork(input)).resolves.toBeNull();
    await expect(stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await native("source", [message("selected", null, "completed input")], "missing");
    const child = await store.fork(input);
    const rows = (await readFile(child.sessionFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    rows[1].message.content = "changed history";
    await writeFile(child.sessionFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await expect(store.reconcileFork(input)).rejects.toMatchObject({ code: "pi_native_operation_marker_invalid" });
  });

  it("does not trust an edited inherited ID list", async () => {
    const sourceSessionFile = await native("source", [message("one", null, "copied")]);
    const input = { cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile, sourceEntryId: "one", childSessionId: "child", operationId: "fork" };
    const identity = await store.fork(input);
    const rows = (await readFile(identity.sessionFile, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    rows.find((row) => row.customType === "sedes.native.session_operation.v1").data.inheritedEntryIds = [];
    await writeFile(identity.sessionFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect((await store.readHistory(identity)).inheritance).toBe("unknown");
    await expect(store.fork(input)).rejects.toMatchObject({ code: "pi_native_operation_marker_invalid" });
  });

  it("re-attests only authenticated input provenance for the fork's native session", async () => {
    const operation: PiManagedOperation = { input: {
      operationId: "input-one", mutationId: "mutation-one", reconciliationToken: "receipt-one",
      fingerprint: "a".repeat(64), mode: "submit", text: "first",
    }, phase: "accepted", userEntryId: "one" };
    const proof = parsePiNativeEntry({ type: "custom", id: "proof", parentId: "one", timestamp, customType: PI_MANAGED_INPUT_MARKER,
      data: { version: 1, operation, authentication: signPiManagedOperation("source", operation, authenticationKey) } });
    const forgedOperation = { ...operation, input: { ...operation.input, operationId: "forged" } };
    const forged = parsePiNativeEntry({ ...proof, id: "forged", parentId: "proof", data: {
      version: 1, operation: forgedOperation, authentication: "a".repeat(43),
    } });
    const sourceSessionFile = await native("source", [message("one", null, "first"), proof, forged]);
    const source = await store.readHistory({ cwd, sessionId: "source", sessionFile: sourceSessionFile });
    expect(source.operations).toEqual([operation]);
    const identity = await store.fork({ cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile, sourceEntryId: "forged", childSessionId: "child", operationId: "fork-provenance" });
    const history = await store.readHistory(identity);
    expect(history.operations).toEqual([operation]);
    expect(history.entries[1]).not.toEqual(proof);
    expect(history.entries[2]).toEqual(forged);
  });

  it("preserves authenticated nested tool calls and results across forks without elevating forged evidence", async () => {
    const outer: PiNativeToolCall = { toolCallId: "outer", toolName: "codemode", assistantEntryId: "assistant", userEntryId: "user",
      sourceInfo: { source: "extension", path: "/managed/extension.ts" }, managed: "codemode", arguments: { code: "await tools.read({path:'a'})" } };
    const inner: PiNativeToolCall = { toolCallId: "inner", toolName: "read", assistantEntryId: "assistant", userEntryId: "user",
      sourceInfo: { source: "builtin", path: "builtin:read" }, parentToolCallId: "outer", arguments: { path: "a" } };
    const orphan: PiNativeToolCall = { ...inner, assistantEntryId: "absent" };
    const result: PiNativeToolResult = { toolCallId: "inner", assistantEntryId: "assistant", userEntryId: "user", content: [{ type: "text", text: "file content" }], isError: false };
    const orphanResult: PiNativeToolResult = { ...result, assistantEntryId: "absent" };
    const callEntry = (id: string, parentId: string, call: PiNativeToolCall, authentication = signPiNativeToolCall("source", call, authenticationKey)) => parsePiNativeEntry({
      type: "custom", id, parentId, timestamp, customType: PI_NATIVE_TOOL_MARKER, data: { version: 1, call, authentication },
    });
    const resultEntry = (id: string, parentId: string, value: PiNativeToolResult) => parsePiNativeEntry({
      type: "custom", id, parentId, timestamp, customType: PI_NATIVE_TOOL_RESULT_MARKER,
      data: { version: 1, result: value, authentication: signPiNativeToolResult("source", value, authenticationKey) },
    });
    const entries = [message("user", null, "read a"), parsePiNativeEntry({ type: "message", id: "assistant", parentId: "user", timestamp,
      message: { role: "assistant", timestamp: 1, provider: "test", model: "test", api: "openai-completions", usage: {}, stopReason: "toolUse",
        content: [{ type: "toolCall", id: "outer", name: "codemode", arguments: outer.arguments }] } }),
    callEntry("outer-proof", "assistant", outer), callEntry("inner-proof", "outer-proof", inner), resultEntry("result-proof", "inner-proof", result),
    callEntry("forged-proof", "result-proof", { ...inner, toolCallId: "forged" }, "a".repeat(43)),
    callEntry("orphan-proof", "forged-proof", orphan), resultEntry("orphan-result", "orphan-proof", orphanResult)];
    const sourceSessionFile = await native("source", entries);
    const source = await store.readHistory({ cwd, sessionId: "source", sessionFile: sourceSessionFile });
    expect(source.toolCalls).toEqual([outer, inner]);
    expect(source.toolResults).toEqual([result]);
    const copiedFile = await native("untrusted-copy", entries);
    expect(await store.readHistory({ cwd, sessionId: "untrusted-copy", sessionFile: copiedFile })).toMatchObject({ toolCalls: [], toolResults: [] });
    const child = await store.fork({ cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile, sourceEntryId: "orphan-result", childSessionId: "child", operationId: "tool-fork" });
    const history = await store.readHistory(child);
    expect(history.toolCalls).toEqual([outer, inner]);
    expect(history.toolResults).toEqual([result]);
    expect(history.entries.slice(2, 5)).not.toEqual(entries.slice(2, 5));
    expect(history.entries.slice(5, 8)).toEqual(entries.slice(5, 8));
    await expect(store.fork({ cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile, sourceEntryId: "orphan-result", childSessionId: "child", operationId: "tool-fork" })).resolves.toEqual(child);
  });

  it("does not give rejected input evidence fresh authority in a fork", async () => {
    const operation: PiManagedOperation = { input: {
      operationId: "orphan-input", mutationId: "orphan-mutation", reconciliationToken: "orphan-receipt",
      fingerprint: "b".repeat(64), mode: "submit", text: "absent input",
    }, phase: "accepted", userEntryId: "missing-user" };
    const proof = parsePiNativeEntry({ type: "custom", id: "orphan-proof", parentId: "first", timestamp,
      customType: PI_MANAGED_INPUT_MARKER, data: { version: 1, operation,
        authentication: signPiManagedOperation("source", operation, authenticationKey) } });
    const sourceSessionFile = await native("source", [message("first", null, "retained input"), proof]);
    expect((await store.readHistory({ cwd, sessionId: "source", sessionFile: sourceSessionFile })).operations).toEqual([]);
    const child = await store.fork({ cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile, sourceEntryId: "orphan-proof", childSessionId: "child", operationId: "orphan-fork" });
    const initial = await store.readHistory(child);
    expect(initial.entries[1]).toEqual(proof);
    await appendFile(child.sessionFile, JSON.stringify(message("missing-user", initial.leafId, "later native input")) + "\n");
    expect((await store.readHistory(child)).operations).toEqual([]);
  });

  it("rejects conflicting authenticated tool identity instead of returning partial provenance", async () => {
    const call: PiNativeToolCall = { toolCallId: "call", toolName: "read", assistantEntryId: "assistant", userEntryId: "user",
      sourceInfo: { source: "builtin", path: "builtin:read" }, arguments: { path: "a" } };
    const proof = (id: string, parentId: string, value: PiNativeToolCall) => parsePiNativeEntry({ type: "custom", id, parentId, timestamp,
      customType: PI_NATIVE_TOOL_MARKER, data: { version: 1, call: value, authentication: signPiNativeToolCall("source", value, authenticationKey) } });
    const sourceSessionFile = await native("source", [message("user", null, "read a"), parsePiNativeEntry({ type: "message", id: "assistant", parentId: "user", timestamp,
      message: { role: "assistant", timestamp: 1, provider: "test", model: "test", api: "openai-completions", usage: {}, stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "a" } }] } }),
    proof("proof-one", "assistant", call), proof("proof-two", "proof-one", { ...call, sourceInfo: { source: "extension", path: "/custom/read.ts" } })]);
    await expect(store.readHistory({ cwd, sessionId: "source", sessionFile: sourceSessionFile })).rejects.toMatchObject({ code: "pi_native_history_provenance_invalid" });
  });

  it("rejects unavailable fork context dependencies and missing boundaries", async () => {
    const sourceSessionFile = await native("source", [message("one", null, "first"), message("off-branch", "one", "second"),
      parsePiNativeEntry({ type: "compaction", id: "compact", parentId: "one", timestamp, summary: "summary", firstKeptEntryId: "off-branch", tokensBefore: 4 })]);
    const input = { cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile, sourceEntryId: "compact", childSessionId: "child", operationId: "fork" };
    await expect(store.fork(input)).rejects.toMatchObject({ code: "pi_native_fork_context_unavailable" });
    await expect(store.fork({ ...input, sourceEntryId: "absent" })).rejects.toMatchObject({ code: "pi_native_fork_boundary_invalid" });
    expect(await readdir(sessionDirectory)).toEqual(["source.jsonl"]);
  });

  it("forks a fully compacted native branch with no retained entry reference", async () => {
    const compact = parsePiNativeEntry({ type: "compaction", id: "compact", parentId: "one", timestamp,
      summary: "all previous context summarized", firstKeptEntryId: null, tokensBefore: 100 });
    const sourceSessionFile = await native("source", [message("one", null, "old input"), compact]);
    const child = await store.fork({ cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile, sourceEntryId: "compact",
      childSessionId: "compacted-child", operationId: "fork-fully-compacted" });
    expect((await store.readHistory(child)).entries).toContainEqual(compact);
  });

  it("keeps sequential pages stable and rejects replayed or wrong-scope cursors", async () => {
    for (let index = 0; index < 4; index++) {
      const file = await native(`session-${index}`, []);
      await utimes(file, new Date(1000 + index * 1000), new Date(1000 + index * 1000));
    }
    const first = await store.listSessions({ cwd, limit: 1 });
    expect(first.sessions.map((item) => item.sessionId)).toEqual(["session-3"]);
    await native("newer", []);
    await expect(store.listSessions({ cwd, limit: 2, cursor: first.cursor })).rejects.toMatchObject({ code: "pi_native_cursor_invalid" });
    const other = path.join(root, "other");
    await mkdir(other);
    await expect(store.listSessions({ cwd: other, limit: 1, cursor: first.cursor })).rejects.toMatchObject({ code: "pi_native_cursor_invalid" });
    const second = await store.listSessions({ cwd, limit: 1, cursor: first.cursor });
    expect(second.sessions.map((item) => item.sessionId)).toEqual(["session-2"]);
    await expect(store.listSessions({ cwd, limit: 1, cursor: first.cursor })).rejects.toMatchObject({ code: "pi_native_cursor_invalid" });
    const third = await store.listSessions({ cwd, limit: 1, cursor: second.cursor });
    const last = await store.listSessions({ cwd, limit: 1, cursor: third.cursor });
    expect(last).toMatchObject({ sessions: [{ sessionId: "session-0" }] });
    expect(last.cursor).toBeUndefined();
  });

  const yieldingEntries = () => Array.from({ length: 512 }, (_, index) => message(`entry-${index}`, index ? `entry-${index - 1}` : null, "native history"));

  it("ignores concurrent writer-lock, marker, and temporary-file churn during discovery", async () => {
    const file = await native("source", yieldingEntries());
    const yieldPoint = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
      const lease = await acquirePiSessionWriterLock(file, { detachedWriter: true });
      try {
        const temporary = path.join(sessionDirectory, ".sedes-native-publication.tmp");
        await writeFile(temporary, "unpublished");
        await unlink(temporary);
      } finally { await lease.release(); }
      await utimes(sessionDirectory, new Date(1_000), new Date(1_000));
    });
    await expect(store.listSessions({ cwd })).resolves.toMatchObject({ sessions: [{ sessionId: "source" }] });
    expect(yieldPoint).toHaveBeenCalledTimes(1);
  });

  it("keeps a complete discovery prefix while the same session keeps appending", async () => {
    const title = parsePiNativeEntry({ type: "session_info", id: "title-old", parentId: "entry-511", timestamp, name: "old" });
    const file = await native("active", [...yieldingEntries(), title]);
    let revision = 0;
    const yieldPoint = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
      const parentId = revision ? `title-${revision}` : "title-old";
      await appendFile(file, JSON.stringify({ type: "session_info", id: `title-${++revision}`, parentId, timestamp, name: `new-${revision}` }) + "\n");
    });
    await expect(store.listSessions({ cwd })).resolves.toMatchObject({ sessions: [{ sessionId: "active", title: "old" }] });
    expect(yieldPoint).toHaveBeenCalledTimes(1);
    yieldPoint.mockRestore();
    await expect(store.listSessions({ cwd })).resolves.toMatchObject({ sessions: [{ sessionId: "active", title: "new-1" }] });
  });

  it("accepts appends between chunks of the initial file read", async () => {
    const file = await native("active", yieldingEntries());
    expect((await stat(file)).size).toBeGreaterThan(64 * 1024);
    const probe = await open(file, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
    const originalRead = prototype.read;
    await probe.close();
    let reads = 0;
    let appended = false;
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (this: typeof probe, ...args) {
      const result = await Reflect.apply(originalRead, this, args);
      if (++reads === 2) {
        // The header probe was first; this is the full snapshot's first chunk.
        appended = true;
        await appendFile(file, JSON.stringify({ type: "session_info", id: "new-title", parentId: "entry-511", timestamp, name: "after read began" }) + "\n");
      }
      return result;
    });
    try {
      const result = await store.listSessions({ cwd });
      expect(result.sessions).toMatchObject([{ sessionId: "active" }]);
      expect(result.sessions[0]?.title).toBeUndefined();
      expect(appended).toBe(true);
      expect(reads).toBeGreaterThan(3);
    } finally { read.mockRestore(); }
    expect((await store.listSessions({ cwd })).sessions[0]?.title).toBe("after read began");
  });

  it("pins later files to their enumerated size even when they grow before being opened", async () => {
    await native("source", yieldingEntries(), "a-source");
    const later = await native("later", [parsePiNativeEntry({ type: "session_info", id: "old-title", parentId: null, timestamp, name: "old" })], "z-later");
    await utimes(later, new Date(2_000), new Date(2_000));
    const yieldPoint = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
      await appendFile(later, JSON.stringify({ type: "session_info", id: "new-title", parentId: "old-title", timestamp, name: "new" }) + "\n");
    });
    const result = await store.listSessions({ cwd });
    expect(result.sessions.find(session => session.sessionId === "later")).toMatchObject({ title: "old", updatedAt: new Date(2_000).toISOString() });
    expect(yieldPoint).toHaveBeenCalledTimes(1);
    yieldPoint.mockRestore();
    expect((await store.listSessions({ cwd })).sessions.find(session => session.sessionId === "later")?.title).toBe("new");
  });

  it.each(["history", "fork"] as const)("reads a complete %s prefix while Pi keeps appending between chunks", async mode => {
    const file = await native("active", yieldingEntries());
    const probe = await open(file, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
    const originalRead = prototype.read;
    await probe.close();
    let appended = 0;
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (this: typeof probe, ...args) {
      const result = await Reflect.apply(originalRead, this, args);
      const parentId = appended ? `append-${appended}` : "entry-511";
      await appendFile(file, JSON.stringify(message(`append-${++appended}`, parentId, "concurrent input")) + "\n");
      return result;
    });
    let child: Awaited<ReturnType<PiNativeDiskStore["fork"]>> | undefined;
    try {
      if (mode === "history") {
        const history = await store.readHistory({ cwd, sessionId: "active", sessionFile: file });
        expect(history.entries).toHaveLength(512);
        expect(history.leafId).toBe("entry-511");
      } else {
        child = await store.fork({ cwd, sourceSessionId: "active", sourceSessionFile: file,
          sourceEntryId: "entry-511", childSessionId: "active-fork", operationId: "fork-active", inheritedSettings });
      }
      expect(appended).toBeGreaterThan(3);
    } finally { read.mockRestore(); }
    if (child) {
      const history = await store.readHistory(child);
      expect(history.inheritance).toBe("verified");
      expect(history.inheritedEntryIds).toEqual(yieldingEntries().map(entry => entry.id));
      expect(history.entries.some(entry => parsePiNativeEntry(entry).id.startsWith("append-"))).toBe(false);
    }
  });

  it.each(["truncate", "replace", "rewrite and append"])("rejects %s while reading a live history prefix", async change => {
    const file = await native("active", yieldingEntries());
    const original = await readFile(file, "utf8");
    vi.spyOn(scheduler, "yield").mockImplementationOnce(async () => {
      if (change === "truncate") await writeFile(file, original.split("\n")[0] + "\n");
      else if (change === "replace") {
        const replacement = path.join(sessionDirectory, ".history-replacement.tmp");
        await writeFile(replacement, original);
        await rename(replacement, file);
      } else {
        await writeFile(file, original.replace('"native history"', '"forged history"') +
          JSON.stringify(message("appended", "entry-511", "later input")) + "\n");
      }
    });
    await expect(store.readHistory({ cwd, sessionId: "active", sessionFile: file })).rejects.toMatchObject({ code: "pi_native_history_changed", delivery: "not_sent" });
  });

  it("excludes an unfinished appended UTF-8 record from discovery and history", async () => {
    const file = await native("partial", [parsePiNativeEntry({ type: "session_info", id: "old-title", parentId: null, timestamp, name: "old" })]);
    const next = Buffer.from(JSON.stringify({ type: "session_info", id: "new-title", parentId: "old-title", timestamp, name: "new-🌍" }) + "\n");
    const split = next.indexOf(Buffer.from("🌍")) + 1;
    await appendFile(file, next.subarray(0, split));
    await expect(store.listSessions({ cwd })).resolves.toMatchObject({ sessions: [{ sessionId: "partial", title: "old" }] });
    await expect(store.readHistory({ cwd, sessionId: "partial", sessionFile: file })).resolves.toMatchObject({ leafId: "old-title" });
    await appendFile(file, next.subarray(split));
    await expect(store.listSessions({ cwd })).resolves.toMatchObject({ sessions: [{ sessionId: "partial", title: "new-🌍" }] });
    await expect(store.readHistory({ cwd, sessionId: "partial", sessionFile: file })).resolves.toMatchObject({ leafId: "new-title" });
  });

  it.each(["assistant", "input marker"])("preserves a valid unterminated %s through history and fork replay", async terminal => {
    const operation: PiManagedOperation = { input: {
      operationId: "input", mutationId: "input-mutation", reconciliationToken: "input-receipt",
      fingerprint: "a".repeat(64), mode: "submit", text: "first",
    }, phase: "accepted", userEntryId: "user" };
    const last = terminal === "assistant"
      ? parsePiNativeEntry({ type: "message", id: "last", parentId: "user", timestamp,
        message: { role: "assistant", timestamp: 1, provider: "test", model: "test", api: "openai-completions", usage: {},
          stopReason: "stop", content: [{ type: "text", text: "Final answer" }] } })
      : parsePiNativeEntry({ type: "custom", id: "last", parentId: "user", timestamp, customType: PI_MANAGED_INPUT_MARKER,
        data: { version: 1, operation, authentication: signPiManagedOperation("source", operation, authenticationKey) } });
    const sourceSessionFile = await native("source", [message("user", null, "first"), last]);
    const content = (await readFile(sourceSessionFile, "utf8")).trimEnd();
    await writeFile(sourceSessionFile, content);
    const history = await store.readHistory({ cwd, sessionId: "source", sessionFile: sourceSessionFile });
    expect(history.leafId).toBe("last");
    expect(history.entries.at(-1)).toEqual(last);
    if (terminal === "input marker") expect(history.operations).toEqual([operation]);
    const input: PiNativeForkInput = { cwd, sourceSessionId: "source", sourceSessionFile, sourceEntryId: "last",
      childSessionId: "child", operationId: "fork-unterminated", inheritedSettings };
    const child = await store.fork(input);
    const childHistory = await store.readHistory(child);
    expect(childHistory.inheritedEntryIds).toEqual(["user", "last"]);
    if (terminal === "input marker") expect(childHistory.operations).toEqual([operation]);
    else expect(childHistory.entries[1]).toEqual(last);
    await writeFile(child.sessionFile, (await readFile(child.sessionFile, "utf8")).trimEnd());
    await expect(store.reconcileFork(input)).resolves.toEqual(child);
    expect((await store.readHistory(child)).inheritance).toBe("verified");
    expect(await readFile(sourceSessionFile, "utf8")).toBe(content);
  });

  it("includes a quiescent unterminated title in discovery", async () => {
    const file = await native("source", [parsePiNativeEntry({ type: "session_info", id: "title", parentId: null, timestamp, name: "Final title" })]);
    await writeFile(file, (await readFile(file, "utf8")).trimEnd());
    await expect(store.listSessions({ cwd })).resolves.toMatchObject({ sessions: [{ sessionId: "source", title: "Final title" }] });
  });

  it.each([1, 2])("rejects growth during read %i instead of omitting a valid unterminated record", async changedRead => {
    const file = await native("source", [message("last", null, "final input")]);
    await writeFile(file, (await readFile(file, "utf8")).trimEnd());
    const probe = await open(file, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
    const originalRead = prototype.read;
    await probe.close();
    let reads = 0;
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (this: typeof probe, ...args) {
      const result = await Reflect.apply(originalRead, this, args);
      if (++reads === changedRead) await appendFile(file, "\n" + JSON.stringify(message("next", "last", "next input")) + "\n");
      return result;
    });
    try {
      await expect(store.readHistory({ cwd, sessionId: "source", sessionFile: file })).rejects.toMatchObject({ code: "pi_native_history_changed" });
    } finally { read.mockRestore(); }
    await expect(store.readHistory({ cwd, sessionId: "source", sessionFile: file })).resolves.toMatchObject({ leafId: "next" });
  });

  it("keeps the captured complete prefix while a partial UTF-8 tail finishes during the read", async () => {
    const file = await native("source", [message("old", null, "old input")]);
    const next = Buffer.from(JSON.stringify(message("next", "old", "new 🌍 input")) + "\n");
    const split = next.indexOf(Buffer.from("🌍")) + 1;
    await appendFile(file, next.subarray(0, split));
    const probe = await open(file, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
    const originalRead = prototype.read;
    await probe.close();
    let reads = 0;
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (this: typeof probe, ...args) {
      const result = await Reflect.apply(originalRead, this, args);
      if (++reads === 1) await appendFile(file, next.subarray(split));
      return result;
    });
    try {
      await expect(store.readHistory({ cwd, sessionId: "source", sessionFile: file })).resolves.toMatchObject({ leafId: "old" });
    } finally { read.mockRestore(); }
    await expect(store.readHistory({ cwd, sessionId: "source", sessionFile: file })).resolves.toMatchObject({ leafId: "next" });
  });

  it("requires a complete current file when verifying a publication receipt", async () => {
    const input = { cwd, sessionId: "partial-receipt", operationId: "create-partial" };
    const identity = await store.create(input);
    const initial = await store.readHistory(identity);
    await appendFile(identity.sessionFile, '{"type":"message",');
    await expect(store.readHistory(identity)).resolves.toMatchObject({ leafId: initial.leafId });
    await expect(store.create(input)).rejects.toMatchObject({ code: "pi_native_history_invalid" });
  });

  it.each(["truncate", "replace", "rewrite and append"])("does not accept %s as discovery-only growth", async change => {
    const file = await native("first", [parsePiNativeEntry({ type: "session_info", id: "old-title", parentId: null, timestamp, name: "old" })], "a-first");
    await native("source", yieldingEntries(), "z-source");
    const original = await readFile(file, "utf8");
    const yieldPoint = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
      if (change === "truncate") await writeFile(file, original.split("\n")[0] + "\n");
      else if (change === "replace") {
        const previous = await stat(file);
        const replacement = path.join(sessionDirectory, ".replacement.tmp");
        await writeFile(replacement, original);
        await utimes(replacement, previous.atime, previous.mtime);
        await rename(replacement, file);
      } else {
        await writeFile(file, original.replace('"name":"old"', '"name":"new"') +
          JSON.stringify({ type: "session_info", id: "appended", parentId: "old-title", timestamp, name: "later" }) + "\n");
      }
    });
    const singleAttempt = new PiNativeDiskStore({ sessionDirectory, authenticationKey, limits: { maximumScanAttempts: 1 } });
    try {
      await expect(singleAttempt.listSessions({ cwd })).rejects.toMatchObject({
        code: change === "rewrite and append" ? "pi_native_history_changed" : "pi_native_directory_changed", delivery: "not_sent",
      });
      expect(yieldPoint).toHaveBeenCalledTimes(1);
    } finally { singleAttempt.close(); }
  });

  it.each(["added name", "same-file rewrite", "same-name replacement"])("retries JSONL %s without retaining partial results", async (change) => {
    const first = await native("first", [parsePiNativeEntry({ type: "session_info", id: "title", parentId: null, timestamp, name: "old" })], "a-first");
    await native("source", yieldingEntries(), "z-source");
    let changed = false;
    const yieldPoint = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
      if (changed) return;
      changed = true;
      if (change === "added name") { await native("added", []); return; }
      const original = await readFile(first, "utf8");
      const replacement = original.replace('"name":"old"', '"name":"new"');
      if (change === "same-name replacement") {
        const before = await stat(first);
        const temporary = path.join(sessionDirectory, ".replacement.tmp");
        await writeFile(temporary, replacement);
        await utimes(temporary, before.atime, before.mtime);
        await rename(temporary, first);
      } else {
        await writeFile(first, replacement);
        await utimes(first, new Date(2_000), new Date(2_000));
      }
    });
    const result = await store.listSessions({ cwd });
    expect(result.sessions.map(item => item.sessionId).sort()).toEqual(change === "added name" ? ["added", "first", "source"] : ["first", "source"]);
    expect(result.sessions.find(item => item.sessionId === "first")?.title).toBe(change === "added name" ? "old" : "new");
    expect(yieldPoint).toHaveBeenCalledTimes(2);
  });

  it("bounds retries while native JSONL files continue changing", async () => {
    const first = await native("first", [], "a-first");
    await native("source", yieldingEntries(), "z-source");
    let revision = 0;
    const yieldPoint = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
      const modified = new Date(++revision * 1_000);
      await utimes(first, modified, modified);
    });
    await expect(store.listSessions({ cwd })).rejects.toMatchObject({ code: "pi_native_directory_changed", delivery: "not_sent" });
    expect(yieldPoint).toHaveBeenCalledTimes(3);
  });

  it("keeps one byte budget across scan retries", async () => {
    const first = await native("first", [], "a-first");
    const source = await native("source", yieldingEntries(), "z-source");
    const limited = new PiNativeDiskStore({ sessionDirectory, authenticationKey,
      limits: { maximumScanBytes: 2 * (await stat(source)).size + 1_000 } });
    let revision = 0;
    const yieldPoint = vi.spyOn(scheduler, "yield").mockImplementation(async () => {
      const modified = new Date(++revision * 1_000);
      await utimes(first, modified, modified);
    });
    try {
      await expect(limited.listSessions({ cwd })).rejects.toMatchObject({ code: "pi_native_list_capacity_exceeded" });
      expect(yieldPoint).toHaveBeenCalledTimes(1);
    } finally { limited.close(); }
  });

  it("admits concurrent create, fork, and discovery in one workspace", async () => {
    const sourceSessionFile = await native("source", yieldingEntries());
    let launched = false;
    vi.spyOn(scheduler, "yield").mockImplementation(async () => {
      if (launched) return;
      launched = true;
      await Promise.all([
        store.create({ cwd, sessionId: "created", operationId: "create-concurrent" }),
        store.fork({ cwd, inheritedSettings, sourceSessionId: "source", sourceSessionFile,
          sourceEntryId: "entry-511", childSessionId: "forked", operationId: "fork-concurrent" }),
        store.listSessions({ cwd }),
      ]);
    });
    const result = await store.listSessions({ cwd });
    expect(result.sessions.map(item => item.sessionId).sort()).toEqual(["created", "forked", "source"]);
    expect((await readdir(sessionDirectory)).every(name => name.endsWith(".jsonl"))).toBe(true);
  });

  it("expires snapshots and bounds retained pagination state", async () => {
    await native("one", []);
    await native("two", []);
    const limited = new PiNativeDiskStore({ sessionDirectory, authenticationKey, limits: { maximumSnapshots: 1, snapshotLifetimeMs: 10 } });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const first = await limited.listSessions({ cwd, limit: 1 });
    await expect(limited.listSessions({ cwd, limit: 1 })).rejects.toMatchObject({ code: "pi_native_list_capacity_exceeded" });
    clock.mockReturnValue(1010);
    await expect(limited.listSessions({ cwd, limit: 1, cursor: first.cursor })).rejects.toMatchObject({ code: "pi_native_cursor_invalid" });
    await expect(limited.listSessions({ cwd, limit: 1 })).resolves.toHaveProperty("cursor");
    limited.close();
  });

  it("rejects duplicate session IDs and filters other cwd files in shared storage", async () => {
    const otherCwd = path.join(root, "other");
    await mkdir(otherCwd);
    await native("other", [], "other", otherCwd);
    await native("same", []);
    expect((await store.listSessions({ cwd })).sessions.map((item) => item.sessionId)).toEqual(["same"]);
    await native("same", [], "duplicate");
    await expect(store.listSessions({ cwd })).rejects.toMatchObject({ code: "pi_native_session_id_ambiguous" });
  });

  it("rejects symlink and outside-namespace paths without touching their targets", async () => {
    const file = await native("one", []);
    const outside = path.join(root, "outside.jsonl");
    await writeFile(outside, "preserve");
    const linked = path.join(sessionDirectory, "linked.jsonl");
    await symlink(outside, linked);
    await expect(store.readHistory({ cwd, sessionId: "one", sessionFile: linked })).rejects.toMatchObject({ code: "pi_native_session_file_invalid" });
    await expect(store.readHistory({ cwd, sessionId: "one", sessionFile: outside })).rejects.toMatchObject({ code: "pi_native_session_path_mismatch" });
    await expect(store.readHistory({ cwd, sessionId: "wrong", sessionFile: file })).rejects.toMatchObject({ code: "pi_native_session_identity_mismatch" });
    const cwdAlias = path.join(root, "alias");
    await symlink(cwd, cwdAlias, "dir");
    await expect(store.listSessions({ cwd: cwdAlias })).rejects.toMatchObject({ code: "pi_native_directory_not_canonical" });
    expect(await readFile(outside, "utf8")).toBe("preserve");
  });

  it.each([
    ["duplicate entry", [message("one", null, "one"), message("one", "one", "two")], "pi_native_history_tree_invalid"],
    ["unknown parent", [message("one", "absent", "one")], "pi_native_history_tree_invalid"],
    ["unknown entry", [{ type: "future", id: "one", parentId: null, timestamp }], "pi_native_history_invalid"],
  ])("fails closed for %s", async (_label, entries, code) => {
    const file = await native("one", entries as PiNativeEntry[]);
    await expect(store.readHistory({ cwd, sessionId: "one", sessionFile: file })).rejects.toMatchObject({ code });
  });

  it("rejects malformed complete native JSONL records and invalid UTF-8", async () => {
    const file = await native("one", []);
    const header = await readFile(file);
    for (const suffix of [Buffer.from('{"type":"message"\n'), Buffer.from([0xff, 0xfe, 0x0a])]) {
      await writeFile(file, Buffer.concat([header, suffix]));
      await expect(store.readHistory({ cwd, sessionId: "one", sessionFile: file })).rejects.toMatchObject({ code: "pi_native_history_invalid" });
    }
  });

  it("bounds file, entry, header-scan, and discovery workloads", async () => {
    const file = await native("one", [message("one", null, "one"), message("two", "one", "two")]);
    for (const [limits, action, code] of [
      [{ maximumFileBytes: 1 }, "read", "pi_native_history_capacity_exceeded"],
      [{ maximumEntries: 1 }, "read", "pi_native_history_capacity_exceeded"],
      [{ maximumHeaderBytes: 1 }, "list", "pi_native_history_capacity_exceeded"],
      [{ maximumScanBytes: 1 }, "list", "pi_native_list_capacity_exceeded"],
    ] as const) {
      const limited = new PiNativeDiskStore({ sessionDirectory, authenticationKey, limits });
      await expect(action === "read" ? limited.readHistory({ cwd, sessionId: "one", sessionFile: file }) : limited.listSessions({ cwd })).rejects.toMatchObject({ code });
      limited.close();
    }
    await native("two", []);
    const limited = new PiNativeDiskStore({ sessionDirectory, authenticationKey, limits: { maximumSessions: 1 } });
    await expect(limited.listSessions({ cwd })).rejects.toMatchObject({ code: "pi_native_list_capacity_exceeded" });
    limited.close();
  });

  it("rejects cancellation before admission and all operations after close", async () => {
    const input = { cwd, sessionId: "one", operationId: "create" };
    const controller = new AbortController();
    controller.abort();
    await expect(store.create(input, controller.signal)).rejects.toMatchObject({ code: "pi_native_operation_cancelled", delivery: "not_sent" });
    await expect(stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    store.close();
    await expect(store.create(input)).rejects.toMatchObject({ code: "pi_native_disk_store_closed" });
    await expect(store.listSessions({ cwd })).rejects.toMatchObject({ code: "pi_native_disk_store_closed" });
  });
});
