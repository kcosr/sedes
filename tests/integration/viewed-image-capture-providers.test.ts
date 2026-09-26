import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidecarOperationRegistry, registerWorkspaceFilesV8Operations,
  type SidecarOperationDefinition } from "../../src/internal/sidecar-protocol/index.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { OutputImageArtifactRepository } from "../../src/server/db/repositories/output-image-artifact-repository.js";
import { WorkspaceFileRootRepository } from "../../src/server/db/repositories/workspace-file-root-repository.js";
import { WorkspaceFileLinkedWorktreeRepository } from "../../src/server/db/repositories/workspace-file-linked-worktree-repository.js";
import { WorkspaceFileService } from "../../src/server/domain/workspace-file-service.js";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";
import { RemoteExecutionEnvironment } from "../../src/server/execution/remote-execution-environment.js";
import { OutputArtifactBlobStore } from "../../src/server/output-artifacts/blob-store.js";
import { OutputArtifactService } from "../../src/server/output-artifacts/service.js";
import { ViewedImageCaptureService } from "../../src/server/output-artifacts/viewed-image-capture.js";
import { WorkspaceFilesSidecarHost } from "../../src/server/sidecar/workspace-files-sidecar-host.js";
import type { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import type { SidecarRuntimeOwner } from "../../src/server/sidecar/sidecar-runtime.js";
import { LocalWorkspaceFileProvider } from "../../src/server/workspace-files/local-workspace-file-provider.js";
import { SidecarWorkspaceFileProvider } from "../../src/server/workspace-files/sidecar-workspace-file-provider.js";
import { CompositeWorkspaceFileProvider } from "../../src/server/workspace-files/composite-workspace-file-provider.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const image = Buffer.alloc(25);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
image.writeUInt32BE(13, 8);
image.write("IHDR", 12);
image.writeUInt32BE(2, 16);
image.writeUInt32BE(3, 20);
const digest = createHash("sha256").update(image).digest("hex");
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Carrier admission is a fixture; all Files host handlers, schemas, policy and storage are real. */
async function fixture(kind: "local" | "ssh" | "outbound",
  testHooks?: ConstructorParameters<typeof LocalWorkspaceFileProvider>[0]["testHooks"]) {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-viewed-provider-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const captures = path.join(root, "captures");
  await Promise.all([mkdir(project), mkdir(captures), mkdir(path.join(root, "state"), { mode: 0o700 })]);
  const source = path.join(captures, "viewed.png");
  await writeFile(source, image);
  const { database, scope } = savedAgentDatabase();
  cleanups.push(() => { if (database.open) database.close(); });
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  // This fixture changes only repository identity metadata; execution providers below
  // perform the same kind-specific policy admission as production composition.
  database.prepare("UPDATE execution_environments SET kind = ? WHERE id = ?").run(kind, environment.id);
  const workspace = inventory.upsertWorkspace(scope, { environmentId: environment.id,
    canonicalPath: project, displayName: "Capture", available: true, trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision, now: 10 });
  const profile = database.prepare("SELECT id FROM agent_connection_profiles LIMIT 1").get() as { id: string };
  const bindings = new ConversationBindingRepository(database);
  const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id,
    connectionProfileId: profile.id, title: "Capture", now: 20 });
  const storedBinding = bindings.bindDiscoveredConversation(scope, thread.id,
    { backendConversationId: "native", now: 30 });
  const binding = { ...storedBinding, createdAt: new Date(storedBinding.createdAt).toISOString() };
  const options = { scope, environmentId: environment.id, allowedRoots: [root],
    configurationRevision: environment.configurationRevision,
    activeConfigurationRevision: () => inventory.getEnvironment(scope, environment.id).configurationRevision };
  let connected = true;
  const execution = kind === "local" ? new LocalExecutionEnvironment(options)
    : new RemoteExecutionEnvironment({ ...options, kind, platform: process.platform === "win32" ? "win32" : "linux",
      availability: "available", directoryBrowser: () => undefined,
      ...(kind === "outbound" ? { isExecutionAvailable: () => connected } : {}) } as ConstructorParameters<typeof RemoteExecutionEnvironment>[0]);
  const host = new WorkspaceFilesSidecarHost({ sessionNonce: "s".repeat(48),
    sendInvalidation: async () => undefined, sendWatchFailure: async () => undefined,
    openDownloadStream: () => { throw new Error("capture_must_use_files_read"); },
    onDownloadCleanupFailure: () => undefined });
  const registry = new SidecarOperationRegistry();
  registerWorkspaceFilesV8Operations(registry, host.handlers);
  const calls: string[] = [];
  let leases = 0;
  const session = {
    call: async (definition: SidecarOperationDefinition<unknown, unknown>, request: unknown,
      options?: { signal?: AbortSignal }) => {
      calls.push(definition.operation);
      const operation = registry.resolve(definition);
      if (!operation) throw new Error("unknown_capture_operation");
      const payload = definition.requestSchema.parse(JSON.parse(JSON.stringify(request)));
      const result = await operation.handler(payload, { requestId: randomUUID(),
        signal: options?.signal ?? new AbortController().signal });
      return definition.responseSchema.parse(JSON.parse(JSON.stringify(result)));
    },
  } as unknown as SidecarClientSession;
  const runtime = { acquireOperation: async (requestScope: typeof scope, environmentId: string, signal: AbortSignal) => {
    expect(requestScope).toEqual(scope);
    expect(environmentId).toBe(environment.id);
    signal.throwIfAborted();
    if (!connected) throw new Error("fixture_carrier_unavailable");
    leases += 1;
    return { session, carrierGeneration: 1, release: () => { leases -= 1; } };
  } } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
  const local = new LocalWorkspaceFileProvider({ scope, environmentId: environment.id,
    ...(testHooks ? { testHooks } : {}) });
  const localRead = vi.spyOn(local, "read");
  const selected = kind === "local" ? local : new SidecarWorkspaceFileProvider({ scope,
    environmentId: environment.id, policyRoots: [root], runtime });
  const providers = new CompositeWorkspaceFileProvider({ scope, providers: new Map([[environment.id, selected]]) });
  const files = new WorkspaceFileService(inventory, new WorkspaceFileRootRepository(database),
    new WorkspaceFileLinkedWorktreeRepository(database), execution, providers,
    { publishApplicationThreadChanges: () => undefined });
  const artifacts = new OutputArtifactService(new OutputArtifactBlobStore(path.join(root, "state")),
    new OutputImageArtifactRepository(database));
  await artifacts.initialize();
  const dependencies = { files, artifacts, inventory, bindings };
  const capture = new ViewedImageCaptureService(dependencies);
  return { scope, thread, root, project, source, capture, artifacts, files, calls, localRead, dependencies,
    linkRoots: () => (database.prepare("SELECT COUNT(*) AS count FROM workspace_file_link_roots").get() as { count: number }).count,
    associations: () => (database.prepare("SELECT COUNT(*) AS count FROM output_image_artifacts").get() as { count: number }).count,
    request: { scope, binding, publicationKey: "viewed", absolutePath: source },
    disconnect: () => { connected = false; },
    leases: () => leases,
    close: async () => { await capture.close(); await files.close(); local.close(); host.close();
      database.close(); await rm(root, { recursive: true, force: true }); },
  };
}

