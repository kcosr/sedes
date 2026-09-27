import { describe, expect, it, vi } from "vitest";
import {
  ClaudeViewedImagePublications,
  claudeReadResultImage,
  isClaudeImageReadPath,
  type ClaudeViewedImageCandidate,
} from "../../src/server/backends/claude/claude-viewed-images.js";
import type { OutputArtifactPublisher } from "../../src/server/output-artifacts/contracts.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 1, 0, 0, 0, 1]);
const scope = { tenantId: "tenant-a", principalId: "principal-a" };

function candidate(key: string, data = PNG.toString("base64")): ClaudeViewedImageCandidate {
  return {
    viewedBackendItemId: `claude-item:${key}`,
    identity: { backendItemId: `claude-item-image:${key}`, backendTurnId: "claude-turn:a", sourceOrder: 3 },
    publicationKey: `claude-viewed-image:claude-item-image:${key}`,
    image: { mediaType: "image/png", data },
  };
}

function spied(publisher: OutputArtifactPublisher = createInMemoryOutputArtifactPublisher()) {
  return {
    findImage: vi.fn(publisher.findImage),
    publishImage: vi.fn(publisher.publishImage),
  };
}

describe("Claude image-read recognition", () => {
  it("uses Claude Code's extension test on POSIX and Windows paths", () => {
    expect(["/a/b.png", "/a/b.JPG", "/a/b.jpeg", "/a/b.gif", "/a/b.WebP", "C:\\shots\\b.PNG", "shot.png"]
      .map(isClaudeImageReadPath)).toEqual([true, true, true, true, true, true, true]);
    expect(["/a/b.svg", "/a/b.pdf", "/a/.png", "/a/png", "/a/b.png.txt", ""].map(isClaudeImageReadPath))
      .toEqual([false, false, false, false, false, false]);
  });

  it("takes only a single base64 image block of a supported media type", () => {
    const block = { type: "image", source: { type: "base64", data: "AAAA", media_type: "image/webp" } };
    expect(claudeReadResultImage([block])).toEqual({ mediaType: "image/webp", data: "AAAA" });
    expect(claudeReadResultImage([{ type: "text", text: "note" }, block])).toEqual({ mediaType: "image/webp", data: "AAAA" });
    expect(claudeReadResultImage("AAAA")).toBeUndefined();
    expect(claudeReadResultImage([block, block])).toBeUndefined();
    expect(claudeReadResultImage([{ ...block, source: { ...block.source, media_type: "image/svg+xml" } }])).toBeUndefined();
    expect(claudeReadResultImage([{ ...block, source: { ...block.source, data: "" } }])).toBeUndefined();
    expect(claudeReadResultImage([{ type: "image", source: { type: "file", file_id: "file-1" } }])).toBeUndefined();
  });
});

