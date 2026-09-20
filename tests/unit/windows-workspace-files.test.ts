import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { WorkspaceFilesEngine } from "../../src/server/workspace-files/workspace-files-engine.js";
import { WorkspaceToolEngine } from "../../src/server/workspace-tools/workspace-tool-engine.js";

// This exercises the real Windows FileHandle, drive spelling, directory opens,
// atomic rename, and file-index behavior. A Linux platform mock cannot prove it.
it.skipIf(process.platform !== "win32")(
  "reads, edits and lists native Windows workspace files and rejects replaced parents",
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sedes-windows-files-"),
    );
    const root = await realpath(directory);
    try {
      const target = { canonicalPath: root, operationKey: "test" };
      const files = new WorkspaceFilesEngine({});
      const tools = new WorkspaceToolEngine({
        root: { ...target, homePath: root },
      });
      await tools.write({ path: "nested/note.txt", content: "initial" });
      expect(
        await tools.read({ path: path.join(root, "nested", "note.txt") }),
      ).toMatchObject({ content: "initial" });
      const initial = await files.read(target, "nested/note.txt");
      await files.write(target, {
        path: "nested/note.txt",
        expectedRevision: initial.revision,
        content: "edited",
      });
      expect(
        await readFile(path.join(root, "nested", "note.txt"), "utf8"),
      ).toBe("edited");
      expect(await files.list(target, { pageSize: 100 })).toMatchObject({
        entries: ["nested/note.txt"],
      });
      await expect(
        tools.write({ path: "nested/note.txt:stream", content: "denied" }),
      ).rejects.toThrow();
      await expect(
        files.read(target, "nested/note.txt:stream"),
      ).rejects.toThrow();
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await symlink(outside, path.join(root, "junction"), "junction");
      await expect(
        tools.write({ path: "junction/denied.txt", content: "denied" }),
      ).rejects.toThrow();
      const replacing = new WorkspaceFilesEngine({
        testHooks: {
          beforeWriteCommit: async () => {
            await rename(path.join(root, "nested"), path.join(root, "moved"));
            await writeFile(path.join(root, "nested"), "replacement");
          },
        },
      });
      const current = await files.read(target, "nested/note.txt");
      await expect(
        replacing.write(target, {
          path: "nested/note.txt",
          expectedRevision: current.revision,
          content: "denied",
        }),
      ).rejects.toThrow();
      expect(await readFile(path.join(root, "moved", "note.txt"), "utf8")).toBe(
        "edited",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