describe("viewed image Files provider conformance", () => {
  it.each(["local", "ssh", "outbound"] as const)("retains exact bytes through %s and reuses them after source and carrier loss", async kind => {
    const current = await fixture(kind);
    try {
      const captured = await current.capture.capture(current.request);
      expect(captured).toMatchObject({ mediaType: "image/png", byteSize: image.length, sha256: digest });
      if (!captured) throw new Error("missing captured image");
      const opened = await current.artifacts.openImage(current.scope, current.thread.id, captured.artifactId);
      expect(await opened.handle.readFile()).toEqual(image);
      await opened.handle.close();
      if (kind === "local") expect(current.localRead).toHaveBeenCalledOnce();
      else {
        expect(current.localRead).not.toHaveBeenCalled();
        expect(current.calls.filter(value => value === "files.read")).toHaveLength(1);
        expect(current.calls).not.toContain("files.download_start");
        expect(current.leases()).toBe(0);
      }
      await current.capture.close();
      await rm(current.source);
      current.disconnect();
      const reread = vi.spyOn(current.files, "readAbsoluteImage");
      const reattached = new ViewedImageCaptureService(current.dependencies);
      expect(await reattached.capture(current.request)).toEqual(captured);
      expect(reread).not.toHaveBeenCalled();
      await reattached.close();
    } finally { await current.close(); }
  });

  it.each(["ssh", "outbound"] as const)("does not substitute local bytes when %s loses its Files carrier", async kind => {
    const current = await fixture(kind);
    try {
      current.disconnect();
      expect(await readFile(current.source)).toEqual(image);
      expect(await current.capture.capture(current.request)).toBeUndefined();
      expect(current.localRead).not.toHaveBeenCalled();
      expect(current.artifacts.findImage(current.scope, current.thread.id, "viewed")).toBeUndefined();
      expect(current.leases()).toBe(0);
    } finally { await current.close(); }
  });

  it.each(["local", "ssh"] as const)("reads images inside and outside Primary through %s without remembering hidden roots", async kind => {
    const current = await fixture(kind);
    try {
      const inside = path.join(current.project, "docs", "viewed.png");
      await mkdir(path.dirname(inside));
      await writeFile(inside, image);
      expect(await current.capture.capture({ ...current.request, publicationKey: "inside", absolutePath: inside }))
        .toMatchObject({ mediaType: "image/png", sha256: digest });
      expect(await current.capture.capture(current.request)).toMatchObject({ sha256: digest });
      // Automatic captures never consume the workspace's explicit link-root capacity.
      const elsewhere = path.join(path.dirname(path.dirname(current.request.absolutePath)), "elsewhere", "viewed.png");
      await mkdir(path.dirname(elsewhere));
      await writeFile(elsewhere, image);
      expect(await current.capture.capture({ ...current.request, publicationKey: "elsewhere", absolutePath: elsewhere }))
        .toMatchObject({ sha256: digest });
      expect(current.linkRoots()).toBe(0);
      if (kind === "local") expect(current.localRead).toHaveBeenCalledTimes(3);
      else expect(current.localRead).not.toHaveBeenCalled();
    } finally { await current.close(); }
  });

  it.each(["local", "ssh"] as const)("denies sensitive, mismatched, and missing files through %s without an association", async kind => {
    const current = await fixture(kind);
    try {
      const sensitiveDirectory = path.join(current.root, "captures", ".ssh");
      const sensitiveInPrimary = path.join(current.project, ".env");
      await Promise.all([mkdir(sensitiveDirectory), mkdir(sensitiveInPrimary)]);
      const denied = {
        sensitiveDirectory: path.join(sensitiveDirectory, "viewed.png"),
        sensitiveInPrimary: path.join(sensitiveInPrimary, "viewed.png"),
        mismatched: path.join(current.root, "captures", "viewed.jpg"),
        missing: path.join(current.root, "captures", "missing.png"),
      };
      await Promise.all([denied.sensitiveDirectory, denied.sensitiveInPrimary, denied.mismatched]
        .map(file => writeFile(file, image)));
      for (const [publicationKey, absolutePath] of Object.entries(denied)) {
        expect(await current.capture.capture({ ...current.request, publicationKey, absolutePath })).toBeUndefined();
      }
      expect(current.associations()).toBe(0);
      expect(current.leases()).toBe(0);
      expect(await current.capture.capture(current.request)).toMatchObject({ sha256: digest });
    } finally { await current.close(); }
  });

  it("keeps the retained snapshot after later modification and publishes nothing when modified during read", async () => {
    let modifyDuringRead: string | undefined;
    const current = await fixture("local", { afterReadMetadata: async relativePath => {
      if (modifyDuringRead && relativePath === path.basename(modifyDuringRead)) {
        await writeFile(modifyDuringRead, Buffer.concat([image, Buffer.from([0])]));
      }
    } });
    try {
      const captured = await current.capture.capture(current.request);
      expect(captured).toMatchObject({ sha256: digest });
      if (!captured) throw new Error("missing captured image");
      const changed = Buffer.from(image);
      changed.writeUInt32BE(9, 16);
      await writeFile(current.source, changed);
      const reread = vi.spyOn(current.files, "readAbsoluteImage");
      expect(await current.capture.capture(current.request)).toEqual(captured);
      expect(reread).not.toHaveBeenCalled();
      const opened = await current.artifacts.openImage(current.scope, current.thread.id, captured.artifactId);
      expect(await opened.handle.readFile()).toEqual(image);
      await opened.handle.close();
      expect(current.associations()).toBe(1);
      modifyDuringRead = path.join(current.root, "captures", "racing.png");
      await writeFile(modifyDuringRead, image);
      expect(await current.capture.capture({ ...current.request, publicationKey: "racing",
        absolutePath: modifyDuringRead })).toBeUndefined();
      expect(reread).toHaveBeenCalledOnce();
      expect(current.associations()).toBe(1);
    } finally { await current.close(); }
  });
});
