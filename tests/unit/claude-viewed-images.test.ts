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
    expect(publications.publishable([image])).toEqual([]);
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
      expect(other.publishable([image])).toEqual([image]);
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
    expect(publisher.publishImage).not.toHaveBeenCalled();
    expect(publications.publishable([image])).toEqual([]);
    expect(publications.find(image.publicationKey)).toBeUndefined();
    expect(publisher.findImage).not.toHaveBeenCalled();
  });

  it("remembers a store failure for this record only", async () => {
    const publisher = spied();
    publisher.publishImage.mockRejectedValueOnce(new Error("disk full"));
    const image = candidate("store");
    const first = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a" });
    await expect(first.publish([image])).resolves.toBe(false);
    await expect(first.publish([image])).resolves.toBe(false);
    expect(publisher.publishImage).toHaveBeenCalledTimes(1);
    const reopened = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a" });
    await expect(reopened.publish([image])).resolves.toBe(true);
    expect(publisher.publishImage).toHaveBeenCalledTimes(2);
  });

  it("stops between images when the reader cancels", async () => {
    const publisher = spied();
    const publications = new ClaudeViewedImagePublications({ outputArtifacts: publisher, scope, applicationThreadId: "thread-a" });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(publications.publish([candidate("one"), candidate("two")], controller.signal)).rejects.toThrow("cancelled");
    expect(publisher.publishImage).not.toHaveBeenCalled();
  });
});
