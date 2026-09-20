import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceFileWatchSubscription } from "./contracts.js";
import { pathIsWithin } from "../path-containment.js";

const executeFile = promisify(execFile);
const DEFAULT_MAXIMUM_ACTIVE_ROOTS = 32;
const DEFAULT_DEBOUNCE_MILLISECONDS = 150;
const DEFAULT_MAXIMUM_LATENCY_MILLISECONDS = 1_000;
const MAXIMUM_GIT_METADATA_WATCHES = 3;

interface WatchEntry {
  readonly listeners: Set<() => void>;
  readonly watchers: FSWatcher[];
  readonly metadataWatchers: Map<string, FSWatcher>;
  readonly failure: Promise<void>;
  readonly resolveFailure: () => void;
  failed: boolean;
  closing: boolean;
  debounceTimer?: NodeJS.Timeout;
  maximumTimer?: NodeJS.Timeout;
  metadataRefresh?: Promise<void>;
}

export interface LocalWorkspaceFileWatcherOptions {
  readonly maximumActiveRoots?: number;
  readonly debounceMilliseconds?: number;
  readonly maximumLatencyMilliseconds?: number;
  readonly watchFactory?: (
    path: string,
    options: { readonly recursive: boolean },
    listener: () => void,
  ) => FSWatcher;
}

/**
 * Process-local invalidation watchers. They retain neither changed paths nor
 * file contents; callback filenames are deliberately discarded at the fs
 * boundary. One ref-counted entry exists per authorized scoped file root.
 */
export class LocalWorkspaceFileWatcherRegistry {
  readonly #entries = new Map<string, WatchEntry>();
  readonly #pending = new Map<string, Promise<WatchEntry>>();
  readonly #maximumActiveRoots: number;
  readonly #debounceMilliseconds: number;
  readonly #maximumLatencyMilliseconds: number;
  readonly #watchFactory: NonNullable<
    LocalWorkspaceFileWatcherOptions["watchFactory"]
  >;
  #closed = false;

