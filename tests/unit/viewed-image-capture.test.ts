import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import type { OutputImageArtifactDescriptor } from "../../src/server/output-artifacts/contracts.js";
import { ViewedImageCaptureService } from "../../src/server/output-artifacts/viewed-image-capture.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const bytes = Buffer.alloc(25);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
bytes.writeUInt32BE(13, 8);
bytes.write("IHDR", 12);
bytes.writeUInt32BE(1, 16);
bytes.writeUInt32BE(1, 20);
const descriptor: OutputImageArtifactDescriptor = {
  artifactId: "artifact", mediaType: "image/png", byteSize: bytes.length, sha256: "a".repeat(64),
};
function binding(threadId = "thread"): ConversationBinding {
  return { tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
    applicationThreadId: threadId, backendInstanceId: "backend", connectionProfileId: "profile",
    executionEnvironmentId: "environment", backendConversationId: `native-${threadId}`,
    createdAt: new Date(10).toISOString() };
}
function input(threadId = "thread", publicationKey = "item") {
  return { scope, binding: binding(threadId), publicationKey, absolutePath: "/workspace/image.png" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
function fixture() {
  const published = new Map<string, OutputImageArtifactDescriptor>();
  const environment = { availability: "available", configurationRevision: 1, operationsConfigurationRevision: 1 };
  const files = { readAbsoluteImage: vi.fn(async () => ({
    availability: "available" as const, rootId: "primary", contentKind: "image" as const,
    previewState: "available" as const, contentEncoding: "base64" as const,
    content: bytes.toString("base64"), path: "image.png", mediaType: "image/png" as const,
    sizeBytes: bytes.length, revision: "r1", editable: false as const,
  })) };
  const artifacts = {
    findImage: vi.fn((_scope, threadId, key) => published.get(`${threadId}/${key}`)),
    publishCapturedImage: vi.fn(async (value, assertAllowed) => {
      assertAllowed();
      published.set(`${value.threadId}/${value.publicationKey}`, descriptor);
      return descriptor;
    }),
  };
  const bindings = { getBinding: vi.fn((_scope, threadId) => ({ ...binding(threadId), createdAt: 10 })) };
  const inventory = {
    getThread: vi.fn(() => ({ thread: { workspaceId: "workspace" } })),
    getWorkspace: vi.fn(() => ({ canonicalPath: "/workspace", availability: "available", environmentId: "environment" })),
    getEnvironment: vi.fn(() => environment),
  };
  const service = new ViewedImageCaptureService({ files, artifacts, bindings, inventory } as never);
  return { service, files, artifacts, bindings, inventory, environment, published };
}

afterEach(() => vi.useRealTimers());

describe("ViewedImageCaptureService", () => {
  it("deduplicates concurrent observations and reuses retention before file or environment access", async () => {
    const current = fixture();
    const gate = deferred<void>();
    const image = await current.files.readAbsoluteImage();
    current.files.readAbsoluteImage.mockClear().mockImplementation(async () => {
      await gate.promise;
      return image;
    });
    const first = current.service.capture(input());
    const second = current.service.capture(input());
    expect(current.files.readAbsoluteImage).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect(await first).toEqual(descriptor);
    expect(await second).toEqual(descriptor);
    expect(current.artifacts.publishCapturedImage).toHaveBeenCalledTimes(1);
    current.environment.availability = "unavailable";
    current.files.readAbsoluteImage.mockRejectedValue(new Error("source deleted"));
    expect(await current.service.capture(input())).toEqual(descriptor);
    expect(current.files.readAbsoluteImage).toHaveBeenCalledTimes(1);
    await current.service.close();
    const reattached = new ViewedImageCaptureService(current.service.dependencies);
    expect(await reattached.capture(input())).toEqual(descriptor);
    expect(current.files.readAbsoluteImage).toHaveBeenCalledTimes(1);
    await reattached.close();
  });

  it("bounds active reads globally and per thread while keeping publication in the active slot", async () => {
    const current = fixture();
    const image = await current.files.readAbsoluteImage();
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    let entered = 0;
    current.files.readAbsoluteImage.mockClear().mockImplementation(async () => {
      await gates[entered++]!.promise;
      return image;
    });
    const pending = [current.service.capture(input("one", "a")), current.service.capture(input("one", "b")),
      current.service.capture(input("two")), current.service.capture(input("three"))];
    expect(entered).toBe(2);
    gates[1]!.resolve();
    await vi.waitFor(() => expect(entered).toBe(3));
    gates[0]!.resolve();
    await vi.waitFor(() => expect(entered).toBe(4));
    gates[2]!.resolve();
    gates[3]!.resolve();
    expect(await Promise.all(pending)).toEqual(Array(4).fill(descriptor));
    await current.service.close();
  });

  it("cancels a shared read only after its final subscriber leaves", async () => {
    const current = fixture();
    const gate = deferred<void>();
    const image = await current.files.readAbsoluteImage();
    let readSignal: AbortSignal | undefined;
    current.files.readAbsoluteImage.mockImplementation(async (...args: unknown[]) => {
      readSignal = args[3] as AbortSignal;
      await gate.promise;
      return image;
    });
    const one = new AbortController();
    const two = new AbortController();
    const first = current.service.capture({ ...input(), signal: one.signal });
    const second = current.service.capture({ ...input(), signal: two.signal });
    one.abort();
    expect(await first).toBeUndefined();
    expect(readSignal?.aborted).toBe(false);
    two.abort();
    expect(await second).toBeUndefined();
    expect(readSignal?.aborted).toBe(true);
    gate.resolve();
    await current.service.close();
    expect(current.artifacts.publishCapturedImage).not.toHaveBeenCalled();
  });

  it.each([
    ["thread", (service: ViewedImageCaptureService) => service.cancelThread(scope, "thread")],
    ["environment", (service: ViewedImageCaptureService) => service.cancelEnvironment(scope, "environment")],
  ] as const)("cancels in-flight %s work without touching other scopes", async (_name, cancel) => {
    const current = fixture();
    const gate = deferred<void>();
    const image = await current.files.readAbsoluteImage();
    const signals: AbortSignal[] = [];
    current.files.readAbsoluteImage.mockClear().mockImplementation(async (...args: unknown[]) => {
      signals.push(args[3] as AbortSignal);
      await gate.promise;
      return image;
    });
    const affected = current.service.capture(input());
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    current.service.cancelThread({ ...scope, principalId: "other" }, "thread");
    current.service.cancelEnvironment({ ...scope, tenantId: "other" }, "environment");
    current.service.cancelThread(scope, "unrelated");
    expect(signals[0]!.aborted).toBe(false);
    cancel(current.service);
    expect(await affected).toBeUndefined();
    expect(signals[0]!.aborted).toBe(true);
    gate.resolve();
    expect(await current.service.capture(input("thread", "later"))).toEqual(descriptor);
    expect(current.artifacts.publishCapturedImage).toHaveBeenCalledOnce();
    await current.service.close();
  });

  it("fences a job admitted before revocation from publishing after reapproval", async () => {
    const current = fixture();
    const gate = deferred<void>();
    const image = await current.files.readAbsoluteImage();
    current.files.readAbsoluteImage.mockClear().mockImplementation(async () => {
      await gate.promise;
      return image;
    });
    const admitted = current.service.capture(input());
    await vi.waitFor(() => expect(current.files.readAbsoluteImage).toHaveBeenCalledOnce());
    current.environment.availability = "unavailable";
    current.service.cancelEnvironment(scope, "environment");
    expect(await current.service.capture(input("other"))).toBeUndefined();
    current.environment.availability = "available";
    gate.resolve();
    expect(await admitted).toBeUndefined();
    expect(current.artifacts.publishCapturedImage).not.toHaveBeenCalled();
    expect(current.published.size).toBe(0);
    expect(await current.service.capture(input())).toEqual(descriptor);
    expect(current.artifacts.publishCapturedImage).toHaveBeenCalledOnce();
    await current.service.close();
  });

  it("aborts in-flight work on close and settles only after the active job leaves", async () => {
    const current = fixture();
    const gate = deferred<void>();
    const image = await current.files.readAbsoluteImage();
    let readSignal: AbortSignal | undefined;
    current.files.readAbsoluteImage.mockClear().mockImplementation(async (...args: unknown[]) => {
      readSignal = args[3] as AbortSignal;
      await gate.promise;
      return image;
    });
    const active = current.service.capture(input());
    const queued = current.service.capture(input("thread", "queued"));
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    let closed = false;
    const closing = current.service.close().then(() => { closed = true; });
    expect(await active).toBeUndefined();
    expect(await queued).toBeUndefined();
    expect(readSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    expect(await current.service.capture(input("thread", "after-close"))).toBeUndefined();
    expect(current.files.readAbsoluteImage).toHaveBeenCalledOnce();
    expect(current.artifacts.publishCapturedImage).not.toHaveBeenCalled();
  });

  it("starts a fresh job for a key whose cancelled read is still settling", async () => {
    const current = fixture();
    const gate = deferred<void>();
    const image = await current.files.readAbsoluteImage();
    let entered = 0;
    current.files.readAbsoluteImage.mockClear().mockImplementation(async () => {
      entered += 1;
      if (entered === 1) await gate.promise;
      return image;
    });
    const page = new AbortController();
    const first = current.service.capture({ ...input(), signal: page.signal });
    await vi.waitFor(() => expect(entered).toBe(1));
    page.abort();
    expect(await first).toBeUndefined();
    const retry = current.service.capture(input());
    await Promise.resolve();
    expect(entered).toBe(1);
    gate.resolve();
    expect(await retry).toEqual(descriptor);
    expect(entered).toBe(2);
    expect(current.artifacts.publishCapturedImage).toHaveBeenCalledOnce();
    await current.service.close();
  });

  it("rejects wrong scopes and stale bindings before reading", async () => {
    const current = fixture();
    expect(await current.service.capture({ ...input(), scope: { ...scope, principalId: "other" } })).toBeUndefined();
    expect(await current.service.capture({ ...input(), binding: { ...binding(), backendConversationId: "other" } })).toBeUndefined();
    expect(current.files.readAbsoluteImage).not.toHaveBeenCalled();
    await current.service.close();
  });

  it("checks environment policy again at publication and cleans up without an association", async () => {
    const current = fixture();
    current.artifacts.publishCapturedImage.mockImplementation(async (_value, assertAllowed) => {
      await Promise.resolve();
      current.environment.operationsConfigurationRevision += 1;
      assertAllowed();
      current.published.set("unauthorized", descriptor);
      return descriptor;
    });
    expect(await current.service.capture(input())).toBeUndefined();
    expect(current.published.size).toBe(0);
    await current.service.close();
  });

  it("expires queued work after the total deadline and rejects queue overflow", async () => {
    vi.useFakeTimers();
    const current = fixture();
    const gate = deferred<void>();
    const image = await current.files.readAbsoluteImage();
    current.files.readAbsoluteImage.mockClear().mockImplementation(async () => { await gate.promise; return image; });
    const active = [current.service.capture(input("one")), current.service.capture(input("two"))];
    const queued = Array.from({ length: 32 }, (_, index) => current.service.capture(input("one", `queued-${index}`)));
    expect(await current.service.capture(input("overflow"))).toBeUndefined();
    expect(current.files.readAbsoluteImage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await Promise.all([...active, ...queued])).every(value => value === undefined)).toBe(true);
    gate.resolve();
    await current.service.close();
    expect(current.artifacts.publishCapturedImage).not.toHaveBeenCalled();
  });

  it("denies noncanonical or oversized image payloads before publication", async () => {
    const current = fixture();
    const image = await current.files.readAbsoluteImage();
    current.files.readAbsoluteImage.mockResolvedValue({ ...image, content: `${image.content}\n` });
    expect(await current.service.capture(input())).toBeUndefined();
    current.files.readAbsoluteImage.mockResolvedValue({ ...image, sizeBytes: 16 * 1024 * 1024 + 1 });
    expect(await current.service.capture(input("thread", "oversized"))).toBeUndefined();
    expect(current.artifacts.publishCapturedImage).not.toHaveBeenCalled();
    await current.service.close();
  });
});
