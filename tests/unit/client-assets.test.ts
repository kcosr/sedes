import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientAssets } from "../../src/server/http/client-assets.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(readFile).mockReset().mockImplementation(actual.readFile);
  vi.mocked(stat).mockReset().mockImplementation(actual.stat);
  for (const release of cleanup.splice(0)) await release();
});

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

async function serve(clientDirectory: string) {
  const server = express().use(clientAssets(clientDirectory)).listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address() as AddressInfo;
  return (target: string) => new Promise<RawResponse>((resolve, reject) => {
    http.request({ host: "127.0.0.1", port, path: target, headers: { "Accept-Encoding": "br" } }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body: Buffer.concat(chunks) }));
      incoming.on("error", reject);
    }).on("error", reject).end();
  });
}

describe("client assets", () => {
  it("never answers a replaced file with a compression of its previous version", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const clientDirectory = await mkdtemp(path.join(os.tmpdir(), "sedes-client-assets-"));
    cleanup.push(() => rm(clientDirectory, { recursive: true, force: true }));
    const file = path.join(clientDirectory, "app.js");
    const previous = `export const previous = ${JSON.stringify("previous build ".repeat(200))};\n`;
    const replacement = `export const replacement = ${JSON.stringify("replacement build ".repeat(300))};\n`;
    await writeFile(file, previous);
    const get = await serve(clientDirectory);

    // The first request reads the previous build, then compresses slowly.
    let readPrevious!: () => void;
    const previousRead = new Promise<void>((resolve) => { readPrevious = resolve; });
    let finishCompression!: () => void;
    const compressionFinished = new Promise<void>((resolve) => { finishCompression = resolve; });
    vi.mocked(readFile).mockImplementationOnce(async (...parameters: Parameters<typeof readFile>) => {
      const contents = await actual.readFile(...parameters);
      readPrevious();
      await compressionFinished;
      return contents;
    });
    const first = get("/app.js");
    await previousRead;

    // A deployment replaces the file before that compression finishes.
    await writeFile(file, replacement);
    await utimes(file, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    const statsBefore = vi.mocked(stat).mock.results.length;
    const second = get("/app.js");
    await vi.waitFor(() => expect(vi.mocked(stat).mock.results.length).toBeGreaterThan(statsBefore));
    await vi.mocked(stat).mock.results.at(-1)!.value;
    // Let the second request reach its compression before the first one finishes.
    await new Promise((resolve) => setImmediate(resolve));
    finishCompression();

    const [older, newer] = await Promise.all([first, second]);
    expect(brotliDecompressSync(older.body).toString()).toBe(previous);
    expect(newer.status).toBe(200);
    expect(newer.headers.etag).not.toBe(older.headers.etag);
    expect(brotliDecompressSync(newer.body).toString()).toBe(replacement);
  });
});
