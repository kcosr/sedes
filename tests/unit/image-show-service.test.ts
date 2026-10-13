import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ImageShowRepository } from "../../src/server/db/repositories/image-show-repository.js";
import { PageRepository } from "../../src/server/db/repositories/page-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { OutputImageArtifactRepository } from "../../src/server/db/repositories/output-image-artifact-repository.js";
import { WorkspaceFileLinkedWorktreeRepository } from "../../src/server/db/repositories/workspace-file-linked-worktree-repository.js";
import { WorkspaceFileRootRepository } from "../../src/server/db/repositories/workspace-file-root-repository.js";
import { WorkspaceFileService } from "../../src/server/domain/workspace-file-service.js";
import { DomainError } from "../../src/server/domain/errors.js";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";
import { LocalWorkspaceFileProvider } from "../../src/server/workspace-files/local-workspace-file-provider.js";
import { OutputArtifactBlobStore } from "../../src/server/output-artifacts/blob-store.js";
import { OutputArtifactService } from "../../src/server/output-artifacts/service.js";
import { ImageShowService } from "../../src/server/output-artifacts/image-show-service.js";
import type { ImageShowRequest } from "../../src/shared/protocol/image-show.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function png(marker = 0) {
  const bytes = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12); bytes.writeUInt32BE(1, 16); bytes.writeUInt32BE(1, 20); bytes[24] = marker;
  return bytes;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-image-show-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { database, scope } = savedAgentDatabase();
  cleanup.push(async () => database.close());
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, { environmentId: environment.id, canonicalPath: root, displayName: "Images",
    project: { kind: "new", name: "Images" }, available: true, trustState: "trusted", environmentConfigurationRevision: environment.configurationRevision, now: 10 });
  const profile = database.prepare("SELECT id FROM agent_connection_profiles WHERE tenant_id=? AND owner_principal_id=? LIMIT 1")
    .get(scope.tenantId, scope.principalId) as { id: string };
  const bindings = new ConversationBindingRepository(database);
  const thread = bindings.createUnboundThread(scope, { workspaceId: workspace.id, connectionProfileId: profile.id, title: "Show", now: 20 });
  bindings.bindDiscoveredConversation(scope, thread.id, { backendConversationId: "native-image", now: 30 });
  const repository = new ImageShowRepository(database);
  const store = new OutputArtifactBlobStore(root);
  const artifacts = new OutputArtifactService(store, new OutputImageArtifactRepository(database));
  await artifacts.initialize();
  const execution = new LocalExecutionEnvironment({ scope, environmentId: environment.id, allowedRoots: [root],
    configurationRevision: environment.configurationRevision,
    activeConfigurationRevision: () => inventory.getEnvironment(scope, environment.id).configurationRevision });
  const files = new WorkspaceFileService(inventory, new WorkspaceFileRootRepository(database), new WorkspaceFileLinkedWorktreeRepository(database), execution,
    new LocalWorkspaceFileProvider({ scope, environmentId: environment.id }), { publishApplicationThreadChanges: () => undefined });
  cleanup.push(() => files.close());
  const onShown = vi.fn();
  const service = new ImageShowService({ repository, files, inventory, bindings, artifacts, onShown });
  cleanup.push(() => service.close());
  const capture = vi.fn(() => ({ anchor: { turnId: "turn", afterItemId: "item" }, assertCurrent: vi.fn() }));
  const source = path.join(root, "image.png");
  await writeFile(source, png());
  return { root, database, scope, inventory, environment, workspace, thread, bindings, repository, store, artifacts, files, service, capture, source,
    show: (invocationId: string = randomUUID(), input: ImageShowRequest = { path: source }, signal?: AbortSignal) => service.show(scope, thread.id, input, { invocationId, capture }, signal) };
}

