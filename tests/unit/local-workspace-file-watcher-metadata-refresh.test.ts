import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalWorkspaceFileWatcherRegistry } from "../../src/server/workspace-files/local-workspace-file-watcher.js";

// Counts the watcher's `git rev-parse` metadata probes without spawning git.
const gitProbes = vi.hoisted(() => ({ started: 0, active: 0, maximumActive: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(
    () => {
      throw new Error("unexpected_callback_exec_file");
    },
    {
      [promisify.custom]: async () => {
        gitProbes.started += 1;
        gitProbes.active += 1;
        gitProbes.maximumActive = Math.max(gitProbes.maximumActive, gitProbes.active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        gitProbes.active -= 1;
        return { stdout: "", stderr: "" };
      },
    },
  );
  return { ...actual, execFile };
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

function fakeWatchFactory() {
  const listeners: (() => void)[] = [];
  const watchFactory = (
    _path: string,
    _options: { readonly recursive: boolean },
    listener: () => void,
  ): FSWatcher => {
    listeners.push(listener);
    const watcher = new EventEmitter() as FSWatcher;
    watcher.close = vi.fn(() => watcher.emit("close"));
    watcher.ref = vi.fn(() => watcher);
    watcher.unref = vi.fn(() => watcher);
    return watcher;
  };
  return { watchFactory, rootEvent: () => listeners[0]!() };
}

describe("LocalWorkspaceFileWatcherRegistry metadata refresh", () => {
  it("coalesces a filesystem event burst into bounded serialized git probes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-watch-burst-"));
    roots.push(root);
    const { watchFactory, rootEvent } = fakeWatchFactory();
    const registry = new LocalWorkspaceFileWatcherRegistry({
      debounceMilliseconds: 20,
      maximumLatencyMilliseconds: 100,
      watchFactory,
    });
    const listener = vi.fn();
    const subscription = await registry.subscribe("scope\0burst", root, listener);
    const initialProbes = gitProbes.started;
    expect(initialProbes).toBe(1);

    for (let event = 0; event < 1_000; event += 1) rootEvent();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(gitProbes.started - initialProbes).toBeGreaterThanOrEqual(1);
    expect(gitProbes.started - initialProbes).toBeLessThanOrEqual(2);
    expect(gitProbes.maximumActive).toBe(1);
    expect(gitProbes.active).toBe(0);

    // A later event after the burst is still observed by its own refresh.
    const beforeLateEvent = gitProbes.started;
    rootEvent();
    await vi.waitFor(() => expect(gitProbes.started).toBe(beforeLateEvent + 1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(gitProbes.started).toBe(beforeLateEvent + 1);

    subscription.close();
    rootEvent();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(gitProbes.started).toBe(beforeLateEvent + 1);
    registry.close();
  });
});
