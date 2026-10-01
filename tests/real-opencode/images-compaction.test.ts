import { createOpenCodeNativePortFixture, openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ConversationHandle, SubmitTurnInput } from "../../src/server/backends/contracts.js";
import type { OutputImageArtifactDescriptor, PublishOutputImageInput } from "../../src/server/output-artifacts/contracts.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { boundedOpenCodeProcessFile } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";
import { RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(png).digest("hex");
it.runIf(RUN_REAL_OPENCODE)("qualifies stock v2 canonical image input, exact read capture and reserved manual compaction", async () => {
  const model = await startOpencodeModelFixture({ vision: true });
  let native: Awaited<ReturnType<typeof startOpencodeNativeFixture>> | undefined;
  let current: ReturnType<typeof createOpenCodeConversationFixture> | undefined;
  let client: OpenCodeHttpClient | undefined, handle: ConversationHandle | undefined;
  const artifacts = new Map<string, OutputImageArtifactDescriptor>();
  const published: PublishOutputImageInput[] = [];
  const input = (id: string, text: string): SubmitTurnInput => ({ applicationOperationId: id, mutationId: id,
    reconciliationToken: id, source: { kind: "user" }, text, contextExcerpts: [], taskContexts: [], attachments: [] });
  try {
    native = await startOpencodeNativeFixture({ config: model.config });
    const environment = (await boundedOpenCodeProcessFile(`/proc/${native.pid}/environ`, 1_048_576)).toString("utf8");
    const password = environment.split("\0").find(entry => entry.startsWith("OPENCODE_PASSWORD="))?.slice("OPENCODE_PASSWORD=".length);
    if (!password) throw new Error("isolated native credential unavailable");
    client = new OpenCodeHttpClient({ endpoint: native.url, password });
    const port = createOpenCodeNativePortFixture(client, { directory: native.workspace, sessionID: "ses_m4_images_compact" });
    const api = new OpenCodeNativeApi(port), mutations = new OpenCodeNativeMutations(port);
    const session = await mutations.createSession({ id: "ses_m4_images_compact", title: "M4 images and compaction",
      location: { directory: native.workspace }, model: { providerID: "probe", id: "probe-model" },
      permissions: [{ action: "*", resource: "*", effect: "allow" }] }, openCodeTestMutationControl("create"));
    await vi.waitFor(async () => expect((await mutations.listModels(native!.workspace)).some(item => item.id === "probe-model")).toBe(true), { timeout: 20_000, interval: 25 });
    current = createOpenCodeConversationFixture({ native: { client, sessionID: session.id, directory: native.workspace } });
    current.context.settings.updateDesired(scope, threadID, { expectedRevision: 0, desired: { providerID: "probe", id: "probe-model" }, now: Date.now() });
    Object.assign(current.context.outputArtifacts, {
      findImage: (_scope: unknown, _thread: unknown, key: string) => artifacts.get(key),
      publishImage: async (value: PublishOutputImageInput) => {
        published.push(value);
        const result: OutputImageArtifactDescriptor = { artifactId: randomUUID(), mediaType: value.mediaType,
          byteSize: value.bytes.byteLength, sha256: createHash("sha256").update(value.bytes).digest("hex") };
        artifacts.set(value.publicationKey, result); return result;
      },
    });
    handle = await current.driver.attach(current.target);
    await handle.establishProjection({ signal: new AbortController().signal });
    expect(await handle.backendCapabilities()).toMatchObject({ composerAttachments: { fileStaging: true, nativeImage: true }, providerOutputArtifacts: { nativeImage: false } });
    const file = path.join(native.workspace, "qualification-pixel.png"); await writeFile(file, png);
    const attachment = { id: randomUUID(), kind: "image" as const, fileName: "qualification-pixel.png", mediaType: "image/png" as const,
      byteSize: png.length, sha256, agentPath: file };
    const { agentPath: _path, ...fact } = attachment;
    await handle.submit({ ...input("image-input", "Look at the attached image"), attachments: [attachment],
      attachmentBytes: { read: async () => png }, attachmentEvidence: { resolve: () => [fact] } });
    await vi.waitFor(async () => expect((await api.getActive())[session.id]).toBeUndefined(), { timeout: 20_000, interval: 25 });
    expect(model.requests.some(request => request.images.some(image => image.sha256 === sha256))).toBe(true);
    const imageInput = (await handle.establishProjection({ signal: new AbortController().signal })).snapshot;
    expect(Object.values(imageInput.itemsById).some(item => item.semanticKind === "user_message" && item.content.some(part => part.kind === "attachment"))).toBe(true);
    expect(JSON.stringify(imageInput)).not.toContain(file);

    const tool = model.callToolNextStream("read the qualification image", "read", { path: file });
    await handle.submit(input("image-read", "read the qualification image"));
    await tool.called;
    await vi.waitFor(async () => {
      const snapshot = (await handle!.establishProjection({ signal: new AbortController().signal })).snapshot;
      expect(Object.values(snapshot.itemsById).some(item => item.semanticKind === "image" && item.origin.kind === "viewed" && item.origin.capture === "provider_input")).toBe(true);
    }, { timeout: 20_000, interval: 100 });
    expect(published).toHaveLength(1); expect(Buffer.from(published[0]!.bytes)).toEqual(png);
    expect(model.requests.filter(request => request.images.some(image => image.sha256 === sha256)).length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(async () => expect((await api.getActive())[session.id]).toBeUndefined(), { timeout: 20_000, interval: 25 });
    const compact = { action: "compact", applicationOperationId: "manual-compact" } as const;
    await expect(handle.perform(compact)).resolves.toEqual({ accepted: true });
    const receipt = current.repository.requireOperation(scope, threadID, compact.applicationOperationId, "action");
    expect(receipt.nativeInputId).toMatch(/^msg_/u);
    let nativeCompactStatus: "completed" | "failed" | undefined;
    await vi.waitFor(async () => {
      const message = await api.getMessage(session.id, receipt.nativeInputId!);
      expect(message).toMatchObject({ type: "compaction", reason: "manual" });
      expect(message.type === "compaction" && message.status !== "running").toBe(true);
      if (message.type === "compaction" && message.status !== "running") nativeCompactStatus = message.status;
    }, { timeout: 20_000, interval: 100 });
    await expect(handle.reconcileAction(compact)).resolves.toEqual({ outcome: "accepted" });
    expect(Object.values((await handle.establishProjection({ signal: new AbortController().signal })).snapshot.itemsById).find(item => item.semanticKind === "compaction"))
      .toMatchObject({ status: nativeCompactStatus });
  } finally {
    await handle?.close();
    try { await current?.dispose(); } finally { client?.close(); try { await native?.stop(); } finally { await model.stop(); } }
  }
}, 90_000);
