import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  registerWorkspaceFilesV8Operations,
  SidecarOperationRegistry,
  workspaceFilesDiscoverLinkRootOperation,
  workspaceFilesReadOperation,
  workspaceFilesResolveLinkOperation,
  workspaceFilesRootOpenOperation,
  workspaceFilesRootValidateOperation,
  type SidecarOperationDefinition,
} from "../../src/internal/sidecar-protocol/index.js";
import { WorkspaceFilesSidecarHost } from "../../src/server/sidecar/workspace-files-sidecar-host.js";

const temporaryDirectories: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7qkAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sedes-windows-files-host-"));
  temporaryDirectories.push(temporary);
  const directory = await realpath(temporary);
  const policy = path.join(directory, "allowed");
  // A leading '..' in a legitimate child name is not a parent segment.
  const workspace = path.join(policy, "..cache", "workspace");
  const outside = `${policy}-outside`;
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(outside),
  ]);
  await Promise.all([
    writeFile(path.join(workspace, "viewed.png"), png),
    writeFile(path.join(outside, "outside.png"), png),
  ]);
  const host = new WorkspaceFilesSidecarHost({
    sessionNonce: "native-windows-files-host-session".padEnd(32, "n"),
    sendInvalidation: async () => undefined,
    sendWatchFailure: async () => undefined,
    openDownloadStream: () => { throw new Error("unexpected_download_stream"); },
    onDownloadCleanupFailure: () => undefined,
  });
  const registry = new SidecarOperationRegistry();
  registerWorkspaceFilesV8Operations(registry, host.handlers);
  const call = async <Request, Response>(
    definition: SidecarOperationDefinition<Request, Response>,
    request: unknown,
  ): Promise<Response> => {
    const operation = registry.resolve(definition);
    if (!operation) throw new Error("missing_registered_operation");
    const response = await operation.handler(definition.requestSchema.parse(request), {
      requestId: randomUUID(), signal: new AbortController().signal,
    });
    return definition.responseSchema.parse(response);
  };
  return { policy, workspace, outside, host, call };
}

it.skipIf(process.platform !== "win32")(
  "validates and opens nested native Windows Files roots without admitting sibling prefixes",
  async () => {
    const current = await fixture();
    const { policy, workspace, outside, call } = current;
    try {
      const root = { rootKind: "primary", declaredPath: workspace, policyRootPath: policy };
      await expect(call(workspaceFilesRootValidateOperation, root)).resolves.toEqual({ validated: true });
      const opened = await call(workspaceFilesRootOpenOperation, {
        ...root, admissionId: randomUUID(), rootId: "primary",
      });
      await expect(call(workspaceFilesReadOperation, {
        rootHandle: opened.rootHandle, path: "viewed.png",
      })).resolves.toMatchObject({
        contentKind: "image", previewState: "available", mediaType: "image/png",
        sizeBytes: png.byteLength, contentBase64: png.toString("base64"),
      });
      await expect(call(workspaceFilesRootValidateOperation, {
        ...root, declaredPath: outside,
      })).rejects.toMatchObject({ code: "workspace_file_root_unavailable" });
      await expect(call(workspaceFilesRootOpenOperation, {
        ...root, declaredPath: outside, admissionId: randomUUID(), rootId: "primary",
      })).rejects.toMatchObject({ code: "workspace_file_root_unavailable" });
      await expect(call(workspaceFilesResolveLinkOperation, {
        rootHandle: opened.rootHandle,
        reference: { kind: "absolute", path: path.join(outside, "outside.png") },
      })).resolves.toEqual({ status: "not_found" });
    } finally {
      current.host.close();
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "discovers and reads native Windows viewed PNGs through link-only Files handlers",
  async () => {
    const current = await fixture();
    const { policy, workspace, outside, call } = current;
    try {
      const discovered = await call(workspaceFilesDiscoverLinkRootOperation, {
        absolutePath: path.join(workspace, "viewed.png"), policyRootPath: policy,
      });
      expect(discovered).toEqual({
        status: "discovered", declaredRootPath: workspace, relativePath: "viewed.png",
      });
      if (discovered.status !== "discovered") throw new Error("image_root_not_discovered");
      const root = {
        rootKind: "link_only", declaredPath: discovered.declaredRootPath, policyRootPath: policy,
      };
      await call(workspaceFilesRootValidateOperation, root);
      const opened = await call(workspaceFilesRootOpenOperation, {
        ...root, admissionId: randomUUID(), rootId: "windows-image-root",
      });
      await expect(call(workspaceFilesResolveLinkOperation, {
        rootHandle: opened.rootHandle,
        reference: { kind: "absolute", path: path.join(workspace, "viewed.png") },
      })).resolves.toEqual({ status: "resolved", path: "viewed.png" });
      await expect(call(workspaceFilesReadOperation, {
        rootHandle: opened.rootHandle, path: discovered.relativePath,
      })).resolves.toMatchObject({
        contentKind: "image", previewState: "available", mediaType: "image/png",
        sizeBytes: png.byteLength, contentBase64: png.toString("base64"),
      });
      await expect(call(workspaceFilesDiscoverLinkRootOperation, {
        absolutePath: path.join(outside, "outside.png"), policyRootPath: policy,
      })).resolves.toEqual({ status: "not_found" });
    } finally {
      current.host.close();
    }
  },
);
