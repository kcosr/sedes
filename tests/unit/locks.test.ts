import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processTable from "../../src/server/runtime/process-table.js";
import {
  acquireStateDirectoryLock,
  lockIdentity,
} from "../../src/server/security/locks.js";
import {
  readBootIdentity,
  readProcessEntries,
} from "../../src/server/runtime/process-table.js";

const roots: string[] = [];

async function lockFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-lock-"));
  roots.push(root);
  const stateDirectory = path.join(root, "state");
  await mkdir(stateDirectory);
  return {
    stateDirectory,
    lockPath: path.join(stateDirectory, ".state.lock"),
    identityHash: lockIdentity(await realpath(stateDirectory)),
  };
}

async function readLock(lockPath: string): Promise<Record<string, unknown>> {
  const files = await readdir(lockPath);
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(path.join(lockPath, files[0]!), "utf8")) as Record<string, unknown>;
}

async function writeLock(lockPath: string, record: Record<string, unknown>) {
  const ownerToken = randomUUID();
  await rm(lockPath, { recursive: true, force: true });
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, `owner-${ownerToken}.json`),
    `${JSON.stringify({ startedAt: new Date(0).toISOString(), ...record, ownerToken })}\n`, { mode: 0o600 });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("exclusive process locks", () => {
  it("excludes a second owner and releases only its own lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-lock-"));
    roots.push(root);
    const stateDirectory = path.join(root, "state");
    const first = await acquireStateDirectoryLock(stateDirectory);
    const lockPath = path.join(stateDirectory, ".state.lock");
    const metadata = await readLock(lockPath) as {
      pid: number;
      identityHash: string;
      ownerToken: string;
    };

    expect(metadata.pid).toBe(process.pid);
    expect(metadata.identityHash).toHaveLength(64);
    expect(metadata.ownerToken).toHaveLength(36);
    await expect(acquireStateDirectoryLock(stateDirectory)).rejects.toThrow(
      "Another Sedes process owns this state directory",
    );

    await first.release();
    await expect(access(lockPath)).rejects.toThrow();
    const replacement = await acquireStateDirectoryLock(stateDirectory);
    await replacement.release();
  });

  it("recovers a well-formed stale lock but never releases a replacement owner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-lock-"));
    roots.push(root);
    const stateDirectory = path.join(root, "state");
    await mkdir(stateDirectory);
    const identityHash = lockIdentity(await realpath(stateDirectory));
    const lockPath = path.join(stateDirectory, ".state.lock");
    await writeLock(lockPath, { pid: 2_147_483_647, identityHash });

    const owner = await acquireStateDirectoryLock(stateDirectory);
    const replacementMetadata = {
      ...await readLock(lockPath),
      ownerToken: "replacement-owner",
    };
    await writeLock(lockPath, replacementMetadata);
    await owner.release();
    await expect(access(lockPath)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "records the owner's start time and boot identity",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sedes-lock-"));
      roots.push(root);
      const stateDirectory = path.join(root, "state");
      const owner = await acquireStateDirectoryLock(stateDirectory);
      const metadata = await readLock(path.join(stateDirectory, ".state.lock"));
      const self = (await readProcessEntries([process.pid])).get(process.pid);
      expect(metadata.processStartTime).toBe(self?.startTime);
      if (process.platform === "linux") {
        expect(metadata.bootId).toBe(await readBootIdentity());
      }
      await owner.release();
    },
  );

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "recovers a lock whose live PID was reused by another process",
    async () => {
      const { stateDirectory, lockPath, identityHash } = await lockFixture();
      const self = (await readProcessEntries([process.pid])).get(process.pid)!;
      // The recorded owner had this PID but a different start time.
      await writeLock(lockPath, {
        pid: process.pid, identityHash, ownerToken: "reused-pid-owner",
        processStartTime: self.startTime === "1" ? "2" : "1",
      });
      const recovered = await acquireStateDirectoryLock(stateDirectory);
      await recovered.release();

      const bootId = await readBootIdentity();
      if (bootId !== undefined) {
        // A matching start time from a previous boot is not this process either.
        await writeLock(lockPath, {
          pid: process.pid, identityHash, ownerToken: "previous-boot-owner",
          processStartTime: self.startTime, bootId: `${bootId}-previous`,
        });
        const afterReboot = await acquireStateDirectoryLock(stateDirectory);
        await afterReboot.release();
      }
    },
  );

  it("keeps live owners, including platforms with PID-only liveness", async () => {
    const { stateDirectory, lockPath, identityHash } = await lockFixture();
    await writeLock(lockPath, { pid: process.pid, identityHash, ownerToken: "legacy-owner" });
    await expect(acquireStateDirectoryLock(stateDirectory)).rejects.toThrow(
      "Another Sedes process owns this state directory",
    );
    const self = (await readProcessEntries([process.pid]).catch(() => new Map())).get(process.pid);
    if (self) {
      await writeLock(lockPath, {
        pid: process.pid, identityHash, ownerToken: "current-owner",
        processStartTime: self.startTime, ...(await readBootIdentity().then((bootId) => bootId ? { bootId } : {})),
      });
      await expect(acquireStateDirectoryLock(stateDirectory)).rejects.toThrow(
        "Another Sedes process owns this state directory",
      );
    }
    await writeLock(lockPath, {
      pid: process.pid, identityHash, ownerToken: "malformed-owner", processStartTime: "../../x",
    });
    await expect(acquireStateDirectoryLock(stateDirectory)).rejects.toThrow("cannot be recovered safely");
  });

  it("derives non-disclosing deterministic identities", () => {
    expect(lockIdentity("/secret/native/store")).toBe(
      lockIdentity("/secret/native/store"),
    );
    expect(lockIdentity("/secret/native/store")).not.toContain("/secret");
    expect(lockIdentity("/secret/native/store")).not.toBe(
      lockIdentity("/another/store"),
    );
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "a delayed stale reclaimer cannot remove a replacement owner's lock",
    async () => {
      const { stateDirectory, lockPath, identityHash } = await lockFixture();
      await writeLock(lockPath, { pid: process.pid, identityHash, processStartTime: "previous process" });
      const readProcesses = processTable.readProcessEntries;
      let reached!: () => void;
      let resume!: () => void;
      const reachedStaleRead = new Promise<void>(resolve => { reached = resolve; });
      const resumeStaleRead = new Promise<void>(resolve => { resume = resolve; });
      let reads = 0;
      vi.spyOn(processTable, "readProcessEntries").mockImplementation(async pids => {
        if (++reads === 2) { reached(); await resumeStaleRead; }
        return readProcesses(pids);
      });
      const delayed = acquireStateDirectoryLock(stateDirectory).then(
        lock => ({ status: "fulfilled" as const, lock }),
        error => ({ status: "rejected" as const, error }),
      );
      await reachedStaleRead;
      const replacement = await acquireStateDirectoryLock(stateDirectory);
      const replacementMetadata = await readLock(lockPath);
      resume();
      const result = await delayed;
      if (result.status === "fulfilled") await result.lock.release();
      expect(result.status).toBe("rejected");
      expect(await readLock(lockPath)).toEqual(replacementMetadata);
      await expect(acquireStateDirectoryLock(stateDirectory)).rejects.toThrow("Another Sedes process");
      await replacement.release();
      expect(await readdir(stateDirectory)).toEqual([]);
    },
  );

  it("admits only one concurrent stale-lock replacement", async () => {
    const { stateDirectory, lockPath, identityHash } = await lockFixture();
    await writeLock(lockPath, { pid: 2_147_483_647, identityHash });
    const attempts = await Promise.allSettled(Array.from({ length: 16 }, () => acquireStateDirectoryLock(stateDirectory)));
    const owners = attempts.filter(attempt => attempt.status === "fulfilled");
    try {
      expect(owners).toHaveLength(1);
      await expect(acquireStateDirectoryLock(stateDirectory)).rejects.toThrow("Another Sedes process");
    } finally {
      await Promise.all(owners.map(owner => owner.value.release()));
    }
    expect(await readdir(stateDirectory)).toEqual([]);
  });

  it("preserves regular-file locks and malformed lock directories for explicit recovery", async () => {
    const { stateDirectory, lockPath, identityHash } = await lockFixture();
    for (const pid of [process.pid, 2_147_483_647]) {
      const record = JSON.stringify({ pid, identityHash, ownerToken: randomUUID(), startedAt: new Date(0).toISOString() });
      await writeFile(lockPath, record);
      await expect(acquireStateDirectoryLock(stateDirectory)).rejects.toThrow("cannot be recovered safely");
      expect(await readFile(lockPath, "utf8")).toBe(record);
      await rm(lockPath);
    }
    await mkdir(lockPath);
    await expect(acquireStateDirectoryLock(stateDirectory)).rejects.toThrow("cannot be recovered safely");
    expect(await readdir(lockPath)).toEqual([]);
    await writeFile(path.join(lockPath, "unknown.json"), "unrecognized owner");
    await expect(acquireStateDirectoryLock(stateDirectory)).rejects.toThrow("cannot be recovered safely");
    expect(await readFile(path.join(lockPath, "unknown.json"), "utf8")).toBe("unrecognized owner");
  });
});
