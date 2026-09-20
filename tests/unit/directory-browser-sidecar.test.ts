import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  directoryBrowserListImmediateOperation,
  directoryBrowserV1Operations,
} from "../../src/internal/sidecar-protocol/index.js";
import { DirectoryBrowserSidecarHost } from "../../src/server/sidecar/directory-browser-sidecar-host.js";

const context = () => ({
  requestId: "request-1",
  signal: new AbortController().signal,
});

describe("directory_browser@1 sidecar", () => {
  it("exposes one closed high-level immediate-directory operation", () => {
    expect(directoryBrowserV1Operations).toHaveLength(1);
    expect(directoryBrowserV1Operations[0]).toMatchObject({
      capabilityId: "directory_browser",
      majorVersion: 1,
      operation: "directories.list",
    });
    expect(
      directoryBrowserListImmediateOperation.requestSchema.safeParse({
        rootPath: "/srv/worktrees",
        directoryPath: "/srv/worktrees",
        pageSize: 50,
        recursive: true,
      }).success,
    ).toBe(false);
  });

  it("lists sorted immediate real directories and excludes files and symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-directory-browser-"));
    await Promise.all([
      mkdir(path.join(root, "zeta")),
      mkdir(path.join(root, "alpha")),
      mkdir(path.join(root, ".hidden")),
      writeFile(path.join(root, "file.txt"), "not a directory"),
    ]);
    await symlink(path.join(root, "alpha"), path.join(root, "linked"));
    const host = new DirectoryBrowserSidecarHost({
      sessionNonce: "n".repeat(48),
    });
    try {
      await expect(
        host.handlers.listImmediate(
          { rootPath: root, directoryPath: root, pageSize: 50 },
          context(),
        ),
      ).resolves.toEqual({
        directoryPath: root,
        entries: [
          { name: "alpha", path: path.join(root, "alpha") },
          { name: "zeta", path: path.join(root, "zeta") },
        ],
        truncated: false,
      });
    } finally {
      host.close();
    }
  });

  it("pages a stable snapshot with an opaque request-bound cursor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-directory-browser-"));
    await Promise.all(
      ["a", "b", "c"].map(async (name) => await mkdir(path.join(root, name))),
    );
    const host = new DirectoryBrowserSidecarHost({
      sessionNonce: "n".repeat(48),
    });
    try {
      const first = await host.handlers.listImmediate(
        { rootPath: root, directoryPath: root, pageSize: 2 },
        context(),
      );
      expect(first.entries.map(({ name }) => name)).toEqual(["a", "b"]);
      expect(first.nextCursor).toMatch(
        /^[A-Za-z0-9_-]+\.[0-9a-z]+\.[A-Za-z0-9_-]+$/u,
      );
      await mkdir(path.join(root, "aa"));
      const second = await host.handlers.listImmediate(
        {
          rootPath: root,
          directoryPath: root,
          pageSize: 2,
          cursor: first.nextCursor,
        },
        context(),
      );
      expect(second).toEqual({
        directoryPath: root,
        entries: [{ name: "c", path: path.join(root, "c") }],
        truncated: false,
      });
      await expect(
        host.handlers.listImmediate(
          {
            rootPath: root,
            directoryPath: root,
            pageSize: 1,
            cursor: first.nextCursor,
          },
          context(),
        ),
      ).rejects.toMatchObject({ code: "directory_browser_cursor_invalid" });
    } finally {
      host.close();
    }
  });

  it("returns one non-enumerating error for escape, symlink, file, and missing paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-directory-browser-"));
    const outside = await mkdtemp(path.join(tmpdir(), "h-directory-outside-"));
    const file = path.join(root, "file.txt");
    const linked = path.join(root, "linked");
    await writeFile(file, "file");
    await symlink(outside, linked);
    const host = new DirectoryBrowserSidecarHost({
      sessionNonce: "n".repeat(48),
    });
    try {
      for (const directoryPath of [
        outside,
        file,
        linked,
        path.join(root, "missing"),
      ]) {
        await expect(
          host.handlers.listImmediate(
            { rootPath: root, directoryPath, pageSize: 50 },
            context(),
          ),
        ).rejects.toMatchObject({
          code: "directory_browser_directory_not_found",
        });
      }
    } finally {
      host.close();
    }
  });

  it("fails a cancelled enumeration without returning partial paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-directory-browser-"));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const host = new DirectoryBrowserSidecarHost({
      sessionNonce: "n".repeat(48),
    });
    await expect(
      host.handlers.listImmediate(
        { rootPath: root, directoryPath: root, pageSize: 50 },
        { requestId: "cancelled", signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "directory_browser_cancelled" });
    host.close();
  });

  it("does not consume snapshot capacity for single-page listings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-directory-browser-"));
    const host = new DirectoryBrowserSidecarHost({
      sessionNonce: "n".repeat(48),
    });
    try {
      for (let index = 0; index < 40; index += 1) {
        await expect(
          host.handlers.listImmediate(
            { rootPath: root, directoryPath: root, pageSize: 50 },
            context(),
          ),
        ).resolves.toMatchObject({ entries: [], truncated: false });
      }
    } finally {
      host.close();
    }
  });

  it("reclaims bounded snapshot capacity after the terminal page", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-directory-browser-"));
    await Promise.all(
      ["a", "b"].map(async (name) => await mkdir(path.join(root, name))),
    );
    const host = new DirectoryBrowserSidecarHost({
      sessionNonce: "n".repeat(48),
    });
    try {
      const cursors: string[] = [];
      for (let index = 0; index < 32; index += 1) {
        const first = await host.handlers.listImmediate(
          { rootPath: root, directoryPath: root, pageSize: 1 },
          context(),
        );
        cursors.push(first.nextCursor!);
      }
      await expect(
        host.handlers.listImmediate(
          { rootPath: root, directoryPath: root, pageSize: 50 },
          context(),
        ),
      ).resolves.toMatchObject({
        entries: [{ name: "a" }, { name: "b" }],
        truncated: false,
      });
      await expect(
        host.handlers.listImmediate(
          { rootPath: root, directoryPath: root, pageSize: 1 },
          context(),
        ),
      ).rejects.toMatchObject({ code: "directory_browser_busy" });
      await host.handlers.listImmediate(
        {
          rootPath: root,
          directoryPath: root,
          pageSize: 1,
          cursor: cursors[0],
        },
        context(),
      );
      await expect(
        host.handlers.listImmediate(
          { rootPath: root, directoryPath: root, pageSize: 1 },
          context(),
        ),
      ).resolves.toHaveProperty("nextCursor");
    } finally {
      host.close();
    }
  });
});
