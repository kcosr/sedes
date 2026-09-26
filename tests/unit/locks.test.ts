import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

async function writeLock(lockPath: string, record: Record<string, unknown>) {
  await writeFile(
    lockPath,
    `${JSON.stringify({ startedAt: new Date(0).toISOString(), ...record })}\n`,
    { mode: 0o600 },
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("exclusive process locks", () => {
  it("excludes a second owner and releases only its own lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-lock-"));
    roots.push(root);
    const stateDirectory = path.join(root, "state");
    const first = await acquireStateDirectoryLock(stateDirectory);
    const lockPath = path.join(stateDirectory, ".state.lock");
    const metadata = JSON.parse(await readFile(lockPath, "utf8")) as {
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
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        startedAt: new Date(0).toISOString(),
        identityHash,
        ownerToken: "stale-owner",
      })}\n`,
      { mode: 0o600 },
    );

    const owner = await acquireStateDirectoryLock(stateDirectory);
    const replacementMetadata = {
      ...(JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>),
      ownerToken: "replacement-owner",
    };
    await writeFile(lockPath, `${JSON.stringify(replacementMetadata)}\n`);
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
      const metadata = JSON.parse(
        await readFile(path.join(stateDirectory, ".state.lock"), "utf8"),
      ) as Record<string, unknown>;
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

  it("keeps a live owner's lock, including PID-only records from older builds", async () => {
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
});
