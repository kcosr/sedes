import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const syncedDirectories = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const openedPath = String(args[0]);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              if ((await target.stat()).isDirectory()) {
                syncedDirectories.push(openedPath);
              }
              await target.sync();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import { OutputArtifactBlobStore } from "../../src/server/output-artifacts/blob-store.js";

const roots: string[] = [];

afterEach(async () => {
  syncedDirectories.length = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("OutputArtifactBlobStore durability", () => {
  it("fsyncs every new parent entry before publishing a first blob", async () => {
    const stateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "sedes-output-artifact-durability-"),
    );
    roots.push(stateDirectory);
    const store = new OutputArtifactBlobStore(stateDirectory);
    await store.initialize();

    const artifactRoot = path.join(stateDirectory, "output-artifacts");
    expect(syncedDirectories).toEqual([
      stateDirectory,
      artifactRoot,
      artifactRoot,
    ]);

    syncedDirectories.length = 0;
    const scope = { tenantId: "tenant", principalId: "principal" };
    const bytes = Buffer.from("durable output artifact");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const scopeKey = createHash("sha256")
      .update(scope.tenantId)
      .update("\0")
      .update(scope.principalId)
      .digest("hex");
    const blobRoot = path.join(artifactRoot, "blobs");
    const scopeDirectory = path.join(blobRoot, scopeKey);
    const prefixDirectory = path.join(scopeDirectory, digest.slice(0, 2));

    await Promise.all([
      store.publish(scope, digest, bytes),
      store.publish(scope, digest, bytes),
    ]);

    expect(syncedDirectories).toEqual([
      blobRoot,
      scopeDirectory,
      prefixDirectory,
    ]);
  });
});
