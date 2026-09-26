import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneUnreferencedBuilds } from "../../src/server/runtime/artifact-retention.js";
import { pruneSupersededSidecarArtifacts } from "../../src/server/sidecar/sidecar-artifact-retention.js";

const HOUR = 60 * 60 * 1_000;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmodTree(directory).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

function digest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

async function root(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "sedes-retention-")));
  directories.push(directory);
  return directory;
}

/** A sealed build like the installers publish: read-only files, private directory. */
async function build(parent: string, name: string, ageMilliseconds: number): Promise<string> {
  const directory = path.join(parent, name);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, "sedes"), "bytes", { mode: 0o500 });
  const time = new Date(Date.now() - ageMilliseconds);
  await utimes(directory, time, time);
  return directory;
}

async function chmodTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await chmodTree(path.join(directory, entry.name));
  }
}

describe("unreferenced build retention", () => {
  it("keeps the running, newest, and process-referenced builds and removes the rest", async () => {
    const store = await root();
    const running = digest("running");
    const builds = ["one", "two", "three", "four", "five"].map(digest);
    await build(store, running, 10 * HOUR);
    for (const [index, name] of builds.entries()) await build(store, name, (index + 2) * HOUR);
    await mkdir(path.join(store, ".prune-leftover"), { mode: 0o700 });
    await mkdir(path.join(store, "not-a-digest"), { mode: 0o700 });
    await symlink(path.join(store, builds[4]!), path.join(store, digest("alias")));

    const removed = await pruneUnreferencedBuilds({
      root: store,
      keep: new Set([running]),
      retain: 2,
      minimumAgeMilliseconds: HOUR,
      namePattern: /^[0-9a-f]{64}$/u,
      readCommandLines: async () => new Map([
        [10, `/usr/bin/node ${path.join(store, builds[3]!, "sedes")} service daemon`],
        [11, "/usr/bin/node /elsewhere/sedes service connect"],
      ]),
    });

    expect([...removed].sort()).toEqual([builds[2]!, builds[4]!].sort());
    expect((await readdir(store)).sort()).toEqual(
      [running, builds[0]!, builds[1]!, builds[3]!, "not-a-digest", digest("alias")].sort(),
    );
  });

  it("keeps recently installed builds even beyond the retained count", async () => {
    const store = await root();
    const recent = digest("recent");
    const old = digest("old");
    await build(store, recent, 60_000);
    await build(store, old, 3 * HOUR);
    const removed = await pruneUnreferencedBuilds({
      root: store, keep: new Set(), retain: 0, minimumAgeMilliseconds: HOUR,
      namePattern: /^[0-9a-f]{64}$/u, readCommandLines: async () => new Map(),
    });
    expect(removed).toEqual([old]);
    expect(await readdir(store)).toEqual([recent]);
  });

  it("removes nothing when process command lines cannot be read", async () => {
    const store = await root();
    await build(store, digest("old"), 3 * HOUR);
    await expect(pruneUnreferencedBuilds({
      root: store, keep: new Set(), retain: 0, minimumAgeMilliseconds: HOUR,
      namePattern: /^[0-9a-f]{64}$/u,
      readCommandLines: async () => { throw new Error("process_table_unsupported"); },
    })).rejects.toThrow("process_table_unsupported");
    expect(await readdir(store)).toEqual([digest("old")]);
  });
});

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("sidecar artifact store retention", () => {
  it("prunes only when the running daemon was started from the account store", async () => {
    const stateRoot = await root();
    const store = path.join(stateRoot, "artifacts", "sha256");
    await mkdir(store, { recursive: true, mode: 0o700 });
    const running = digest("running");
    await build(store, running, 5 * HOUR);
    const superseded = ["a", "b", "c", "d", "e"].map(digest);
    for (const [index, name] of superseded.entries()) await build(store, name, (index + 6) * HOUR);

    expect(await pruneSupersededSidecarArtifacts({
      stateRoot, executablePath: path.join(stateRoot, "elsewhere", "sedes"), artifactSha256: running,
    })).toEqual([]);
    expect(await readdir(store)).toHaveLength(6);

    const removed = await pruneSupersededSidecarArtifacts({
      stateRoot, executablePath: path.join(store, running, "sedes"), artifactSha256: running,
    });
    expect([...removed].sort()).toEqual(superseded.slice(3).sort());
    expect((await readdir(store)).sort()).toEqual([running, ...superseded.slice(0, 3)].sort());
  });
});
