import { once } from "node:events";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzip } from "node:zlib";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncCodecBudget } from "../../src/internal/compression/async-codec-budget.js";
import { errorMiddleware } from "../../src/server/http/errors.js";
import { ClientResponseCompression, negotiateResponseEncoding, sendJsonResponse } from "../../src/server/http/response-compression.js";

vi.mock("node:zlib", async importOriginal => {
  const original = await importOriginal<typeof import("node:zlib")>();
  return { ...original, gzip: vi.fn(original.gzip) };
});

const servers: Server[] = [];
afterEach(async () => {
  vi.mocked(gzip).mockReset().mockImplementation((await vi.importActual<typeof import("node:zlib")>("node:zlib")).gzip);
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

interface RawResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }

async function serve(
  handle: (request: Request, response: Response) => Promise<void>,
  configure?: (app: express.Express) => void,
) {
  const app = express();
  configure?.(app);
  app.use(handle);
  app.use(errorMiddleware);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return (headers: Record<string, string> = {}, method = "GET") => new Promise<RawResponse>((resolve, reject) => {
    http.request({ host: "127.0.0.1", port, method, headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
}

const encodingRequest = (value?: string): Request => ({ header: () => value }) as unknown as Request;

describe("HTTP response coding selection", () => {
  it.each([
    [undefined, "identity"], ["", "identity"], ["gzip", "gzip"],
    ["br, gzip, deflate", "gzip"], ["gzip;q=0", "identity"],
    ["gzip;q=0, *;q=1", "identity"], ["*;q=0.5", "gzip"],
    ["gzip;q=0.5, identity;q=1", "identity"], ["gzip;q=1, identity;q=0.5", "gzip"],
    ["GZip;q=0.5, identity;q=0", "gzip"], ["gzip;q=0.5", "gzip"],
    ["gzip;q=0, gzip;q=1", "identity"], ["br", "identity"],
  ] as const)("selects %s as %s", (header, encoding) => {
    expect(negotiateResponseEncoding(encodingRequest(header), true).encoding).toBe(encoding);
  });

  it.each(["*;q=0", "gzip;q=0, identity;q=0", "br, identity;q=0"])("rejects unavailable representations: %s", header => {
    expect(() => negotiateResponseEncoding(encodingRequest(header), true)).toThrow("No acceptable response");
  });

  it.each(["gzip;q=2", "gzip;q=0.1234", "gzip;q=wat", "gzip;q=1;evil=1"])("rejects malformed quality: %s", header => {
    expect(() => negotiateResponseEncoding(encodingRequest(header), true)).toThrow("Accept-Encoding header is invalid");
  });

  it("does not send gzip when disabled, or forbidden identity when disabled", () => {
    expect(negotiateResponseEncoding(encodingRequest("gzip"), false).encoding).toBe("identity");
    expect(() => negotiateResponseEncoding(encodingRequest("gzip, identity;q=0"), false)).toThrow("No acceptable response");
  });
});

describe("finite JSON response compression", () => {
  it("sends gzip with exact JSON bytes, content length, Vary and private caching", async () => {
    const compression = new ClientResponseCompression(true);
    const value = { text: "café <script>& ".repeat(400) };
    const get = await serve(async (request, response) => {
      response.setHeader("Cache-Control", "private, no-store");
      response.vary("Origin");
      response.setHeader("Content-Length", "999999");
      response.setHeader("ETag", '"uncompressed-validator"');
      await sendJsonResponse(request, response, value, compression);
    }, app => app.set("json escape", true));
    const response = await get({ "Accept-Encoding": "gzip" });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["content-length"]).toBe(String(response.body.length));
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Origin, Accept-Encoding");
    const json = gunzipSync(response.body).toString();
    expect(JSON.parse(json)).toEqual(value);
    expect(json).not.toContain("<script>");
    expect(response.headers.etag).not.toBe('"uncompressed-validator"');
    expect(compression.jsonInputBytes).toBe(0);
  });

  it("keeps subthreshold responses plain unless identity is forbidden", async () => {
    const compression = new ClientResponseCompression(true);
    const get = await serve((request, response) => sendJsonResponse(request, response, { small: true }, compression));
    const plain = await get({ "Accept-Encoding": "gzip" });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers.vary).toBe("Accept-Encoding");
    const compressed = await get({ "Accept-Encoding": "gzip, identity;q=0" });
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(compressed.body)).toEqual(plain.body);
  });

  it("keeps a larger codec result plain when identity is acceptable", async () => {
    vi.mocked(gzip).mockImplementationOnce(((input: string, _options: unknown, callback: (error: null, result: Buffer) => void) => {
      callback(null, Buffer.alloc(Buffer.byteLength(input) + 1));
    }) as typeof gzip);
    const compression = new ClientResponseCompression(true);
    const value = { text: "a".repeat(2_000) };
    const get = await serve((request, response) => sendJsonResponse(request, response, value, compression));
    const response = await get({ "Accept-Encoding": "gzip" });
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(response.body.toString())).toEqual(value);
  });

  it("uses final representation validators for HEAD and conditional GET", async () => {
    const compression = new ClientResponseCompression(true);
    const get = await serve((request, response) => sendJsonResponse(request, response, { text: "repeat ".repeat(1_000) }, compression));
    const gzipResponse = await get({ "Accept-Encoding": "gzip" });
    const plainResponse = await get({ "Accept-Encoding": "identity" });
    expect(gzipResponse.headers.etag).not.toBe(plainResponse.headers.etag);
    const head = await get({ "Accept-Encoding": "gzip" }, "HEAD");
    expect(head.body.length).toBe(0);
    expect(head.headers["content-length"]).toBe(gzipResponse.headers["content-length"]);
    expect(head.headers.etag).toBe(gzipResponse.headers.etag);
    const fresh = await get({ "Accept-Encoding": "gzip", "If-None-Match": gzipResponse.headers.etag! });
    expect(fresh.status).toBe(304);
    expect(fresh.body.length).toBe(0);
    expect(fresh.headers["content-length"]).toBeUndefined();
    const different = await get({ "Accept-Encoding": "identity", "If-None-Match": gzipResponse.headers.etag! });
    expect(different.status).toBe(200);
  });

  it("has bounded admission without queued JSON jobs", async () => {
    const codecs = new AsyncCodecBudget({ slots: 1 });
    const busy = codecs.tryAcquire()!;
    const compression = new ClientResponseCompression(true, codecs);
    const get = await serve((request, response) => sendJsonResponse(request, response, { text: "a".repeat(2_000) }, compression));
    const plain = await get({ "Accept-Encoding": "gzip" });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const refused = await get({ "Accept-Encoding": "gzip, identity;q=0" });
    expect(refused.status).toBe(503);
    expect(refused.headers["content-encoding"]).toBeUndefined();
    expect(codecs.waitingCount).toBe(0);
    busy.release();
    const reservation = compression.tryJson(64 * 1_024 * 1_024)!;
    expect(compression.tryJson(1)).toBeUndefined();
    reservation.release();
    reservation.release();
    expect(compression.jsonInputBytes).toBe(0);
    expect(codecs.activeCount).toBe(0);
  });

  it("does not commit encoding headers before codec success", async () => {
    vi.mocked(gzip).mockImplementationOnce(((_input: string, _options: unknown, callback: (error: Error) => void) => {
      callback(new Error("codec failed"));
    }) as typeof gzip);
    const compression = new ClientResponseCompression(true);
    const get = await serve((request, response) => sendJsonResponse(request, response, { text: "a".repeat(2_000) }, compression));
    const response = await get({ "Accept-Encoding": "gzip" });
    expect(response.status).toBe(500);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(response.body.toString())).toHaveProperty("error.code", "internal_error");
    expect(compression.jsonInputBytes).toBe(0);
  });

  it.each([
    ["started", "success"], ["ended", "success"], ["destroyed", "success"],
    ["started", "failure"], ["ended", "failure"], ["destroyed", "failure"],
  ])("does not change a response %s during codec %s", async (state, outcome) => {
    let completeCodec!: () => void;
    let serverResponse!: Response;
    let completeHandler!: () => void;
    const handlerCompleted = new Promise<void>(resolve => { completeHandler = resolve; });
    vi.mocked(gzip).mockImplementationOnce(((_input: string, _options: unknown, callback: (error: Error | null, result?: Buffer) => void) => {
      completeCodec = () => outcome === "success" ? callback(null, Buffer.from("late codec result")) : callback(new Error("late codec failure"));
    }) as typeof gzip);
    const codecs = new AsyncCodecBudget({ slots: 1 });
    const compression = new ClientResponseCompression(true, codecs);
    const get = await serve(async (request, response) => {
      serverResponse = response;
      try {
        await sendJsonResponse(request, response, { text: "a".repeat(2_000) }, compression);
      } finally {
        completeHandler();
      }
    });
    const result = get({ "Accept-Encoding": "gzip" }).catch(error => error as Error);
    await vi.waitFor(() => expect(completeCodec).toBeTypeOf("function"));
    expect(codecs.activeCount).toBe(1);
    if (state === "destroyed") serverResponse.destroy();
    else {
      serverResponse.status(202).type("text/plain");
      if (state === "started") serverResponse.flushHeaders();
      else serverResponse.end("winner");
    }
    const setHeader = vi.spyOn(serverResponse, "setHeader");
    completeCodec();
    await handlerCompleted;
    expect(setHeader).not.toHaveBeenCalled();
    expect(codecs.activeCount).toBe(0);
    expect(compression.jsonInputBytes).toBe(0);
    if (state === "started") serverResponse.end("winner");
    const response = await result;
    if (state === "destroyed") expect(response).toBeInstanceOf(Error);
    else {
      expect(response).toMatchObject({ status: 202, body: Buffer.from("winner") });
      expect((response as RawResponse).headers["content-encoding"]).toBeUndefined();
    }
  });

  it.each([204, 205, 304])("does not encode no-body status %s", async status => {
    const compression = new ClientResponseCompression(true);
    const get = await serve((request, response) => sendJsonResponse(request, response.status(status), { text: "a".repeat(2_000) }, compression));
    const response = await get({ "Accept-Encoding": "gzip" });
    expect(response.status).toBe(status);
    expect(response.body.length).toBe(0);
    expect(response.headers["content-encoding"]).toBeUndefined();
  });
});
