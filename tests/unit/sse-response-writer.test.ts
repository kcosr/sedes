import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http, { type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, errorMiddleware } from "../../src/server/http/errors.js";
import { ClientResponseCompression } from "../../src/server/http/response-compression.js";
import { serveThreadLoadError } from "../../src/server/events/thread-sse.js";
import { SseResponseWriter } from "../../src/server/events/sse-response-writer.js";
import { LongLivedHttpConnectionRegistry } from "../../src/server/runtime/application-shutdown.js";

vi.mock("node:zlib", async importOriginal => {
  const original = await importOriginal<typeof import("node:zlib")>();
  return { ...original, createGzip: vi.fn(original.createGzip) };
});

const servers: Server[] = [];
afterEach(async () => {
  vi.mocked(createGzip).mockClear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function serve(
  onWriter: (writer: SseResponseWriter, request: Request, response: Response) => void,
  compression = new ClientResponseCompression(true),
) {
  const app = express();
  app.get("/", (request, response) => {
    const writer = new SseResponseWriter(request, response, compression);
    writer.start();
    onWriter(writer, request, response);
  });
  app.use(errorMiddleware);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return (encoding = "gzip") => new Promise<IncomingMessage>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, headers: { "Accept-Encoding": encoding } }, resolve).on("error", reject);
  });
}

function decode(response: IncomingMessage) {
  const decoder = createGunzip();
  let text = "";
  decoder.setEncoding("utf8");
  decoder.on("data", chunk => { text += chunk; });
  response.pipe(decoder);
  const ended = once(decoder, "end");
  return { get text() { return text; }, ended };
}

