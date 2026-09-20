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

const roots: string[] = [];

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
