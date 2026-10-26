import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquirePiSessionWriterLock, PiSessionWriterCleanupRequiredError } from "../../src/server/backends/pi/pi-session-writer-lock.js";
import * as processTable from "../../src/server/runtime/process-table.js";
import { PiSessionStore } from "../../src/server/backends/pi/pi-session-store.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-pi-writer-"));
  directories.push(directory);
  return directory;
}

describe("shared Pi session writer ownership", () => {
  const bootA = "cae98575-cbf9-4a40-aa09-8b63153031ea";
  const bootB = "3b189129-8107-4355-af98-3d8f953495f5";
  async function orphanedNative(bootId: string | null = bootA) {
    const boot = vi.spyOn(processTable, "readBootIdentity").mockResolvedValue(bootId ?? undefined);
    const file = path.join(await fixture(), "session.jsonl");
    const writer = await acquirePiSessionWriterLock(file, { detachedWriter: true });
    // Simulate a stopped host without releasing its surviving native marker.
    await rm(`${file}.sedes-writer.lock`, { recursive: true });
    const markerFile = `${file}.sedes-native-writer`;
    const record = JSON.parse(await readFile(markerFile, "utf8")) as Record<string, unknown>;
    return { boot, file, markerFile, record, writer };
  }

  it.each([false, true])("recovers only an exact old-boot marker before acquiring a new writer (native=%s)", async (detachedWriter) => {
    const f = await orphanedNative();
    expect(f.record.bootId).toBe(bootA);
    f.boot.mockResolvedValue(bootB);
    const next = await acquirePiSessionWriterLock(f.file, { detachedWriter });
    if (detachedWriter) {
      const record = JSON.parse(await readFile(f.markerFile, "utf8"));
      expect(record.bootId).toBe(bootB);
      expect(record.ownerToken).not.toBe(f.record.ownerToken);
      await expect(f.writer.release()).rejects.toThrow("pi_session_native_writer_identity_changed");
      expect(JSON.parse(await readFile(f.markerFile, "utf8"))).toEqual(record);
    } else await expect(readFile(f.markerFile)).rejects.toMatchObject({ code: "ENOENT" });
    await next.release();
  });

  it.each([bootA, undefined, "not-a-kernel-uuid"])("keeps the marker when the current boot is unchanged or unknown: %s", async (bootId) => {
    const f = await orphanedNative();
    f.boot.mockResolvedValue(bootId);
    await expect(acquirePiSessionWriterLock(f.file)).rejects.toBeInstanceOf(PiSessionWriterCleanupRequiredError);
    expect(JSON.parse(await readFile(f.markerFile, "utf8"))).toEqual(f.record);
  });

  it("keeps an unknown prior boot blocked even when the current boot is known", async () => {
    const f = await orphanedNative(null);
    expect(f.record.bootId).toBeNull();
    f.boot.mockResolvedValue(bootB);
    await expect(acquirePiSessionWriterLock(f.file)).rejects.toBeInstanceOf(PiSessionWriterCleanupRequiredError);
    expect(JSON.parse(await readFile(f.markerFile, "utf8"))).toEqual(f.record);
  });

  it.each([
    { version: 2 }, { identity: "a".repeat(64) }, { ownerToken: "invalid" }, { hostPid: 0 },
    { bootId: "invalid" }, { extra: true },
  ])("never recovers malformed or wrong-identity markers: %j", async (mutation) => {
    const f = await orphanedNative();
    const text = JSON.stringify({ ...f.record, ...mutation });
    await writeFile(f.markerFile, text);
    f.boot.mockResolvedValue(bootB);
    await expect(acquirePiSessionWriterLock(f.file)).rejects.toBeInstanceOf(PiSessionWriterCleanupRequiredError);
    expect(await readFile(f.markerFile, "utf8")).toBe(text);
  });

  it("keeps markers without the required boot identity field blocked", async () => {
    const f = await orphanedNative();
    const { bootId: _bootId, ...incomplete } = f.record;
    await writeFile(f.markerFile, JSON.stringify(incomplete));
    f.boot.mockResolvedValue(bootB);
    await expect(acquirePiSessionWriterLock(f.file)).rejects.toBeInstanceOf(PiSessionWriterCleanupRequiredError);
    expect(JSON.parse(await readFile(f.markerFile, "utf8"))).toEqual(incomplete);
  });

  it("never follows marker symlinks during recovery or release", async () => {
    const f = await orphanedNative();
    const target = `${f.markerFile}.target`;
    const text = await readFile(f.markerFile, "utf8");
    await writeFile(target, text);
    await rm(f.markerFile); await symlink(target, f.markerFile);
    f.boot.mockResolvedValue(bootB);
    await expect(acquirePiSessionWriterLock(f.file)).rejects.toBeInstanceOf(PiSessionWriterCleanupRequiredError);
    await expect(f.writer.release()).rejects.toBeInstanceOf(PiSessionWriterCleanupRequiredError);
    expect(await readFile(target, "utf8")).toBe(text);
  });

  it("refuses a marker changed after inspection before old-boot removal", async () => {
    const f = await orphanedNative();
    const replacement = JSON.stringify({ ...f.record, ownerToken: "19542cdd-7066-4805-a8f9-ee58687675cf" });
    f.boot.mockReset().mockResolvedValueOnce(bootB).mockImplementationOnce(async () => {
      await rm(f.markerFile); await writeFile(f.markerFile, replacement);
      return bootB;
    });
    await expect(acquirePiSessionWriterLock(f.file)).rejects.toBeInstanceOf(PiSessionWriterCleanupRequiredError);
    expect(await readFile(f.markerFile, "utf8")).toBe(replacement);
  });

  it("excludes another writer through file and parent aliases but allows another session", async () => {
    const directory = await fixture();
    const sessions = path.join(directory, "sessions");
    const alias = path.join(directory, "alias");
    await mkdir(sessions);
    await symlink(sessions, alias, "dir");
    const file = path.join(sessions, "first.jsonl");
    const first = await acquirePiSessionWriterLock(file);
    await expect(acquirePiSessionWriterLock(path.join(alias, "first.jsonl"))).rejects.toThrow();
    await writeFile(file, "native session");
    const fileAlias = path.join(directory, "session-alias.jsonl");
    await symlink(file, fileAlias);
    await expect(acquirePiSessionWriterLock(fileAlias)).rejects.toThrow();
    const other = await acquirePiSessionWriterLock(path.join(sessions, "second.jsonl"));
    await other.release();
    await first.release();
    const next = await acquirePiSessionWriterLock(fileAlias);
    // A second release from the previous owner cannot release the new owner.
    await first.release();
    await expect(acquirePiSessionWriterLock(file)).rejects.toThrow();
    await next.release();
  });

  it("recovers a proved-dead process owner through the existing process lock", async () => {
    const directory = await fixture();
    const file = path.join(directory, "session.jsonl");
    const old = await acquirePiSessionWriterLock(file);
    const lockDirectory = `${file}.sedes-writer.lock`;
    const lockFile = path.join(lockDirectory, (await readdir(lockDirectory))[0]!);
    const metadata = JSON.parse(await readFile(lockFile, "utf8")) as Record<string, unknown>;
    await writeFile(lockFile, JSON.stringify({ ...metadata, pid: 2_147_483_647 }));
    const next = await acquirePiSessionWriterLock(file);
    await old.release();
    await expect(acquirePiSessionWriterLock(file)).rejects.toThrow();
    await next.release();
  });

  it("rejects a dangling session symlink whose identity could change after creation", async () => {
    const directory = await fixture();
    const file = path.join(directory, "session.jsonl");
    await symlink(path.join(directory, "missing.jsonl"), file);
    await expect(acquirePiSessionWriterLock(file)).rejects.toThrow("pi_session_path_unresolved");
  });

  it("does not reclaim a native child writer merely because its host PID is dead", async () => {
    const directory = await fixture();
    const file = path.join(directory, "session.jsonl");
    const native = await acquirePiSessionWriterLock(file, { detachedWriter: true });
    const lockDirectory = `${file}.sedes-writer.lock`;
    const lockFile = path.join(lockDirectory, (await readdir(lockDirectory))[0]!);
    const metadata = JSON.parse(await readFile(lockFile, "utf8")) as Record<string, unknown>;
    await writeFile(lockFile, JSON.stringify({ ...metadata, pid: 2_147_483_647 }));
    await expect(acquirePiSessionWriterLock(file)).rejects.toThrow("pi_session_native_writer_cleanup_required");
    await expect(acquirePiSessionWriterLock(file, { detachedWriter: true })).rejects.toThrow("pi_session_native_writer_cleanup_required");
    // Only the holder's proved-close path retires the native child marker.
    await native.release();
    await native.release();
    const sdk = await acquirePiSessionWriterLock(file);
    await sdk.release();
  });

  it("holds SDK ownership before native open and leaves detached history readable", async () => {
    const directory = await fixture();
    const workspace = {
      canonicalPath: directory,
      authorityRevision: 0,
      summary: { id: "workspace", environmentId: "local", displayName: "workspace", displayPath: directory, availability: "available", trustState: "trusted", revision: 0 },
    } satisfies ValidatedWorkspace;
    const store = new PiSessionStore({ sessionDirectory: path.join(directory, "sessions") });
    const reserved = await store.reserve(workspace, "owned-session");
    const file = reserved.manager.getSessionFile()!;
    const legacy = (await readFile(file, "utf8")).replace('"version":3', '"version":2');
    await writeFile(file, legacy);
    const native = await acquirePiSessionWriterLock(file);
    await expect(store.openWriter(workspace, "owned-session", reserved.opaqueBindingDetail)).rejects.toThrow();
    await store.openPersisted(workspace, "owned-session");
    expect(await readFile(file, "utf8")).toBe(legacy);
    await native.release();
    const sdk = await store.openWriter(workspace, "owned-session", reserved.opaqueBindingDetail);
    sdk.manager.appendSessionInfo("SDK title");
    await expect(acquirePiSessionWriterLock(file)).rejects.toThrow();
    const history = await store.openPersisted(workspace, "owned-session");
    expect(history?.getSessionName()).toBe("SDK title");
    expect(history?.isPersisted()).toBe(false);
    history!.appendSessionInfo("detached mutation");
    expect((await store.openPersisted(workspace, "owned-session"))?.getSessionName()).toBe("SDK title");
    await sdk.writer.release();
    const next = await acquirePiSessionWriterLock(file);
    await next.release();
  });
});