describe("ImageShowService", () => {
  it("captures through real Files and retains a scoped immutable image after source deletion and restart", async () => {
    const f = await fixture();
    const result = await f.show("first", { path: f.source, title: "Results" });
    expect(result.image).toMatchObject({ representation: "artifact", mimeType: "image/png", byteSize: 25,
      fileName: { text: "image.png" }, alt: { text: "Results" } });
    expect(JSON.stringify(result)).not.toContain(f.root);
    await rm(f.source);
    f.capture.mockImplementation(() => { throw new Error("turn completed"); });
    expect(await f.show("first", { path: f.source, title: "Results" })).toEqual(result);
    const reopened = await f.artifacts.openImage(f.scope, f.thread.id, result.image.artifactId);
    expect(await reopened.handle.readFile()).toEqual(png()); await reopened.handle.close();
    expect(f.repository.publications(f.scope, f.thread.id)).toHaveLength(1);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM html_pages").get()).toEqual({ count: 0 });
    const fresh = new ImageShowService({ repository: f.repository, files: f.files, inventory: f.inventory, bindings: f.bindings, artifacts: f.artifacts });
    expect(await fresh.show(f.scope, f.thread.id, { path: f.source, title: "Results" }, { invocationId: "first", capture: f.capture })).toEqual(result);
    await fresh.close();
  });

  it("snapshots changed bytes only for a new request and rejects reused inputs", async () => {
    const f = await fixture(); const first = await f.show("first");
    await writeFile(f.source, png(1));
    expect(await f.show("first")).toEqual(first);
    const second = await f.show("second");
    expect(second.image.sha256).not.toBe(first.image.sha256);
    await expect(f.show("first", { path: path.join(f.root, "other.png") })).rejects.toMatchObject({ reason: "request_conflict" });
    expect(f.repository.publications(f.scope, f.thread.id)).toHaveLength(2);
  });

  it("keeps page and image commit order when the wall clock does not advance", async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    try {
      await f.show("image-first");
      const page = new PageRepository(f.database).publish(f.scope, f.thread.id, { title: "Between images", viewport: {},
        invocationId: "page-second", anchor: { turnId: "turn", afterItemId: "item" },
        prepared: { sourceHtml: "x", escapedHtml: "x", bootstrapOffset: 0, sha256: "c".repeat(64), byteSize: 1 } }).page;
      await f.show("image-third");
      const images = f.repository.publications(f.scope, f.thread.id);
      expect(Date.parse(images[0]!.createdAt)).toBeLessThan(Date.parse(page.createdAt));
      expect(Date.parse(page.createdAt)).toBeLessThan(Date.parse(images[1]!.createdAt));
    } finally { clock.mockRestore(); }
  });

  it("denies wrong principal and binding reuse without reading the source", async () => {
    const f = await fixture(); await f.show("first");
    const read = vi.spyOn(f.files, "readAbsoluteFile");
    await expect(f.service.show({ ...f.scope, principalId: "wrong" }, f.thread.id, { path: f.source }, { invocationId: "first", capture: f.capture }))
      .rejects.toMatchObject({ reason: "unavailable" });
    f.database.prepare("UPDATE conversation_bindings SET backend_conversation_id=? WHERE application_thread_id=?").run("changed-native", f.thread.id);
    await expect(f.show("first")).rejects.toMatchObject({ reason: "request_conflict" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined, "unavailable"], ["unsupported", Buffer.from("text data"), "unsupported"],
    ["invalid", Buffer.from([137, 80, 78, 71]), "invalid"], ["empty", Buffer.alloc(0), "size"],
  ] as const)("reports a clear %s error without storing an artifact", async (_label, bytes, reason) => {
    const f = await fixture();
    if (bytes) await writeFile(f.source, bytes); else await rm(f.source);
    await expect(f.show()).rejects.toMatchObject({ reason });
    expect(f.repository.publications(f.scope, f.thread.id)).toEqual([]);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM output_image_artifacts").get()).toEqual({ count: 0 });
  });

  it("rechecks the current turn inside the same artifact/receipt transaction and rolls back both", async () => {
    const f = await fixture(); let active = true;
    f.capture.mockReturnValue({ anchor: { turnId: "turn", afterItemId: "item" }, assertCurrent: vi.fn(() => { if (!active) throw new DomainError("runtime_unavailable", "retired"); }) });
    const publish = f.store.publish.bind(f.store);
    vi.spyOn(f.store, "publish").mockImplementation(async (...args) => { await publish(...args); active = false; });
    await expect(f.show()).rejects.toMatchObject({ reason: "inactive_turn" });
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM output_image_artifacts").get()).toEqual({ count: 0 });
    expect(f.repository.publications(f.scope, f.thread.id)).toEqual([]);
  });

  it("reports the actual per-turn display limit through the repository without publishing a partial artifact", async () => {
    const f = await fixture(); await f.show("seed");
    const insert = f.database.prepare(`INSERT INTO shown_images(tenant_id,owner_principal_id,thread_id,invocation_id,input_sha256,binding_sha256,artifact_id,image_json,anchor_turn_id,anchor_json,created_at)
      SELECT tenant_id,owner_principal_id,thread_id,?,input_sha256,binding_sha256,artifact_id,image_json,anchor_turn_id,anchor_json,created_at
      FROM shown_images WHERE invocation_id='seed'`);
    f.database.transaction(() => { for (let index = 1; index < 1000; index++) insert.run(`seed-${index}`); })();
    await expect(f.show("over-limit")).rejects.toMatchObject({ reason: "turn_limit",
      message: "This turn has reached its image display limit (1,000 images)." });
    expect(f.repository.find(f.scope, f.thread.id, "over-limit")).toBeUndefined();
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM output_image_artifacts").get()).toEqual({ count: 1 });
  });

  it("distinguishes retention failure from an unavailable source file", async () => {
    const f = await fixture();
    vi.spyOn(f.artifacts, "publishCapturedImage").mockRejectedValue(new Error("disk unavailable"));
    await expect(f.show()).rejects.toMatchObject({ reason: "retention_failed", message: "The image could not be retained. Retry the request.", retryable: true });
    expect(f.repository.publications(f.scope, f.thread.id)).toEqual([]);
  });

  it("shares concurrent retries and cancels the source only after the final subscriber aborts", async () => {
    const f = await fixture(); const gate = deferred(); const started = deferred();
    const read = vi.spyOn(f.files, "readAbsoluteFile").mockImplementation(async (_scope, _thread, _path, _limit, signal) => {
      started.resolve(); await gate.promise; signal?.throwIfAborted(); return png();
    });
    const a = new AbortController(); const b = new AbortController();
    const first = f.show("same", undefined, a.signal); const second = f.show("same", undefined, b.signal);
    await started.promise;
    a.abort(); await expect(first).rejects.toMatchObject({ reason: "cancelled" });
    gate.resolve(); expect(await second).toMatchObject({ image: { mimeType: "image/png" } });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("bounds waiting captures and aborts all of them without admitting more I/O", async () => {
    const f = await fixture(); const gate = deferred(); const started = deferred();
    const read = vi.spyOn(f.files, "readAbsoluteFile").mockImplementation(async (_scope, _thread, _path, _limit, signal) => {
      started.resolve(); await gate.promise; signal?.throwIfAborted(); return png();
    });
    const controller = new AbortController();
    const waiting = Array.from({ length: 33 }, (_, index) => f.show(`queued-${index}`, undefined, controller.signal)
      .then(() => "unexpected", error => error.reason as string));
    await started.promise;
    await expect(f.show("over-capacity")).rejects.toMatchObject({ reason: "busy" });
    controller.abort(); gate.resolve();
    expect(await Promise.all(waiting)).toEqual(Array(33).fill("cancelled"));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects absent active turns before source I/O while retained retries remain readable", async () => {
    const f = await fixture();
    f.capture.mockImplementation(() => { throw new DomainError("runtime_unavailable", "no active turn"); });
    const read = vi.spyOn(f.files, "readAbsoluteFile");
    await expect(f.show()).rejects.toMatchObject({ reason: "inactive_turn" });
    expect(read).not.toHaveBeenCalled();
  });

  it("fences changed environment authority after asynchronous source reads", async () => {
    const f = await fixture();
    vi.spyOn(f.files, "readAbsoluteFile").mockImplementation(async () => {
      vi.spyOn(f.inventory, "getEnvironment").mockReturnValue({ ...f.environment, configurationRevision: f.environment.configurationRevision + 1 });
      return png();
    });
    await expect(f.show()).rejects.toMatchObject({ reason: "changed" });
    expect(f.repository.publications(f.scope, f.thread.id)).toEqual([]);
  });

  it("cascades retained receipt cleanup with the owning artifact", async () => {
    const f = await fixture(); await f.show();
    expect(f.database.prepare("PRAGMA foreign_key_list(shown_images)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "application_threads", on_delete: "CASCADE" }),
      expect.objectContaining({ table: "output_image_artifacts", on_delete: "CASCADE" }),
    ]));
    f.database.prepare("DELETE FROM output_image_artifacts WHERE application_thread_id=?").run(f.thread.id);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM shown_images").get()).toEqual({ count: 0 });
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM output_image_artifacts").get()).toEqual({ count: 0 });
    await f.artifacts.collectGarbage();
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM output_image_blobs").get()).toEqual({ count: 0 });
  });
});