  constructor(options: LocalWorkspaceFileWatcherOptions = {}) {
    this.#maximumActiveRoots = positiveInteger(
      options.maximumActiveRoots ?? DEFAULT_MAXIMUM_ACTIVE_ROOTS,
      "workspace_file_watcher_limit_invalid",
    );
    this.#debounceMilliseconds = positiveInteger(
      options.debounceMilliseconds ?? DEFAULT_DEBOUNCE_MILLISECONDS,
      "workspace_file_watcher_debounce_invalid",
    );
    this.#maximumLatencyMilliseconds = positiveInteger(
      options.maximumLatencyMilliseconds ??
        DEFAULT_MAXIMUM_LATENCY_MILLISECONDS,
      "workspace_file_watcher_latency_invalid",
    );
    if (this.#maximumLatencyMilliseconds < this.#debounceMilliseconds) {
      throw new Error("workspace_file_watcher_latency_invalid");
    }
    this.#watchFactory =
      options.watchFactory ??
      ((filename, watchOptions, listener) =>
        watch(filename, watchOptions, listener));
  }

  get activeRootCount(): number {
    return this.#entries.size;
  }

  async subscribe(
    key: string,
    canonicalRoot: string,
    listener: () => void,
  ): Promise<WorkspaceFileWatchSubscription> {
    if (this.#closed) throw new Error("workspace_file_watcher_closed");
    let entry = this.#entries.get(key);
    if (!entry) {
      let pending = this.#pending.get(key);
      if (!pending) {
        if (
          this.#entries.size + this.#pending.size >=
          this.#maximumActiveRoots
        ) {
          throw new Error("workspace_file_watcher_capacity_exceeded");
        }
        pending = this.#createEntry(key, canonicalRoot);
        this.#pending.set(key, pending);
      }
      try {
        entry = await pending;
      } finally {
        if (this.#pending.get(key) === pending) this.#pending.delete(key);
      }
      if (entry.failed) {
        closeEntry(entry);
        throw new Error("workspace_file_watcher_start_failed");
      }
      if (this.#closed) {
        closeEntry(entry);
        throw new Error("workspace_file_watcher_closed");
      }
      const concurrent = this.#entries.get(key);
      if (concurrent && concurrent !== entry) {
        closeEntry(entry);
        entry = concurrent;
      } else if (!concurrent) {
        this.#entries.set(key, entry);
      }
    }
    entry.listeners.add(listener);
    let closed = false;
    return {
      failed: entry.failure,
      close: () => {
        if (closed) return;
        closed = true;
        entry!.listeners.delete(listener);
        if (entry!.listeners.size !== 0 || this.#entries.get(key) !== entry) {
          return;
        }
        this.#entries.delete(key);
        closeEntry(entry!);
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#entries.values()) closeEntry(entry);
    this.#entries.clear();
    for (const pending of this.#pending.values()) {
      void pending.then(closeEntry, () => undefined);
    }
    this.#pending.clear();
  }

  async #createEntry(key: string, canonicalRoot: string): Promise<WatchEntry> {
    let resolveFailure!: () => void;
    const failure = new Promise<void>((resolve) => {
      resolveFailure = resolve;
    });
    const entry: WatchEntry = {
      listeners: new Set(),
      watchers: [],
      metadataWatchers: new Map(),
      failure,
      resolveFailure,
      failed: false,
      closing: false,
    };
    const invalidate = (): void => {
      this.#schedule(entry);
      this.#enqueueMetadataRefresh(key, entry, canonicalRoot, invalidate);
    };
    try {
      const resolvedRoot = await realpath(canonicalRoot);
      const rootMetadata = await stat(resolvedRoot);
      if (resolvedRoot !== canonicalRoot || !rootMetadata.isDirectory()) {
        throw new Error("workspace_file_watcher_root_changed");
      }
      // The sidecar's Node 22.19 floor supports recursive fs.watch on Linux.
      // The registry bounds active file roots and coalesces delivered work.
      this.#addWatcher(
        key,
        entry,
        this.#watchFactory(canonicalRoot, { recursive: true }, invalidate),
      );
      await this.#replaceMetadataWatchers(
        key,
        entry,
        canonicalRoot,
        invalidate,
      );
      if (entry.failed) throw new Error("workspace_file_watcher_lost_health");
      return entry;
    } catch (error) {
      closeEntry(entry);
      throw new Error("workspace_file_watcher_start_failed", { cause: error });
    }
  }

  #addWatcher(
    key: string,
    entry: WatchEntry,
    watcher: FSWatcher,
    metadataPath?: string,
    recoverMetadata?: () => void,
  ): void {
    entry.watchers.push(watcher);
    if (metadataPath) entry.metadataWatchers.set(metadataPath, watcher);
    const metadataLost = (): void => {
      if (
        !metadataPath ||
        entry.metadataWatchers.get(metadataPath) !== watcher
      ) {
        return;
      }
      entry.metadataWatchers.delete(metadataPath);
      const index = entry.watchers.indexOf(watcher);
      if (index >= 0) entry.watchers.splice(index, 1);
      recoverMetadata?.();
    };
    watcher.once("error", () => {
      if (metadataPath) metadataLost();
      else this.#fail(key, entry);
    });
    watcher.once("close", () => {
      if (entry.closing) return;
      if (metadataPath) metadataLost();
      else this.#fail(key, entry);
    });
  }

  #enqueueMetadataRefresh(
    key: string,
    entry: WatchEntry,
    canonicalRoot: string,
    invalidate: () => void,
  ): void {
    if (entry.closing || entry.failed) return;
    entry.metadataRefresh = (entry.metadataRefresh ?? Promise.resolve())
      .then(() =>
        this.#replaceMetadataWatchers(key, entry, canonicalRoot, invalidate),
      )
      .catch(() => this.#fail(key, entry));
  }

  async #replaceMetadataWatchers(
    key: string,
    entry: WatchEntry,
    canonicalRoot: string,
    invalidate: () => void,
  ): Promise<void> {
    if (entry.closing || entry.failed) return;
    const desired = (await gitMetadataDirectories(canonicalRoot))
      .filter((candidate) => !isWithin(canonicalRoot, candidate.path))
      .slice(0, MAXIMUM_GIT_METADATA_WATCHES);
    if (entry.closing || entry.failed) return;
    const desiredPaths = new Set(
      desired.map(({ path: candidate }) => candidate),
    );
    for (const [candidate, watcher] of entry.metadataWatchers) {
      if (desiredPaths.has(candidate)) continue;
      entry.metadataWatchers.delete(candidate);
      const index = entry.watchers.indexOf(watcher);
      if (index >= 0) entry.watchers.splice(index, 1);
      watcher.close();
    }
    for (const candidate of desired) {
      if (entry.metadataWatchers.has(candidate.path)) continue;
      const watcher = this.#watchFactory(
        candidate.path,
        { recursive: candidate.recursive },
        invalidate,
      );
      this.#addWatcher(key, entry, watcher, candidate.path, invalidate);
    }
  }

  #fail(key: string, entry: WatchEntry): void {
    if (entry.failed || entry.closing) return;
    entry.failed = true;
    if (this.#entries.get(key) === entry) this.#entries.delete(key);
    entry.resolveFailure();
    closeEntry(entry);
  }

  #schedule(entry: WatchEntry): void {
    if (this.#closed || entry.listeners.size === 0) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(
      () => this.#flush(entry),
      this.#debounceMilliseconds,
    );
    entry.debounceTimer.unref();
    if (!entry.maximumTimer) {
      entry.maximumTimer = setTimeout(
        () => this.#flush(entry),
        this.#maximumLatencyMilliseconds,
      );
      entry.maximumTimer.unref();
    }
  }

  #flush(entry: WatchEntry): void {
    clearEntryTimers(entry);
    for (const listener of [...entry.listeners]) listener();
  }
}