describe("SSE response writer", () => {
  it("does not allocate a codec after a response has already ended", () => {
    const response = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    response.end();
    const compression = new ClientResponseCompression(true);
    const request = { header: () => "gzip" } as unknown as Request;
    const writer = new SseResponseWriter(request, response as unknown as Response, compression);
    expect(writer.write("data: late\n\n")).toBe(false);
    writer.end();
    writer.destroy();
    expect(compression.sseStreams).toBe(0);
    expect(vi.mocked(createGzip)).not.toHaveBeenCalled();
  });

  it("flushes each event, heartbeat and final event while retaining one open gzip stream", async () => {
    let writer!: SseResponseWriter;
    const compression = new ClientResponseCompression(true);
    const connect = await serve(value => {
      writer = value;
      writer.write("event: initial\ndata: café\n\n");
    }, compression);
    const response = await connect();
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(response.headers.vary).toBe("Accept-Encoding");
    const output = decode(response);
    await vi.waitFor(() => expect(output.text).toContain("data: café\n\n"));
    expect(response.complete).toBe(false);
    writer.write(": heartbeat\n\n");
    await vi.waitFor(() => expect(output.text).toContain(": heartbeat\n\n"));
    writer.write("event: final\ndata: done\n\n");
    await vi.waitFor(() => expect(output.text).toContain("data: done\n\n"));
    expect(response.complete).toBe(false);
    writer.end();
    writer.end();
    expect(writer.write("data: forbidden\n\n")).toBe(false);
    await output.ended;
    expect(output.text).not.toContain("forbidden");
    expect(compression.sseStreams).toBe(0);
  });

  it("accepts a frame larger than the writable watermark once and emits drain for a fast reader", async () => {
    let writer!: SseResponseWriter;
    const connect = await serve(value => { writer = value; });
    const response = await connect();
    const output = decode(response);
    const frame = `data: ${randomBytes(128 * 1_024).toString("base64")}\n\n`;
    const drained = new Promise<void>(resolve => writer.onceDrain(resolve));
    expect(writer.write(frame)).toBe(false);
    await drained;
    await vi.waitFor(() => expect(output.text).toBe(frame));
    writer.end();
    await output.ended;
  });

  it("reuses the writer for a post-header thread load error and finishes its gzip trailer", async () => {
    const connect = await serve(writer => {
      writer.write("event: diagnostic\ndata: {}\n\n");
      serveThreadLoadError(writer, new ApiError(409, "backend_incompatible_protocol", "Invalid history."), "request-test");
    });
    const output = decode(await connect());
    await output.ended;
    expect(output.text).toContain("event: diagnostic\n");
    expect(output.text).toContain("event: thread-load-error\n");
    expect(output.text).toContain('"code":"backend_incompatible_protocol"');
    expect(output.text).toContain('"requestId":"request-test"');
  });

  it("finishes through the mutable shutdown handle without truncating gzip", async () => {
    const connections = new LongLivedHttpConnectionRegistry();
    const compression = new ClientResponseCompression(true);
    const connect = await serve((writer, _request, response) => {
      const tracked = connections.track(response);
      tracked.setGracefulEnd(() => writer.end());
      writer.write("data: before shutdown\n\n");
    }, compression);
    const output = decode(await connect());
    await vi.waitFor(() => expect(output.text).toContain("before shutdown"));
    await connections.closeAll(100);
    await output.ended;
    expect(compression.sseStreams).toBe(0);
    expect(connections.size).toBe(0);
  });

  it("releases slots on disconnect and keeps late codec errors and writes harmless", async () => {
    let writer!: SseResponseWriter;
    const compression = new ClientResponseCompression(true);
    const connect = await serve(value => {
      writer = value;
      writer.write("data: connected\n\n");
    }, compression);
    const response = await connect();
    response.destroy();
    await vi.waitFor(() => expect(compression.sseStreams).toBe(0));
    expect(writer.write("data: late\n\n")).toBe(false);
    writer.destroy();
    writer.end();
    const codec = vi.mocked(createGzip).mock.results[0]!.value;
    expect(() => codec.emit("error", new Error("late native completion"))).not.toThrow();
    expect(compression.sseStreams).toBe(0);
  });

  it("terminates on codec error instead of switching representation", async () => {
    let writer!: SseResponseWriter;
    const compression = new ClientResponseCompression(true);
    const connect = await serve(value => {
      writer = value;
      writer.write("data: connected\n\n");
    }, compression);
    const response = await connect();
    response.on("error", () => {});
    const closed = new Promise<void>(resolve => response.once("close", resolve));
    vi.mocked(createGzip).mock.results[0]!.value.destroy(new Error("codec failed"));
    await closed;
    expect(writer.write("data: late\n\n")).toBe(false);
    expect(compression.sseStreams).toBe(0);
  });

  it("caps compression slots and negotiates acceptable identity without allocating another codec", async () => {
    const compression = new ClientResponseCompression(true);
    const leases = Array.from({ length: 64 }, () => compression.trySse()!);
    expect(compression.trySse()).toBeUndefined();
    const connect = await serve(writer => { writer.write("data: plain\n\n"); writer.end(); }, compression);
    const plain = await connect();
    expect(plain.headers["content-encoding"]).toBeUndefined();
    plain.resume();
    await once(plain, "end");
    const refused = await connect("gzip, identity;q=0");
    expect(refused.statusCode).toBe(503);
    refused.resume();
    await once(refused, "end");
    expect(vi.mocked(createGzip)).not.toHaveBeenCalled();
    for (const lease of leases) { lease.release(); lease.release(); }
    expect(compression.sseStreams).toBe(0);
  });

  it("keeps codec input bounded behind a blocked output and releases the slot on forced close", async () => {
    class BlockedResponse extends Writable {
      readonly status = () => this;
      readonly setHeader = () => this;
      readonly vary = () => this;
      readonly flushHeaders = () => {};
      readonly pending: Array<() => void> = [];
      constructor() { super({ highWaterMark: 1 }); }
      override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
        this.pending.push(callback);
      }
    }
    const response = new BlockedResponse();
    const request = { header: () => "gzip" } as unknown as Request;
    const compression = new ClientResponseCompression(true);
    const writer = new SseResponseWriter(request, response as unknown as Response, compression);
    const frame = `data: ${randomBytes(256 * 1_024).toString("base64")}\n\n`;
    expect(writer.write(frame)).toBe(false);
    await vi.waitFor(() => expect(response.pending.length).toBe(1));
    expect(writer.writableLength).toBeLessThanOrEqual(Buffer.byteLength(frame));
    expect(writer.writableHighWaterMark).toBe(64 * 1_024);
    writer.destroy();
    expect(compression.sseStreams).toBe(0);
    expect(writer.write(frame)).toBe(false);
  });
});
