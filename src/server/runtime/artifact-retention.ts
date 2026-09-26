import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { readProcessCommandLines } from "./process-table.js";

const PRUNE_PREFIX = ".prune-";

export interface UnreferencedBuildPruneOptions {
  /** Private directory whose immediate children are content-addressed builds. */
  readonly root: string;
  /** Build names that are never removed, such as the running build. */
  readonly keep: ReadonlySet<string>;
  /** Most recently modified other builds kept for rollback. */
  readonly retain: number;
  /** Builds modified more recently than this may still be in use by an installer. */
  readonly minimumAgeMilliseconds: number;
  readonly namePattern: RegExp;
  readonly now?: () => number;
  readonly readCommandLines?: () => Promise<ReadonlyMap<number, string>>;
}

/**
 * Removes superseded builds that no live process references. A build is kept
 * when it is explicitly kept, among the newest `retain` others, recently
 * modified, or named in any visible process command line. Throws without
 * removing anything when process command lines cannot be read.
 */
export async function pruneUnreferencedBuilds(
  options: UnreferencedBuildPruneOptions,
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(options.retain) || options.retain < 0 ||
      !Number.isSafeInteger(options.minimumAgeMilliseconds) || options.minimumAgeMilliseconds < 0) {
    throw new Error("artifact_retention_options_invalid");
  }
  const now = (options.now ?? Date.now)();
  const entries = await readdir(options.root, { withFileTypes: true });
  // Finish removals a previous run renamed away but could not delete.
  for (const entry of entries) {
    if (entry.name.startsWith(PRUNE_PREFIX) && entry.isDirectory()) {
      await rm(path.join(options.root, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const builds: { readonly name: string; readonly modified: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !options.namePattern.test(entry.name) || options.keep.has(entry.name)) continue;
    const metadata = await lstat(path.join(options.root, entry.name));
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      builds.push({ name: entry.name, modified: metadata.mtimeMs });
    }
  }
  const candidates = builds
    .sort((left, right) => right.modified - left.modified)
    .slice(options.retain)
    .filter((build) => now - build.modified >= options.minimumAgeMilliseconds);
  if (candidates.length === 0) return [];
  const commandLines = [...(await (options.readCommandLines ?? readProcessCommandLines)()).values()];
  const removed: string[] = [];
  for (const { name } of candidates) {
    const directory = path.join(options.root, name);
    if (commandLines.some((line) => line.includes(`${directory}${path.sep}`) || line.includes(`${directory} `) ||
        line.endsWith(directory))) {
      continue;
    }
    // Rename first so a partial removal never looks like an installed build.
    const retired = path.join(options.root, `${PRUNE_PREFIX}${randomUUID()}`);
    try {
      await rename(directory, retired);
    } catch {
      continue;
    }
    removed.push(name);
    await rm(retired, { recursive: true, force: true }).catch(() => undefined);
  }
  return removed;
}
