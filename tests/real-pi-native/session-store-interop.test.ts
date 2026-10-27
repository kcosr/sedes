import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSessionStore } from "../../src/server/backends/pi/pi-session-store.js";
import { PiNativeDiskStore } from "../../src/server/backends/pi/native/host/disk-store.js";
import { PI_MANAGED_INPUT_MARKER, signPiManagedOperation, type PiManagedOperation } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";
import { acquirePiSessionWriterLock } from "../../src/server/backends/pi/pi-session-writer-lock.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";

type CurrentManager = SessionManager & { appendContextEdit(targetId: string, replacement: { content: string } | null): string };
interface CurrentManagers {
  create(cwd: string, directory: string, options: { id: string }): CurrentManager;
  open(file: string, directory: string, cwd: string): CurrentManager;
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function currentManagers(): Promise<CurrentManagers> {
  const executable = process.env.SEDES_REAL_PI_NATIVE_EXECUTABLE;
  if (!executable || !path.isAbsolute(executable)) throw new Error("Set SEDES_REAL_PI_NATIVE_EXECUTABLE to the isolated stock Pi 1.4.0 executable.");
  let directory = path.dirname(await realpath(executable));
  while (directory !== path.dirname(directory)) {
    const candidate = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8").catch(() => "null")) as { name?: string; version?: string } | null;
    if (candidate?.name === "@earendil-works/pi-coding-agent") {
      expect(candidate.version).toBe("1.4.0");
      return (await import(/* @vite-ignore */ pathToFileURL(path.join(directory, "dist/core/session-manager.js")).href)).SessionManager as CurrentManagers;
    }
    directory = path.dirname(directory);
  }
  throw new Error("The selected executable has no stock Pi package root.");
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-interop-")));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  await mkdir(cwd); await mkdir(sessions);
  const workspace: ValidatedWorkspace = { canonicalPath: cwd, authorityRevision: 0, summary: { id: "workspace", environmentId: "local", displayName: "workspace", displayPath: cwd, availability: "available", trustState: "trusted", revision: 0 } };
  const authenticationKey = randomBytes(32);
  const stock = await currentManagers();
  const native = stock.create(cwd, sessions, { id: "native-session" });
  const user = native.appendMessage({ role: "user", content: "native user", timestamp: 1 });
  const operation: PiManagedOperation = { input: { operationId: "native-operation", mutationId: "mutation", reconciliationToken: "token", fingerprint: "a".repeat(64), mode: "submit", text: "native user" }, phase: "accepted", userEntryId: user, targetTurnId: user };
  native.appendCustomEntry(PI_MANAGED_INPUT_MARKER, { version: 1, operation, authentication: signPiManagedOperation(native.getSessionId(), operation, authenticationKey) });
  native.appendMessage({ role: "assistant", content: [{ type: "text", text: "native answer" }], provider: "fixture", model: "fixture", api: "openai-completions", stopReason: "stop", timestamp: 2,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  native.appendUsage("cache_warm", "fixture", "fixture", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const file = native.getSessionFile()!;
  const store = new PiSessionStore({ sessionDirectory: sessions });
  const disk = new PiNativeDiskStore({ sessionDirectory: sessions, authenticationKey });
  return { native, stock, user, file, cwd, sessions, workspace, store, disk, operation };
}

it("round-trips an ordinary stock 1.4 session through the 0.86 writer without rewriting native entries or receipts", async () => {
  const f = await fixture();
  const before = await readFile(f.file, "utf8");
  expect((await f.store.list(f.workspace)).map(row => row.backendConversationId)).toContain("native-session");
  expect((await f.disk.listSessions({ cwd: f.cwd })).sessions.map(row => row.sessionId)).toContain("native-session");
  const detached = await f.store.openPersisted(f.workspace, "native-session");
  expect(detached?.buildSessionContext()).toEqual(f.native.buildSessionContext());
  expect(await readFile(f.file, "utf8")).toBe(before);
  const writer = await f.store.openWriter(f.workspace, "native-session", f.store.bindingDetail("native-session"));
  try {
    await expect(acquirePiSessionWriterLock(f.file, { detachedWriter: true })).rejects.toThrow();
    writer.manager.appendSessionInfo("SDK title");
    writer.manager.appendMessage({ role: "user", content: "SDK continuation", timestamp: 3 });
  } finally { await writer.writer.release(); }
  expect((await readFile(f.file, "utf8")).startsWith(before)).toBe(true);
  const reopened = f.stock.open(f.file, f.sessions, f.cwd);
  expect(reopened.getSessionName()).toBe("SDK title");
  expect(JSON.stringify(reopened.buildSessionContext())).toContain("SDK continuation");
  expect((await f.disk.readHistory({ cwd: f.cwd, sessionId: "native-session", sessionFile: f.file })).operations).toEqual([f.operation]);
  f.disk.close();
});

it("discovers and resumes an SDK-created session through stock 1.4 while preserving SDK markers", async () => {
  const f = await fixture();
  const reserved = await f.store.reserve(f.workspace, "sdk-created", "SDK conversation", "sdk-operation");
  const writer = await f.store.openWriter(f.workspace, "sdk-created", reserved.opaqueBindingDetail);
  try {
    writer.manager.appendMessage({ role: "user", content: "SDK original", timestamp: 1 });
    writer.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "SDK answer" }], provider: "fixture", model: "fixture", api: "openai-completions", stopReason: "stop", timestamp: 2,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  } finally { await writer.writer.release(); }
  const file = reserved.manager.getSessionFile()!;
  const before = await readFile(file, "utf8");
  expect((await f.disk.listSessions({ cwd: f.cwd })).sessions.map(row => row.sessionId)).toContain("sdk-created");
  const nativeWriter = await acquirePiSessionWriterLock(file, { detachedWriter: true });
  try {
    const native = f.stock.open(file, f.sessions, f.cwd);
    expect(native.getSessionName()).toBe("SDK conversation");
    expect(JSON.stringify(native.buildSessionContext())).toContain("SDK original");
    native.appendSessionInfo("Native continuation");
    native.appendMessage({ role: "user", content: "Native followup", timestamp: 3 });
  } finally { await nativeWriter.release(); }
  const after = await readFile(file, "utf8");
  expect(after.startsWith(before)).toBe(true);
  expect(after).toContain("sedes.creation_operation.v1");
  expect((await f.store.openPersisted(f.workspace, "sdk-created"))?.getSessionName()).toBe("Native continuation");
  f.disk.close();
});

it("does not repair a missing newline during SDK discovery or passive reads even while the native writer owns the session", async () => {
  const f = await fixture();
  const withoutNewline = (await readFile(f.file, "utf8")).trimEnd();
  await writeFile(f.file, withoutNewline);
  const writer = await acquirePiSessionWriterLock(f.file, { detachedWriter: true });
  try {
    expect(await f.store.listWithAncestry(f.workspace, randomBytes(32))).toHaveLength(1);
    expect((await f.store.openPersisted(f.workspace, "native-session"))?.getSessionId()).toBe("native-session");
    expect((await f.store.open(f.workspace, "native-session", f.store.bindingDetail("native-session"))).isPersisted()).toBe(false);
    expect(await readFile(f.file, "utf8")).toBe(withoutNewline);
  } finally { await writer.release(); f.disk.close(); }
});

it("preserves native context edits in passive SDK history and refuses SDK resume before any mutation", async () => {
  const f = await fixture();
  f.native.appendContextEdit(f.user, { content: "redacted native user" });
  const before = await readFile(f.file, "utf8");
  const passive = await f.store.openPersisted(f.workspace, "native-session");
  expect(passive?.getEntries().some(entry => String(entry.type) === "context_edit")).toBe(true);
  expect(JSON.stringify(f.native.buildSessionContext())).toContain("redacted native user");
  expect(JSON.stringify(passive?.buildSessionContext())).toContain("native user");
  await expect(f.store.openWriter(f.workspace, "native-session", f.store.bindingDetail("native-session"))).rejects.toMatchObject({ backendCode: "pi_sdk_native_context_unsupported" });
  expect(await readFile(f.file, "utf8")).toBe(before);
  const nativeWriter = await acquirePiSessionWriterLock(f.file, { detachedWriter: true });
  await nativeWriter.release();
  expect(JSON.stringify(f.stock.open(f.file, f.sessions, f.cwd).buildSessionContext())).toContain("redacted native user");
  f.disk.close();
});
