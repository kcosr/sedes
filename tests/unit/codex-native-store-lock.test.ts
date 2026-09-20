import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BackendModule,
  BackendNativeStoreLifecycle,
  PreparedBackendModule,
} from "../../src/server/backends/module.js";
import { createCodexNativeStoreLifecycle } from "../../src/server/backends/codex/codex-native-store-lock.js";
import {
  CodexNativeStoreOwnershipGate,
  CodexNativeStoreRetentionError,
  guardCodexNativeStoreLease,
} from "../../src/server/backends/codex/codex-native-store-ownership.js";
import { planBackendNativeStores } from "../../src/server/runtime/backend-module-startup.js";

const filesystemHooks = vi.hoisted(() => ({
  beforeRename: undefined as
    ((oldPath: string, newPath: string) => Promise<void>) | undefined,
  beforeWriteFile: undefined as
    ((filename: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string) => {
      const hook = filesystemHooks.beforeRename;
      filesystemHooks.beforeRename = undefined;
      await hook?.(oldPath, newPath);
      return await actual.rename(oldPath, newPath);
    },
    writeFile: async (
      filename: string,
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) => {
      const hook = filesystemHooks.beforeWriteFile;
      filesystemHooks.beforeWriteFile = undefined;
      await hook?.(filename);
      return await actual.writeFile(filename, data, options);
    },
  };
});

const fixture = fileURLToPath(
  new URL("../fixtures/codex-native-store-lock-holder.mjs", import.meta.url),
);
const lockName = ".harness-codex-runtime.lock";
const temporaryPaths: string[] = [];

afterEach(async () => {
  filesystemHooks.beforeRename = undefined;
  filesystemHooks.beforeWriteFile = undefined;
  for (const filename of temporaryPaths.splice(0).reverse()) {
    await rm(filename, { recursive: true, force: true });
  }
});

async function temporaryHome(): Promise<string> {
  const value = await mkdtemp(path.join(homedir(), ".sedes-codex-lock-test-"));
  temporaryPaths.push(value);
  return await realpath(value);
}

function lifecycle(codexHome: string) {
  return createCodexNativeStoreLifecycle({
    canonicalCodexHome: codexHome,
    label: "Codex test namespace",
    ownership: new CodexNativeStoreOwnershipGate(),
  });
}

function preparedModule(
  backendInstanceId: string,
  store: BackendNativeStoreLifecycle,
): PreparedBackendModule {
  return {
    backendInstanceId,
    module: {} as BackendModule,
    nativeNamespaces: [
      { sortKey: store.sortKey, namespaceKey: store.namespaceKey },
    ],
    nativeStores: [store],
    createRuntime: () => {
      throw new Error("test_runtime_not_available");
    },
  };
}

describe("Codex native store lock", () => {
  it("blocks from launch until proven close and never clears a cleanup failure", async () => {
    const ownership = new CodexNativeStoreOwnershipGate();
    expect(ownership.snapshot()).toEqual({
      state: "prelaunch",
      releaseSafety: "safe",
    });

    ownership.armLaunch();
    expect(() => ownership.assertReleaseSafe()).toThrow(
      "codex_native_store_retained_cleanup_unproven",
    );
    expect(ownership.snapshot()).toEqual({
      state: "launch_armed",
      releaseSafety: "blocked",
      retentionReason: "codex_daemon_cleanup_unproven",
    });

    ownership.proveClosed();
    expect(() => ownership.assertReleaseSafe()).not.toThrow();
    expect(ownership.snapshot()).toEqual({
      state: "proven_closed",
      releaseSafety: "safe",
    });

    ownership.armLaunch();
    ownership.latchCleanupFailure(new Error("unknown-cleanup-failure"));
    ownership.proveClosed();
    expect(ownership.snapshot()).toEqual({
      state: "cleanup_failed",
      releaseSafety: "blocked",
      retentionReason: "codex_daemon_cleanup_unproven",
    });
  });

  it("retains a guarded lease after cleanup uncertainty is latched", async () => {
    const release = vi.fn(async () => undefined);
    const ownership = new CodexNativeStoreOwnershipGate();
    const lease = guardCodexNativeStoreLease({ release }, ownership);

    ownership.armLaunch();
    ownership.latchCleanupFailure(new Error("orphaned_process_group"));
    ownership.latchCleanupFailure(new Error("process_cleanup_failed"));

    await expect(lease.release()).rejects.toMatchObject({
      name: "CodexNativeStoreRetentionError",
      message: "codex_native_store_retained_cleanup_unproven",
      retentionReason: "orphaned_process_group",
      cleanupUncertainty: "orphaned_process_group",
    } satisfies Partial<CodexNativeStoreRetentionError>);
    expect(release).not.toHaveBeenCalled();
    expect(ownership.snapshot()).toEqual({
      state: "cleanup_failed",
      releaseSafety: "blocked",
      retentionReason: "orphaned_process_group",
      cleanupUncertainty: "orphaned_process_group",
    });
  });

  it("shares a safe guarded release and remains idempotent", async () => {
    let finish!: () => void;
    const release = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const lease = guardCodexNativeStoreLease(
      { release },
      new CodexNativeStoreOwnershipGate(),
    );

    const first = lease.release();
    const second = lease.release();
    expect(first).toBe(second);
    expect(release).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await lease.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("deduplicates aliases and cleanly reacquires after idempotent release", async () => {
    const codexHome = await temporaryHome();
    const alias = `${codexHome}-alias`;
    temporaryPaths.push(alias);
    await symlink(codexHome, alias, "dir");
    const direct = lifecycle(codexHome);
    const throughAlias = lifecycle(alias);
    expect(direct.namespaceKey).toBe(
      createHash("sha256")
        .update("harness.codex-native-store.v1\n")
        .update(codexHome)
        .digest("hex"),
    );
    expect(throughAlias.namespaceKey).toBe(direct.namespaceKey);
    expect(throughAlias.sortKey).toBe(direct.sortKey);
    expect(() =>
      planBackendNativeStores([
        preparedModule("codex-one", direct),
        preparedModule("codex-two", throughAlias),
      ]),
    ).toThrow("backend_native_namespace_reused");

    const first = await direct.acquire();
    await expect(throughAlias.acquire()).rejects.toThrow(
      "codex_native_store_already_locked",
    );
    await first.release();
    await first.release();
    const second = await throughAlias.acquire();
    await second.release();
  });

  it("permits exactly one winner in a real two-process race", async () => {
    const codexHome = await temporaryHome();
    const children = [spawnHolder(codexHome), spawnHolder(codexHome)];
    const outcomes = await Promise.all(children.map(readOutcome));
    expect(outcomes.filter((value) => value === "acquired")).toHaveLength(1);
    expect(
      outcomes.filter((value) =>
        /codex_native_store_(?:already_locked|stale_lock_requires_operator)/u.test(
          value,
        ),
      ),
    ).toHaveLength(1);
    const winner = children[outcomes.indexOf("acquired")]!;
    winner.stdin.end();
    await childExit(winner);
  });

  it("refuses a stale SIGKILL marker without stealing it", async () => {
    const codexHome = await temporaryHome();
    const child = spawnHolder(codexHome);
    await expect(readOutcome(child)).resolves.toBe("acquired");
    child.kill("SIGKILL");
    await childExit(child);

    await expect(lifecycle(codexHome).acquire()).rejects.toThrow(
      "codex_native_store_stale_lock_requires_operator",
    );
    expect(
      await readFile(path.join(codexHome, lockName, "owner.json"), "utf8"),
    ).not.toContain(codexHome);
  });

  it("never deletes a tampered token or replacement lock directory", async () => {
    const tokenHome = await temporaryHome();
    const tokenLease = await lifecycle(tokenHome).acquire();
    const tokenOwner = path.join(tokenHome, lockName, "owner.json");
    await writeFile(
      tokenOwner,
      JSON.stringify({ version: 1, pid: process.pid, nonce: "tampered" }),
    );
    await expect(tokenLease.release()).rejects.toThrow(
      "codex_native_store_lock_identity_changed",
    );
    expect(await readFile(tokenOwner, "utf8")).toContain("tampered");

    const replacementHome = await temporaryHome();
    const replacementLease = await lifecycle(replacementHome).acquire();
    const original = path.join(replacementHome, lockName);
    const moved = path.join(replacementHome, `${lockName}.moved`);
    await rename(original, moved);
    await mkdir(original, { mode: 0o700 });
    await writeFile(
      path.join(original, "owner.json"),
      JSON.stringify({ version: 1, pid: process.pid, nonce: "replacement" }),
    );
    await expect(replacementLease.release()).rejects.toThrow(
      "codex_native_store_lock_identity_changed",
    );
    expect(await readFile(path.join(original, "owner.json"), "utf8")).toContain(
      "replacement",
    );
  });

  it("quarantines but never deletes a lock swapped after release validation", async () => {
    const codexHome = await temporaryHome();
    const lease = await lifecycle(codexHome).acquire();
    const original = path.join(codexHome, lockName);
    const movedOwner = path.join(codexHome, `${lockName}.original`);
    const replacementOwner = JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: "replacement-after-precheck",
    });
    filesystemHooks.beforeRename = async (oldPath) => {
      expect(oldPath).toBe(original);
      await rename(original, movedOwner);
      await mkdir(original, { mode: 0o700 });
      await writeFile(path.join(original, "owner.json"), replacementOwner, {
        mode: 0o600,
      });
    };

    await expect(lease.release()).rejects.toThrow(
      "codex_native_store_lock_identity_changed",
    );

    const entries = await readdir(codexHome);
    const quarantine = entries.find((entry) =>
      entry.startsWith(`${lockName}.release-`),
    );
    expect(quarantine).toBeDefined();
    expect(
      await readFile(path.join(codexHome, quarantine!, "owner.json"), "utf8"),
    ).toBe(replacementOwner);
    expect(
      await readFile(path.join(movedOwner, "owner.json"), "utf8"),
    ).not.toBe(replacementOwner);
    expect(entries).toContain(lockName);
  });

  it("retries cleanup after owner removal without touching a new canonical lock", async () => {
    const codexHome = await temporaryHome();
    const lease = await lifecycle(codexHome).acquire();
    await writeFile(path.join(codexHome, lockName, "unexpected"), "retained");

    await expect(lease.release()).rejects.toThrow(
      "codex_native_store_release_cleanup_failed",
    );
    const quarantine = (await readdir(codexHome)).find((entry) =>
      entry.startsWith(`${lockName}.release-`),
    );
    expect(quarantine).toBeDefined();
    const replacementLease = await lifecycle(codexHome).acquire();
    const replacementOwner = await readFile(
      path.join(codexHome, lockName, "owner.json"),
      "utf8",
    );
    await rm(path.join(codexHome, quarantine!, "unexpected"));
    await lease.release();
    expect(await readdir(codexHome)).not.toContain(quarantine);
    expect(
      await readFile(path.join(codexHome, lockName, "owner.json"), "utf8"),
    ).toBe(replacementOwner);

    await replacementLease.release();
  });

  it("leaves a fail-closed marker when owner initialization fails", async () => {
    const codexHome = await temporaryHome();
    filesystemHooks.beforeWriteFile = async (filename) => {
      throw Object.assign(new Error(`injected write failure: ${filename}`), {
        code: "EIO",
      });
    };

    await expect(lifecycle(codexHome).acquire()).rejects.toThrow(
      "codex_native_store_owner_write_failed",
    );
    expect(await readdir(codexHome)).toContain(lockName);
    await expect(lifecycle(codexHome).acquire()).rejects.toThrow(
      "codex_native_store_stale_lock_requires_operator",
    );
  });

  it("rejects symlinked, oversized, and permission-unsafe owner metadata", async () => {
    const codexHome = await temporaryHome();
    const lockDirectory = path.join(codexHome, lockName);
    await mkdir(lockDirectory, { mode: 0o700 });
    const external = path.join(codexHome, "external-owner");
    await writeFile(
      external,
      JSON.stringify({ version: 1, pid: process.pid, nonce: "external" }),
    );
    await symlink(external, path.join(lockDirectory, "owner.json"));

    await expect(lifecycle(codexHome).acquire()).rejects.toThrow(
      "codex_native_store_stale_lock_requires_operator",
    );
    expect(await readFile(external, "utf8")).toContain("external");

    const oversizedHome = await temporaryHome();
    const oversizedLease = await lifecycle(oversizedHome).acquire();
    const oversizedOwner = path.join(oversizedHome, lockName, "owner.json");
    await writeFile(oversizedOwner, "x".repeat(257));
    await expect(oversizedLease.release()).rejects.toThrow(
      "codex_native_store_lock_identity_changed",
    );
    expect(await readFile(oversizedOwner, "utf8")).toHaveLength(257);

    const unsafeHome = await temporaryHome();
    const unsafeLease = await lifecycle(unsafeHome).acquire();
    const unsafeOwner = path.join(unsafeHome, lockName, "owner.json");
    await chmod(unsafeOwner, 0o644);
    if (process.platform === "win32") {
      await unsafeLease.release();
      expect(await readdir(unsafeHome)).not.toContain(lockName);
    } else {
      await expect(unsafeLease.release()).rejects.toThrow(
        "codex_native_store_lock_identity_changed",
      );
      expect(await readFile(unsafeOwner, "utf8")).not.toBe("");
    }
  });

  it("does not follow a replaced owner file to an unbounded device", async () => {
    const codexHome = await temporaryHome();
    const lease = await lifecycle(codexHome).acquire();
    const owner = path.join(codexHome, lockName, "owner.json");
    await rm(owner);
    await symlink("/dev/zero", owner);

    await expect(lease.release()).rejects.toThrow(
      "codex_native_store_lock_identity_changed",
    );
    expect((await lstat(owner)).isSymbolicLink()).toBe(true);
  });

  it("requires an absolute home directory and allows non-private modes", async () => {
    expect(() => lifecycle("relative/codex")).toThrow(
      "codex_native_store_lock_configuration_invalid",
    );
    const codexHome = await temporaryHome();
    await chmod(codexHome, 0o750);
    const lease = await lifecycle(codexHome).acquire();
    await lease.release();
  });

  it("normalizes path-bearing filesystem failures", async () => {
    const parent = await temporaryHome();
    const missing = path.join(parent, "missing");
    expect(() => lifecycle(missing)).toThrow(
      "codex_native_store_home_unavailable",
    );

    const codexHome = await temporaryHome();
    const prepared = lifecycle(codexHome);
    await rm(codexHome, { recursive: true, force: true });
    await expect(prepared.acquire()).rejects.toThrow(
      "codex_native_store_home_unavailable",
    );
  });
});

function spawnHolder(codexHome: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", "tsx", fixture, codexHome], {
    cwd: path.dirname(fixture),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function readOutcome(
  child: ChildProcessWithoutNullStreams,
): Promise<string> {
  child.stdout.setEncoding("utf8");
  return await new Promise((resolve, reject) => {
    let value = "";
    child.stdout.on("data", (chunk: string) => {
      value += chunk;
      const newline = value.indexOf("\n");
      if (newline >= 0) resolve(value.slice(0, newline));
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!value.includes("\n")) {
        reject(new Error(`lock_fixture_exited:${String(code)}`));
      }
    });
  });
}

async function childExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
