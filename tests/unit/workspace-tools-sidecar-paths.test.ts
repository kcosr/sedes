import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  workspaceToolsFileEditOperation,
  workspaceToolsFileReadOperation,
  workspaceToolsFileWriteOperation,
  workspaceToolsDirectoryListOperation,
} from "../../src/internal/sidecar-protocol/index.js";
import { WorkspaceToolsSidecarHost } from "../../src/server/sidecar/workspace-tools-sidecar-host.js";
import { CanonicalMutationSerializer } from "../../src/server/workspace-files/canonical-mutation-serializer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("workspace tools sidecar literal path boundary", () => {
  it.each(["@file", "~/file", "unicode\u00a0file"])(
    "reads, writes and edits %s literally under a Unicode-space workspace root",
    async (filename) => {
      const value = await fixture();
      const context = { requestId: randomUUID(), signal: new AbortController().signal };
      const target = path.join(value.root, filename);
      const canary = path.join(value.root, filename.replace(/^@/, "").replace(/\u00a0/g, " "));
      if (canary !== target) await writeFile(canary, "canary");
      await value.host.handlers.writeFile(workspaceToolsFileWriteOperation.requestSchema.parse({
        workspaceHandle: value.workspaceHandle, operationId: randomUUID(), path: filename, content: "before",
      }), context);
      expect(await readFile(target, "utf8")).toBe("before");
      await expect(value.host.handlers.readFile(workspaceToolsFileReadOperation.requestSchema.parse({
        workspaceHandle: value.workspaceHandle, path: filename,
      }), context)).resolves.toMatchObject({ path: filename, content: "before" });
      await value.host.handlers.editFile(workspaceToolsFileEditOperation.requestSchema.parse({
        workspaceHandle: value.workspaceHandle, operationId: randomUUID(), path: filename,
        edits: [{ oldText: "before", newText: "after" }],
      }), context);
      expect(await readFile(target, "utf8")).toBe("after");
      if (canary !== target) expect(await readFile(canary, "utf8")).toBe("canary");
      const listed = await value.host.handlers.listDirectory(workspaceToolsDirectoryListOperation.requestSchema.parse({
        workspaceHandle: value.workspaceHandle,
        ...(filename.startsWith("~/") ? { path: "~" } : {}),
      }), context);
      expect(listed.entries).toContainEqual({ name: path.basename(filename), kind: "file" });
    },
  );

  it("retains sidecar symlink confinement for literal wire paths", async () => {
    const value = await fixture();
    const context = { requestId: randomUUID(), signal: new AbortController().signal };
    const outside = path.join(value.directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "file"), "outside canary");
    await symlink(outside, path.join(value.root, "@outside"));
    await expect(value.host.handlers.readFile({
      workspaceHandle: value.workspaceHandle, path: "@outside/file",
    }, context)).rejects.toMatchObject({ code: "workspace_tools_path_not_found" });
    await expect(value.host.handlers.writeFile({
      workspaceHandle: value.workspaceHandle, operationId: randomUUID(),
      path: "@outside/file", content: "changed",
    }, context)).rejects.toMatchObject({ code: "workspace_tools_path_outside_workspace" });
    expect(await readFile(path.join(outside, "file"), "utf8")).toBe("outside canary");
  });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-literal-paths-"));
  // Host-side anchoring must not normalize the admitted root itself either.
  const root = path.join(directory, "remote\u00a0workspace");
  await mkdir(root);
  const host = new WorkspaceToolsSidecarHost({
    sessionNonce: "literal-path-fixture",
    mutations: new CanonicalMutationSerializer(),
  });
  cleanups.push(async () => {
    host.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { workspaceHandle } = await host.handlers.openWorkspace({
    admissionId: randomUUID(), declaredPath: root, policyRootPath: directory,
  }, { requestId: randomUUID(), signal: new AbortController().signal });
  return { directory, root, host, workspaceHandle };
}
