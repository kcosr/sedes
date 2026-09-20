import {
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openVerifiedDirectory,
  pathForOpenDescriptor,
  pathWithinOpenDirectory,
  revalidatedPathForOpenHandle,
} from "../../src/server/local-file-descriptor-path.js";

describe("local file descriptor paths", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("selects descriptor traversal on Linux and canonical paths on Darwin", () => {
    expect(pathForOpenDescriptor(17, "/workspace", "linux")).toBe(
      "/proc/self/fd/17",
    );
    expect(pathForOpenDescriptor(17, "/workspace", "darwin")).toBe(
      "/workspace",
    );
    expect(
      pathWithinOpenDirectory({ fd: 17 }, "/workspace", "src", "index.ts"),
    ).toBe(
      process.platform === "linux"
        ? "/proc/self/fd/17/src/index.ts"
        : path.join("/workspace", "src", "index.ts"),
    );
  });

  it.each(["darwin", "win32"] as const)(
    "revalidates %s canonical paths against the open file identity",
    async (platform) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "sedes-descriptor-path-"),
      );
      temporaryDirectories.push(directory);
      const candidate = path.join(directory, "candidate.txt");
      const replacement = path.join(directory, "replacement.txt");
      await writeFile(candidate, "original");
      await writeFile(replacement, "replacement");
      const handle = await open(candidate, "r");
      try {
        expect(
          await revalidatedPathForOpenHandle(handle, candidate, platform),
        ).toBe(candidate);
        // Windows disallows overwriting an open file, but permits moving it
        // aside. Keep the original handle open while replacing its pathname.
        await rename(candidate, path.join(directory, "original.txt"));
        await rename(replacement, candidate);
        expect(
          await revalidatedPathForOpenHandle(handle, candidate, platform),
        ).toBeUndefined();
      } finally {
        await handle.close();
      }
    },
  );

  it("uses the Windows canonical path without fabricating a descriptor path", () => {
    expect(pathForOpenDescriptor(17, "C:\\workspace", "win32")).toBe(
      "C:\\workspace",
    );
  });

  it("opens directories with verified identity and rejects regular files and junctions", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sedes-directory-path-"),
    );
    temporaryDirectories.push(directory);
    const child = path.join(directory, "child");
    await mkdir(child);
    const handle = await openVerifiedDirectory(child);
    try {
      expect((await handle.stat()).isDirectory()).toBe(true);
      expect(await revalidatedPathForOpenHandle(handle, child, "win32")).toBe(
        child,
      );
      await rename(child, path.join(directory, "moved"));
      await mkdir(child);
      expect(
        await revalidatedPathForOpenHandle(handle, child, "win32"),
      ).toBeUndefined();
    } finally {
      await handle.close();
    }
    const file = path.join(directory, "file");
    await writeFile(file, "file");
    await expect(openVerifiedDirectory(file)).rejects.toThrow(
      "local_directory_path_invalid",
    );
    const link = path.join(directory, "link");
    await symlink(
      child,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(openVerifiedDirectory(link)).rejects.toThrow(
      "local_directory_path_invalid",
    );
  });

  it("rejects platforms without a defined local descriptor contract", () => {
    expect(() => pathForOpenDescriptor(17, "/workspace", "freebsd")).toThrow(
      "local_file_descriptor_path_unsupported:freebsd",
    );
  });
});