async function gitMetadataDirectories(
  root: string,
): Promise<readonly { readonly path: string; readonly recursive: boolean }[]> {
  try {
    const { stdout } = await executeFile(
      "git",
      [
        "-C",
        root,
        "rev-parse",
        "--absolute-git-dir",
        "--path-format=absolute",
        "--git-common-dir",
        "--git-path",
        "refs",
        "--git-path",
        "worktrees",
      ],
      { encoding: "utf8", maxBuffer: 16 * 1_024 },
    );
    const [_gitDirectory, commonDirectory, refsDirectory, worktreesDirectory] =
      stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
    const requested = [
      // A linked worktree can be added beneath an already-existing
      // <common>/worktrees directory without changing the common directory.
      // Watch both the parent (for first creation) and existing subtree.
      commonDirectory ? { path: commonDirectory, recursive: false } : undefined,
      worktreesDirectory
        ? { path: worktreesDirectory, recursive: true }
        : undefined,
      refsDirectory ? { path: refsDirectory, recursive: true } : undefined,
    ].filter((value) => value !== undefined);
    const seen = new Set<string>();
    const result: { path: string; recursive: boolean }[] = [];
    for (const candidate of requested) {
      if (!path.isAbsolute(candidate.path)) continue;
      const canonical = await realpath(candidate.path).catch(() => undefined);
      if (!canonical || seen.has(canonical)) continue;
      const metadata = await stat(canonical).catch(() => undefined);
      if (!metadata?.isDirectory()) continue;
      seen.add(canonical);
      result.push({ path: canonical, recursive: candidate.recursive });
    }
    return result;
  } catch {
    return [];
  }
}

function isWithin(root: string, candidate: string): boolean {
  return pathIsWithin(root, candidate);
}

function closeEntry(entry: WatchEntry): void {
  entry.closing = true;
  clearEntryTimers(entry);
  for (const watcher of entry.watchers) watcher.close();
  entry.watchers.length = 0;
  entry.metadataWatchers.clear();
  entry.listeners.clear();
}

function clearEntryTimers(entry: WatchEntry): void {
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  if (entry.maximumTimer) clearTimeout(entry.maximumTimer);
  entry.debounceTimer = undefined;
  entry.maximumTimer = undefined;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}
