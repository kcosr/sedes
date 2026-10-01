import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@opencode/client";
import type { SubmitTurnInput } from "../../src/server/backends/contracts.js";
import { openCodeAttachmentEvidence, prepareOpenCodeAttachments, inspectOpenCodeAttachmentEnvelope } from "../../src/server/backends/opencode/opencode-attachments.js";
import { classifyOpenCodeRead, decodeOpenCodeRaster, materializeOpenCodeViewedImages } from "../../src/server/backends/opencode/opencode-viewed-images.js";
import { parseOpenCodeNativeMessage, type OpenCodeNativeMessage } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeHistoryProjection, openCodeHistoryItemId } from "../../src/server/backends/opencode/opencode-history-projection.js";
import { qualifiedOpenCodeModelId } from "../../src/server/backends/opencode/opencode-model-selection.js";
import type { OutputImageArtifactDescriptor, OutputArtifactPublisher } from "../../src/server/output-artifacts/contracts.js";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const key = Buffer.alloc(32, 7), operationId = "operation";
function attachmentInput(): SubmitTurnInput {
  const attachment = { id: randomUUID(), kind: "image" as const, mediaType: "image/png" as const, fileName: "pixel.png", byteSize: png.length,
    sha256: digest(png), agentPath: "/private/staging/pixel.png" };
  const { agentPath: _path, ...fact } = attachment;
  return { applicationOperationId: operationId, mutationId: operationId, reconciliationToken: operationId, source: { kind: "user" },
    text: "Look", contextExcerpts: [], taskContexts: [], attachments: [attachment],
    attachmentBytes: { read: vi.fn(async () => png) }, attachmentEvidence: { resolve: () => [fact] } };
}
const model = { providerID: "fixture", id: "vision" };
const modelInfo = { ...model, capabilities: { input: ["text", "image"], output: ["text"], tools: true } } as ModelInfo;
function readMessage(input: { id?: string; path?: string; status?: "running" | "completed"; uri?: string; mime?: string } = {}) {
  const path = input.path ?? "/private/images/pixel.png";
  return parseOpenCodeNativeMessage({ id: input.id ?? "msg_read", type: "assistant", agent: "build", model,
    time: { created: 10, streamed: 11, completed: 15 }, finish: "tool-calls", content: [{ type: "tool", id: "call_read", name: "read",
      time: { created: 11, ran: 12, ...(input.status === "running" ? {} : { completed: 14 }) },
      state: input.status === "running" ? { status: "running", input: { path }, metadata: {} } : { status: "completed", input: { path }, content: [
        { type: "text", text: "Image read successfully" }, { type: "file", uri: input.uri ?? `data:image/png;base64,${png.toString("base64")}`,
          mime: input.mime ?? "image/png", name: path }] } }] });
}
function nextStep(extra: Record<string, unknown> = {}) {
  return parseOpenCodeNativeMessage(JSON.parse(JSON.stringify({ id: "msg_next", type: "assistant", agent: "build", model,
    time: { created: 20, streamed: 21, completed: 22 }, content: [{ type: "text", text: "I see it" }], finish: "stop", ...extra })));
}
function publisher() {
  const images = new Map<string, OutputImageArtifactDescriptor>();
  const publishImage = vi.fn<OutputArtifactPublisher["publishImage"]>(async input => {
    const result = { artifactId: randomUUID(), mediaType: input.mediaType, byteSize: input.bytes.byteLength, sha256: digest(input.bytes) };
    images.set(input.publicationKey, result); return result;
  });
  return { images, publishImage, findImage: (_scope: unknown, _thread: unknown, key: string) => images.get(key) };
}
function materialize(messages: readonly OpenCodeNativeMessage[], artifacts = publisher(), models = new Map([[qualifiedOpenCodeModelId(model), modelInfo]])) {
  return materializeOpenCodeViewedImages({ messages, nativeNamespaceKey: "store", sessionID: "ses_images", scope: { tenantId: "tenant", principalId: "principal" },
    threadId: "thread", publisher: artifacts, models, assertCurrent: async () => {} });
}
function projection(messages: readonly OpenCodeNativeMessage[], images?: Awaited<ReturnType<typeof materialize>>, previous?: OpenCodeHistoryProjection) {
  return new OpenCodeHistoryProjection({ sessionId: "ses_images", messages, frontier: "frontier", decodedBytes: 0, retainedDecodedBytes: 0, records: messages.length },
    { bindingScope: ["tenant", "principal", "thread", "store"], generation: "generation", activity: "idle", viewedImages: images, previous });
}
describe("OpenCode canonical composer attachments", () => {
  it("uses owned bytes for native image input and authenticated staged paths only for the file facet", async () => {
    const input = attachmentInput(); const result = await prepareOpenCodeAttachments(input, { key, operationId, text: "Look", acceptsImages: true });
    expect(result.files).toEqual([{ uri: `data:image/png;base64,${png.toString("base64")}`, name: "pixel.png" }]);
    expect(input.attachmentBytes!.read).toHaveBeenCalledWith(input.attachments[0], undefined);
    expect(JSON.stringify(openCodeAttachmentEvidence(input))).not.toContain("/private");
    const inspected = inspectOpenCodeAttachmentEnvelope(result.text, key, operationId);
    expect(inspected).toMatchObject({ text: "Look", attachments: [{ fileName: "pixel.png", kind: "image" }] });
    expect(JSON.stringify(inspected)).not.toContain("/private");
    expect(inspectOpenCodeAttachmentEnvelope(result.text, key, "wrong")).toEqual({ text: "Look" });
    expect(inspectOpenCodeAttachmentEnvelope(result.text, undefined, undefined)).toEqual({ text: "Look" });
  });
  it.each(["nonvision", "digest", "mime", "ownership"])("rejects %s before producing native input", async kind => {
    const input = attachmentInput();
    const candidate = kind === "digest" ? { ...input, attachmentBytes: { read: async () => Buffer.from("changed") } }
      : kind === "mime" ? { ...input, attachments: [{ ...input.attachments[0]!, kind: "image" as const, mediaType: "image/jpeg" as const }] }
      : kind === "ownership" ? { ...input, attachmentEvidence: { resolve: () => [] } } : input;
    await expect(prepareOpenCodeAttachments(candidate, { key, operationId, text: "Look", acceptsImages: kind !== "nonvision" })).rejects.toMatchObject({ crossedSubmissionBoundary: false });
  });
  it("retains nonimage staged files without treating them as native media or reading host paths", async () => {
    const original = attachmentInput(), file = { ...original.attachments[0]!, kind: "file" as const, mediaType: "application/octet-stream" as const };
    const { agentPath: _path, ...fact } = file;
    const input = { ...original, attachments: [file], attachmentEvidence: { resolve: () => [fact] } };
    const result = await prepareOpenCodeAttachments(input, { key, operationId, text: "Work", acceptsImages: false });
    expect(result.files).toBeUndefined(); expect(input.attachmentBytes!.read).not.toHaveBeenCalled();
  });
  it("rejects several individually valid images before reading bytes or producing an unreadable native record", async () => {
    const original = attachmentInput();
    const attachments = Array.from({ length: 3 }, () => ({ ...original.attachments[0]!, id: randomUUID(), byteSize: 9 * 1_024 * 1_024 }));
    const input = { ...original, attachments, attachmentEvidence: { resolve: () => attachments.map(({ agentPath: _path, ...fact }) => fact) } };
    await expect(prepareOpenCodeAttachments(input, { key, operationId, text: "Look", acceptsImages: true })).rejects.toMatchObject({
      crossedSubmissionBoundary: false, backendCode: "opencode_attachments_unavailable", safeMessage: expect.stringContaining("16 MiB"),
    });
    expect(input.attachmentBytes!.read).not.toHaveBeenCalled();
  });
  it("allows multiple images totaling 16 MiB without charging ordinary staged file bytes to the image bound", async () => {
    const original = attachmentInput(), bytes = Buffer.concat([png, Buffer.alloc(4 * 1_024 * 1_024 - png.length)]);
    const images = Array.from({ length: 4 }, () => ({ ...original.attachments[0]!, id: randomUUID(), byteSize: bytes.length, sha256: digest(bytes) }));
    const file = { ...original.attachments[0]!, id: randomUUID(), kind: "file" as const, mediaType: "application/octet-stream" as const, byteSize: 25 * 1_024 * 1_024 };
    const attachments = [...images, file];
    const input = { ...original, attachments, attachmentEvidence: { resolve: () => attachments.map(({ agentPath: _path, ...fact }) => fact) },
      attachmentBytes: { read: vi.fn(async () => bytes) } };
    const result = await prepareOpenCodeAttachments(input, { key, operationId, text: "Look", acceptsImages: true });
    expect(result.files).toHaveLength(4);
    expect(input.attachmentBytes.read).toHaveBeenCalledTimes(4);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(24 * 1_024 * 1_024);
  });
});
describe("OpenCode viewed native images", () => {
  it("recognizes exact read contract while keeping paths and inline bytes private", async () => {
    const read = readMessage(); const images = await materialize([read]); const before = projection([read], images);
    const item = Object.values(before.itemsById)[0]!;
    expect(item).toMatchObject({ semanticKind: "viewed_image", fileName: { text: "pixel.png" } });
    expect(Object.values(before.itemsById)).toHaveLength(1);
    expect(JSON.stringify(before.snapshot())).not.toContain("/private"); expect(JSON.stringify(before.snapshot())).not.toContain(png.toString("base64"));
  });
  it("publishes exact returned bytes only after a subsequent actual vision response", async () => {
    const read = readMessage(), next = nextStep(), artifacts = publisher();
    await materialize([read], artifacts); expect(artifacts.publishImage).not.toHaveBeenCalled();
    const images = await materialize([read, next], artifacts); expect(artifacts.publishImage).toHaveBeenCalledTimes(1);
    expect(Buffer.from(artifacts.publishImage.mock.calls[0]![0].bytes)).toEqual(png);
    expect(Object.values(projection([read, next], images).itemsById).map(item => item.semanticKind)).toEqual(["viewed_image", "image", "assistant_message"]);
  });
  it.each(["started", "nonvision", "retry"])("does not assert provider input for %s next step", async kind => {
    const artifacts = publisher();
    const next = kind === "started" ? nextStep({ time: { created: 20 }, content: [], finish: undefined })
      : kind === "retry" ? nextStep({ time: { created: 20, completed: 21 }, content: [], error: { type: "unknown", message: "before provider output" }, finish: undefined }) : nextStep();
    await materialize([readMessage(), next], artifacts, kind === "nonvision" ? new Map() : undefined);
    expect(artifacts.publishImage).not.toHaveBeenCalled();
  });
  it("keeps later source orders stable when a viewed child appears in a closed cached turn", async () => {
    const read = readMessage(), next = nextStep(); const idle = parseOpenCodeNativeMessage({ id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 30 } });
    const before = projection([read, next, idle], await materialize([read]));
    const after = projection([read, next, idle], await materialize([read, next]), before);
    expect(after.itemsById[openCodeHistoryItemId(next.id, 0)]!.sourceOrder).toBe(before.itemsById[openCodeHistoryItemId(next.id, 0)]!.sourceOrder);
    expect(Object.values(after.itemsById).map(item => item.sourceOrder)).toEqual([0, 1, 2]);
  });
  it("retains published association after source loss but rejects conflicting bytes", async () => {
    const artifacts = publisher(); await materialize([readMessage(), nextStep()], artifacts);
    const running = await materialize([readMessage({ status: "running" })], artifacts);
    expect([...running.values()][0]!.artifact).toBeDefined();
    const conflict = await materialize([readMessage({ uri: "data:image/png;base64,YWJj" }), nextStep()], artifacts);
    expect([...conflict.values()][0]!.artifact).toBeUndefined(); expect(artifacts.publishImage).toHaveBeenCalledTimes(1);
  });
  it("leaves opaque provider checkpoint context unavailable and trims media at local compaction", async () => {
    const checkpoint = parseOpenCodeNativeMessage({ id: "msg_compact", type: "compaction", status: "completed", reason: "manual", time: { created: 1 }, summary: "summary", recent: "",
      providerContext: { version: 1, provenance: { providerID: "fixture", provider: "fixture", modelID: "vision", route: "route", protocol: "protocol", endpoint: "endpoint" }, messages: [] } });
    const artifacts = publisher(); await materialize([checkpoint, readMessage(), nextStep()], artifacts); expect(artifacts.publishImage).not.toHaveBeenCalled();
    const local = { ...checkpoint, providerContext: undefined } as OpenCodeNativeMessage;
    await materialize([local, readMessage(), nextStep()], artifacts); expect(artifacts.publishImage).toHaveBeenCalledTimes(1);
  });
  it("does not claim image survival above stock 25MiB omission trigger", async () => {
    const users = Array.from({ length: 26 }, (_, index) => parseOpenCodeNativeMessage({ id: `msg_user${index}`, type: "user", text: "image", time: { created: 1 },
      files: [{ data: "A".repeat(1_024 * 1_024), mime: "image/png", source: { type: "inline" } }] }));
    const artifacts = publisher(); await materialize([...users, readMessage(), nextStep()], artifacts); expect(artifacts.publishImage).not.toHaveBeenCalled();
  });
  it("requires complete reviewed arguments and exact raster result grammar", () => {
    const read = readMessage({ path: "/private/extensionless" }) as Extract<OpenCodeNativeMessage, { type: "assistant" }>;
    expect(classifyOpenCodeRead(read.content[0] as never).kind).toBe("viewed");
    expect(classifyOpenCodeRead({ ...read.content[0], state: { status: "streaming", input: "{\"path\":" } } as never).kind).toBe("hold");
    expect(classifyOpenCodeRead({ ...read.content[0], name: "plugin_read" } as never).kind).toBe("ordinary");
    expect(decodeOpenCodeRaster(`data:image/jpeg;base64,${png.toString("base64")}`, "image/jpeg")).toBeUndefined();
    expect(decodeOpenCodeRaster(`data:image/png;base64,${png.toString("base64")}\n`, "image/png")).toBeUndefined();
    expect(decodeOpenCodeRaster("https://private/image.png", "image/png")).toBeUndefined();
  });
});
