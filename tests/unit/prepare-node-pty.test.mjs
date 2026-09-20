import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareNodePtySpawnHelper } from "../../scripts/prepare-node-pty.mjs";

describe("node-pty dependency preparation", () => {
  const temporaryDirectories = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("makes the packaged Darwin spawn helper executable", async () => {
    const nodePtyRoot = await mkdtemp(
      path.join(os.tmpdir(), "sedes-node-pty-"),
    );
    temporaryDirectories.push(nodePtyRoot);
    const helperPath = path.join(
      nodePtyRoot,
      "prebuilds",
      "darwin-arm64",
      "spawn-helper",
    );
    await mkdir(path.dirname(helperPath), { recursive: true });
    await writeFile(helperPath, "helper");
    await chmod(helperPath, 0o644);

    await prepareNodePtySpawnHelper({
      platform: "darwin",
      architecture: "arm64",
      nodePtyRoot,
    });

    expect((await stat(helperPath)).mode & 0o777).toBe(0o755);
  });

  it("does not require a spawn helper on other platforms", async () => {
    await expect(
      prepareNodePtySpawnHelper({
        platform: "linux",
        architecture: "x64",
        nodePtyRoot: "/does/not/exist",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not require a Darwin prebuild when node-pty was built from source", async () => {
    await expect(
      prepareNodePtySpawnHelper({
        platform: "darwin",
        architecture: "arm64",
        nodePtyRoot: "/does/not/exist",
      }),
    ).resolves.toBeUndefined();
  });
});