describe("Claude viewed-image publications", () => {
  it("publishes exact decoded bytes once and then answers from its record", async () => {
    const publisher = spied();
    const publications = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a" });
    const image = candidate("one");
    expect(publications.find(image.publicationKey)).toBeUndefined();
    await expect(publications.publish([image])).resolves.toBe(true);
    expect(publisher.publishImage).toHaveBeenCalledTimes(1);
    expect(publisher.publishImage.mock.calls[0]![0]).toMatchObject({ scope, threadId: "thread-a",
      publicationKey: image.publicationKey, mediaType: "image/png", expectedByteSize: PNG.byteLength });
    expect(Buffer.from(publisher.publishImage.mock.calls[0]![0].bytes)).toEqual(PNG);
    const lookups = publisher.findImage.mock.calls.length;
    expect(publications.find(image.publicationKey)).toMatchObject({ mediaType: "image/png", byteSize: PNG.byteLength });
    await expect(publications.publish([image])).resolves.toBe(false);
    expect(publisher.publishImage).toHaveBeenCalledTimes(1);
    expect(publisher.findImage).toHaveBeenCalledTimes(lookups);
  });

  it("trusts a retained association without rereading bytes", async () => {
    const retained = createInMemoryOutputArtifactPublisher();
    const image = candidate("retained");
    await retained.publishImage({ scope, threadId: "thread-a", publicationKey: image.publicationKey, mediaType: "image/png", bytes: PNG });
    const publisher = spied(retained);
    const publications = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a" });
    expect(publications.find(image.publicationKey)).toBeDefined();
    await expect(publications.publish([image])).resolves.toBe(false);
    expect(publications.find(image.publicationKey)).toBeDefined();
    expect(publisher.findImage).toHaveBeenCalledTimes(1);
    expect(publisher.publishImage).not.toHaveBeenCalled();
  });

  it("keeps each thread and principal to its own associations", async () => {
    const retained = createInMemoryOutputArtifactPublisher();
    const image = candidate("scoped");
    const owner = new ClaudeViewedImagePublications({ outputArtifacts: retained, scope, applicationThreadId: "thread-a" });
    await owner.publish([image]);
    for (const other of [
      new ClaudeViewedImagePublications({ outputArtifacts: retained, scope, applicationThreadId: "thread-b" }),
      new ClaudeViewedImagePublications({ outputArtifacts: retained, scope: { ...scope, principalId: "principal-b" },
        applicationThreadId: "thread-a" }),
    ]) {
      expect(other.find(image.publicationKey)).toBeUndefined();
      await expect(other.publish([image])).resolves.toBe(true);
      expect(other.find(image.publicationKey)!.artifactId).not.toBe(owner.find(image.publicationKey)!.artifactId);
    }
  });

  it.each([
    ["non-canonical base64", `${PNG.toString("base64")}!`],
    ["unpadded base64", Buffer.concat([PNG, Buffer.from([0])]).toString("base64").replace(/=+$/u, "")],
    ["whitespace", ` ${PNG.toString("base64")}`],
  ])("fails %s without offering it, and never retries a failure", async (_label, data) => {
    const publisher = spied();
    const publications = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a" });
    const image = candidate("invalid", data);
    await expect(publications.publish([image])).resolves.toBe(false);
    await expect(publications.publish([image])).resolves.toBe(false);
    publications.schedule([image]);
    await publications.idle();
    expect(publisher.publishImage).not.toHaveBeenCalled();
    expect(publications.find(image.publicationKey)).toBeUndefined();
  });

  it("remembers a store failure against retries only, never against lookups", async () => {
    const retained = createInMemoryOutputArtifactPublisher();
    const publisher = spied(retained);
    publisher.publishImage.mockRejectedValueOnce(new Error("disk full"));
    const image = candidate("store");
    const first = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a" });
    await expect(first.publish([image])).resolves.toBe(false);
    await expect(first.publish([image])).resolves.toBe(false);
    expect(publisher.publishImage).toHaveBeenCalledTimes(1);
    expect(first.find(image.publicationKey)).toBeUndefined();
    // Another path (a reopened handle, a driver read) publishes it; the
    // failed record still finds it.
    const reopened = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a" });
    await expect(reopened.publish([image])).resolves.toBe(true);
    expect(publisher.publishImage).toHaveBeenCalledTimes(2);
    expect(first.find(image.publicationKey)).toEqual(reopened.find(image.publicationKey));
  });

  it("forgets the oldest verified association past its bound, then finds it again", async () => {
    const publisher = spied();
    const publications = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a",
      maximumRemembered: 2 });
    const images = ["one", "two", "three"].map((key) => candidate(key));
    for (const image of images) await publications.publish([image]);
    publisher.findImage.mockClear();
    expect(publications.find(images[2]!.publicationKey)).toBeDefined();
    expect(publications.find(images[1]!.publicationKey)).toBeDefined();
    expect(publisher.findImage).not.toHaveBeenCalled();
    // The first was evicted: one lookup restores it, which evicts the least recent.
    expect(publications.find(images[0]!.publicationKey)).toBeDefined();
    expect(publisher.findImage).toHaveBeenCalledTimes(1);
    expect(publications.find(images[0]!.publicationKey)).toBeDefined();
    expect(publisher.findImage).toHaveBeenCalledTimes(1);
    expect(publications.find(images[2]!.publicationKey)).toBeDefined();
    expect(publisher.findImage).toHaveBeenCalledTimes(2);
  });

  it("does not look up an image it is about to publish", async () => {
    const publisher = spied();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const publishImage = publisher.publishImage.getMockImplementation()!;
    publisher.publishImage.mockImplementation(async (input) => { await gate; return await publishImage(input); });
    const publications = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a" });
    const images = ["one", "two", "three"].map((key) => candidate(key));
    publications.schedule(images);
    for (const image of images) expect(publications.find(image.publicationKey)).toBeUndefined();
    expect(publisher.findImage).not.toHaveBeenCalled();
    release();
    await publications.idle();
    for (const image of images) expect(publications.find(image.publicationKey)).toBeDefined();
    expect(publisher.findImage).not.toHaveBeenCalled();
  });

  it("waits for at most its budget, then finishes the rest in the background and reports each", async () => {
    vi.useFakeTimers();
    try {
      const publisher = spied();
      const releases = new Map<string, () => void>();
      const publishImage = publisher.publishImage.getMockImplementation()!;
      publisher.publishImage.mockImplementation(async (input) => {
        await new Promise<void>((resolve) => releases.set(input.publicationKey, resolve));
        return await publishImage(input);
      });
      const published: string[] = [];
      const publications = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a",
        onPublished: (key) => published.push(key) });
      const images = ["a", "b", "c", "d", "e"].map((key) => candidate(key));
      let settled = false;
      const waited = publications.publish(images, { maximumImages: 2, timeoutMs: 1_000 }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      // The two newest wait inline; two more start in the background.
      expect([...releases.keys()]).toEqual(["d", "e", "c", "b"].map((key) => candidate(key).publicationKey));
      releases.get(candidate("e").publicationKey)!();
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waited).resolves.toBe(true);
      expect(published).toEqual([]);
      // The inline image still running at the deadline and the queued ones
      // are reported as they finish.
      releases.get(candidate("d").publicationKey)!();
      releases.get(candidate("c").publicationKey)!();
      releases.get(candidate("b").publicationKey)!();
      await vi.advanceTimersByTimeAsync(0);
      releases.get(candidate("a").publicationKey)!();
      await publications.idle();
      expect(published).toEqual(["d", "c", "b", "a"].map((key) => candidate(key).publicationKey));
      for (const image of images) expect(publications.find(image.publicationKey)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a reader's wait when it cancels, without dropping the images", async () => {
    const publisher = spied();
    const publications = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a" });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(publications.publish([candidate("one"), candidate("two")], undefined, controller.signal)).resolves.toBe(false);
    await publications.idle();
    expect(publisher.publishImage).toHaveBeenCalledTimes(2);
  });

  it("stops between images when closed and reports nothing after", async () => {
    const publisher = spied();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const publishImage = publisher.publishImage.getMockImplementation()!;
    publisher.publishImage.mockImplementation(async (input) => { await gate; return await publishImage(input); });
    const onPublished = vi.fn();
    const publications = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a",
      onPublished });
    const waited = publications.publish(["a", "b", "c", "d", "e", "f"].map((key) => candidate(key)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publisher.publishImage).toHaveBeenCalledTimes(6);
    publications.close();
    await expect(waited).resolves.toBe(false);
    release();
    await publications.idle();
    publications.schedule([candidate("g")]);
    await expect(publications.publish([candidate("h")])).resolves.toBe(false);
    expect(publisher.publishImage).toHaveBeenCalledTimes(6);
    expect(onPublished).not.toHaveBeenCalled();
  });
});
