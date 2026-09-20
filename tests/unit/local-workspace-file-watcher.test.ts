import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync, type FSWatcher } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalWorkspaceFileWatcherRegistry } from "../../src/server/workspace-files/local-workspace-file-watcher.js";

const executeFile = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("LocalWorkspaceFileWatcherRegistry", () => {
  it("coalesces nested working-tree changes without exposing changed paths", async () => {
    const root = await temporaryRoot("sedes-file-watch-");
    await mkdir(path.join(root, "src"));
    const registry = new LocalWorkspaceFileWatcherRegistry({
      debounceMilliseconds: 20,
      maximumLatencyMilliseconds: 100,
    });
    const listener = vi.fn();
    const subscription = await registry.subscribe(
      "scope\0workspace",
      root,
      listener,
    );

    // Complete one burst before yielding to watcher delivery. Separate awaited
    // writes can legitimately cross the debounce window on a busy test host.
    writeFileSync(path.join(root, "src", "one.ts"), "one");
    writeFileSync(path.join(root, "src", "two.ts"), "two");
    await waitFor(() => listener.mock.calls.length > 0);
    expect(listener.mock.calls[0]).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(listener).toHaveBeenCalledTimes(1);

    subscription.close();
    expect(registry.activeRootCount).toBe(0);
    await writeFile(path.join(root, "src", "three.ts"), "three");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(listener).toHaveBeenCalledTimes(1);
    registry.close();
  });

  it("observes index changes in a linked worktree with an external gitdir", async () => {
    const parent = await temporaryRoot("sedes-linked-watch-");
    const root = path.join(parent, "workspace");
    const gitDirectory = path.join(parent, "metadata.git");
    await mkdir(root);
    await executeFile("git", [
      "init",
      "--separate-git-dir",
      gitDirectory,
      root,
    ]);
    await writeFile(path.join(root, "tracked.txt"), "tracked\n");
    const registry = new LocalWorkspaceFileWatcherRegistry({
      debounceMilliseconds: 20,
      maximumLatencyMilliseconds: 100,
    });
    const listener = vi.fn();
    const subscription = await registry.subscribe(
      "scope\0linked",
      root,
      listener,
    );

    // The file predates the watcher. Only Git's external index changes here.
    await executeFile("git", ["-C", root, "add", "tracked.txt"]);
    await waitFor(() => listener.mock.calls.length > 0);
    expect(listener.mock.calls[0]).toEqual([]);

    subscription.close();
    registry.close();
  });

  it("observes additions and removals beneath an existing common worktrees directory", async () => {
    const parent = await temporaryRoot("sedes-worktree-topology-watch-");
    const primary = path.join(parent, "primary");
    const linked = path.join(parent, "linked");
    const later = path.join(parent, "later");
    await mkdir(primary);
    await executeFile("git", ["init", "-q", primary]);
    await executeFile("git", ["-C", primary, "config", "user.name", "Test"]);
    await executeFile("git", [
      "-C",
      primary,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await writeFile(path.join(primary, "tracked.txt"), "tracked\n");
    await executeFile("git", ["-C", primary, "add", "."]);
    await executeFile("git", ["-C", primary, "commit", "-qm", "initial"]);
    await executeFile("git", [
      "-C",
      primary,
      "worktree",
      "add",
      "-q",
      "--detach",
      linked,
    ]);
    const registry = new LocalWorkspaceFileWatcherRegistry({
      debounceMilliseconds: 20,
      maximumLatencyMilliseconds: 100,
    });
    const listener = vi.fn();
    const subscription = await registry.subscribe(
      "scope\0topology",
      linked,
      listener,
    );

    await executeFile("git", [
      "-C",
      primary,
      "worktree",
      "add",
      "-q",
      "--detach",
      later,
    ]);
    await waitFor(() => listener.mock.calls.length > 0);
    listener.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 120));
    listener.mockClear();
    await executeFile("git", [
      "-C",
      primary,
      "worktree",
      "remove",
      "--force",
      later,
    ]);
    await waitFor(() => listener.mock.calls.length > 0);

    subscription.close();
    registry.close();
  });

  it("observes worktree topology created after watching a repository subdirectory", async () => {
    const parent = await temporaryRoot("sedes-late-worktree-watch-");
    const primary = path.join(parent, "primary");
    const project = path.join(primary, "packages", "app");
    const linked = path.join(parent, "linked");
    await mkdir(project, { recursive: true });
    await executeFile("git", ["init", "-q", primary]);
    await executeFile("git", ["-C", primary, "config", "user.name", "Test"]);
    await executeFile("git", [
      "-C",
      primary,
      "config",
      "user.email",
      "test@example.invalid",
    ]);
    await writeFile(path.join(project, "tracked.txt"), "tracked\n");
    await executeFile("git", ["-C", primary, "add", "."]);
    await executeFile("git", ["-C", primary, "commit", "-qm", "initial"]);
    const registry = new LocalWorkspaceFileWatcherRegistry({
      debounceMilliseconds: 20,
      maximumLatencyMilliseconds: 100,
    });
    const listener = vi.fn();
    const subscription = await registry.subscribe(
      "scope\0late-topology",
      project,
      listener,
    );

    await executeFile("git", [
      "-C",
      primary,
      "worktree",
      "add",
      "-q",
      "--detach",
      linked,
    ]);
    await waitFor(() => listener.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    listener.mockClear();
    await executeFile("git", [
      "-C",
      primary,
      "worktree",
      "remove",
      "--force",
      linked,
    ]);
    await waitFor(() => listener.mock.calls.length > 0);

    subscription.close();
    registry.close();
  });

  it("counts roots toward capacity and ref-counts subscribers", async () => {
    const firstRoot = await temporaryRoot("sedes-watch-first-");
    const secondRoot = await temporaryRoot("sedes-watch-second-");
    const registry = new LocalWorkspaceFileWatcherRegistry({
      maximumActiveRoots: 1,
    });
    const [first, peer] = await Promise.all([
      registry.subscribe("workspace\0primary", firstRoot, () => undefined),
      registry.subscribe("workspace\0primary", firstRoot, () => undefined),
    ]);
    expect(registry.activeRootCount).toBe(1);
    await expect(
      registry.subscribe(
        "workspace\0supplemental",
        secondRoot,
        () => undefined,
      ),
    ).rejects.toThrow("workspace_file_watcher_capacity_exceeded");

    first.close();
    expect(registry.activeRootCount).toBe(1);
    peer.close();
    expect(registry.activeRootCount).toBe(0);
    const second = await registry.subscribe(
      "workspace\0supplemental",
      secondRoot,
      () => undefined,
    );
    expect(registry.activeRootCount).toBe(1);
    registry.close();
    expect(registry.activeRootCount).toBe(0);
    second.close();
  });

  it("releases a failed root start without disabling another root", async () => {
    const root = await temporaryRoot("sedes-watch-after-failure-");
    const missing = path.join(root, "missing");
    const registry = new LocalWorkspaceFileWatcherRegistry({
      maximumActiveRoots: 1,
    });

    await expect(
      registry.subscribe("workspace\0missing", missing, () => undefined),
    ).rejects.toThrow("workspace_file_watcher_start_failed");
    expect(registry.activeRootCount).toBe(0);

    const subscription = await registry.subscribe(
      "workspace\0available",
      root,
      () => undefined,
    );
    expect(registry.activeRootCount).toBe(1);
    subscription.close();
    registry.close();
  });

  it.each(["error", "close"] as const)(
    "evicts a root after an unexpected watcher %s and reports lost health",
    async (event) => {
      const root = await temporaryRoot("sedes-watch-runtime-failure-");
      const created: FSWatcher[] = [];
      const registry = new LocalWorkspaceFileWatcherRegistry({
        maximumActiveRoots: 1,
        watchFactory: () => {
          const watcher = new EventEmitter() as FSWatcher;
          watcher.close = vi.fn(() => watcher.emit("close"));
          watcher.ref = vi.fn(() => watcher);
          watcher.unref = vi.fn(() => watcher);
          created.push(watcher);
          return watcher;
        },
      });
      const subscription = await registry.subscribe(
        "workspace\0root",
        root,
        () => undefined,
      );
      expect(registry.activeRootCount).toBe(1);

      if (event === "error") created[0]!.emit("error", new Error("lost"));
      else created[0]!.emit("close");
      await subscription.failed;
      expect(registry.activeRootCount).toBe(0);

      const replacement = await registry.subscribe(
        "workspace\0replacement",
        root,
        () => undefined,
      );
      let intentionalCloseReportedFailure = false;
      void replacement.failed.then(() => {
        intentionalCloseReportedFailure = true;
      });
      replacement.close();
      await Promise.resolve();
      expect(intentionalCloseReportedFailure).toBe(false);
      registry.close();
    },
  );
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("watcher_event_not_observed");
}
