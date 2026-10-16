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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openVerifiedDirectory,
  openVerifiedRegularFile,
  pathForOpenDescriptor,
  pathWithinOpenDirectory,
  revalidatedPathForOpenHandle,
} from "../../src/server/local-file-descriptor-path.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

describe("local file descriptor paths", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
    vi.mocked(open).mockReset().mockImplementation(actual.open);
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

  it("opens only regular final files and refuses links and directories", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sedes-regular-file-"),
    );
    temporaryDirectories.push(directory);
    const candidate = path.join(directory, "file.txt");
    await writeFile(candidate, "file");
    const handle = await openVerifiedRegularFile(candidate);
    try {
      expect(await handle.readFile("utf8")).toBe("file");
    } finally {
      await handle.close();
    }
    const link = path.join(directory, "link.txt");
    await symlink(candidate, link, "file");
    await expect(openVerifiedRegularFile(link)).rejects.toThrow(
      "local_file_path_invalid",
    );
    await expect(openVerifiedRegularFile(directory)).rejects.toThrow(
      "local_file_path_invalid",
    );
  });

  it.each(["before", "after"] as const)(
    "rejects a same-target symlink replacement %s open",
    async (timing) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "sedes-file-race-"),
      );
      temporaryDirectories.push(directory);
      const candidate = path.join(directory, "file.txt");
      const moved = path.join(directory, "moved.txt");
      await writeFile(candidate, "original");
      const actual = await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
      const replace = async () => {
        await rename(candidate, moved);
        await symlink(moved, candidate, "file");
      };
      vi.mocked(open).mockImplementationOnce(async (filename, flags, mode) => {
        if (timing === "before") await replace();
        const handle = await actual.open(filename, flags, mode);
        if (timing === "after") await replace();
        return handle;
      });
      // The link resolves to the very same inode as the admitted regular file;
      // descriptor identity alone therefore cannot detect this replacement.
      await expect(openVerifiedRegularFile(candidate)).rejects.toThrow();
    },
  );

  it.each(["before", "after"] as const)(
    "rejects a different regular file replacing the pathname %s open",
    async (timing) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "sedes-file-identity-race-"),
      );
      temporaryDirectories.push(directory);
      const candidate = path.join(directory, "file.txt");
      await writeFile(candidate, "original");
      const actual = await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
      const replace = async () => {
        await rename(candidate, path.join(directory, "moved.txt"));
        await writeFile(candidate, "replacement");
      };
      let opened: Awaited<ReturnType<typeof open>> | undefined;
      vi.mocked(open).mockImplementationOnce(async (filename, flags, mode) => {
        if (timing === "before") await replace();
        opened = await actual.open(filename, flags, mode);
        if (timing === "after") await replace();
        return opened;
      });
      await expect(openVerifiedRegularFile(candidate)).rejects.toThrow(
        "local_file_path_unstable",
      );
      expect(opened?.fd).toBe(-1);
    },
  );
});
