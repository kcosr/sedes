import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { Request, Response } from "express";
import { asyncCodecBudget, type AsyncCodecBudget, type AsyncCodecLease } from "../../internal/compression/async-codec-budget.js";
import { ApiError } from "./errors.js";

const gzipAsync = promisify(gzip);
const MINIMUM_JSON_COMPRESSION_BYTES = 1_024;
const MAXIMUM_JSON_COMPRESSION_INPUT_BYTES = 64 * 1_024 * 1_024;
const MAXIMUM_COMPRESSED_SSE_STREAMS = 64;

export interface ResponseEncoding {
  readonly encoding: "gzip" | "identity";
  readonly identityAllowed: boolean;
}

export type JsonResponseSender = (request: Request, response: Response, value: unknown) => Promise<void>;

/** Only origin-supported HTTP content codings participate in selection. */
export function negotiateResponseEncoding(request: Request, enabled: boolean): ResponseEncoding {
  const header = request.header("Accept-Encoding");
  if (!header?.trim()) return { encoding: "identity", identityAllowed: true };
  const qualities = new Map<string, number>();
  for (const part of header.split(",")) {
    if (!part.trim()) continue;
    const [rawCoding, ...parameters] = part.trim().split(";");
    const coding = rawCoding!.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(coding) || parameters.length > 1) {
      throw new ApiError(400, "bad_request", "The Accept-Encoding header is invalid.");
    }
    const parameter = parameters[0]?.trim();
    const quality = parameter === undefined ? 1 :
      /^q\s*=\s*(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/iu.test(parameter)
        ? Number(parameter.slice(parameter.indexOf("=") + 1).trim()) : undefined;
    if (quality === undefined) throw new ApiError(400, "bad_request", "The Accept-Encoding header is invalid.");
    // Conflicting duplicates cannot override an explicit exclusion.
    qualities.set(coding, Math.min(qualities.get(coding) ?? 1, quality));
  }
  const gzipQuality = qualities.get("gzip") ?? qualities.get("*") ?? 0;
  const identityQuality = qualities.get("identity");
  const identityAllowed = identityQuality === undefined ? qualities.get("*") !== 0 : identityQuality > 0;
  if (enabled && gzipQuality > 0 &&
      (!identityAllowed || identityQuality === undefined || gzipQuality >= identityQuality)) {
    return { encoding: "gzip", identityAllowed };
  }
  if (identityAllowed) return { encoding: "identity", identityAllowed };
  throw new ApiError(406, "bad_request", "No acceptable response content encoding is available.");
}

/** Installation-scoped buffers/streams; finite native jobs also share the process budget. */
export class ClientResponseCompression {
  #jsonInputBytes = 0;
  #sseStreams = 0;

  constructor(
    readonly enabled: boolean,
    readonly codecs: AsyncCodecBudget = asyncCodecBudget,
  ) {}

  get jsonInputBytes(): number { return this.#jsonInputBytes; }
  get sseStreams(): number { return this.#sseStreams; }

  tryJson(inputBytes: number): AsyncCodecLease | undefined {
    if (this.#jsonInputBytes + inputBytes > MAXIMUM_JSON_COMPRESSION_INPUT_BYTES) return undefined;
    const codec = this.codecs.tryAcquire();
    if (!codec) return undefined;
    this.#jsonInputBytes += inputBytes;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.#jsonInputBytes -= inputBytes;
      codec.release();
    } };
  }

  trySse(): AsyncCodecLease | undefined {
    if (this.#sseStreams >= MAXIMUM_COMPRESSED_SSE_STREAMS) return undefined;
    this.#sseStreams += 1;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.#sseStreams -= 1;
    } };
  }
}

export function responseCompressionBusy(): ApiError {
  return new ApiError(503, "runtime_unavailable", "Response compression is busy. Retry the request.", true);
}

function responseUnavailable(response: Response): boolean {
  return response.destroyed || response.writableEnded || response.headersSent;
}

/** Explicit read-route sender. Mutations, downloads, credentials and ordinary error handlers never use it. */
export async function sendJsonResponse(
  request: Request,
  response: Response,
  value: unknown,
  compression: ClientResponseCompression,
): Promise<void> {
  if (responseUnavailable(response)) return;
  if (response.statusCode === 204 || response.statusCode === 205 || response.statusCode === 304 ||
      response.statusCode === 206 || request.header("Range") !== undefined ||
      response.hasHeader("Content-Encoding") || response.hasHeader("Content-Range") ||
      response.hasHeader("Content-Disposition")) {
    response.json(value);
    return;
  }
  const selected = negotiateResponseEncoding(request, compression.enabled);
  const app = response.app;
  let json = JSON.stringify(value, app.get("json replacer"), app.get("json spaces"));
  if (json === undefined) throw new Error("json_response_value_required");
  if (app.get("json escape")) {
    json = json.replace(/[<>&]/gu, character =>
      character === "<" ? "\\u003c" : character === ">" ? "\\u003e" : "\\u0026");
  }
  let body: string | Buffer = json;
  let encoding: "gzip" | "identity" = "identity";
  const inputBytes = Buffer.byteLength(json, "utf8");
  if (selected.encoding === "gzip" &&
      (inputBytes >= MINIMUM_JSON_COMPRESSION_BYTES || !selected.identityAllowed)) {
    const lease = compression.tryJson(inputBytes);
    if (!lease && !selected.identityAllowed) throw responseCompressionBusy();
    if (lease) {
      try {
        const compressed = await gzipAsync(json, {
          level: 1,
          maxOutputLength: inputBytes * 2 + 65_536,
        });
        if (responseUnavailable(response)) return;
        if (compressed.byteLength < inputBytes || !selected.identityAllowed) {
          body = compressed;
          encoding = "gzip";
        }
      } catch (error) {
        if (responseUnavailable(response)) return;
        if (!selected.identityAllowed) throw error;
      } finally {
        lease.release();
      }
    }
  }
  if (responseUnavailable(response)) return;
  response.type("application/json");
  response.vary("Accept-Encoding");
  response.removeHeader("Content-Length");
  // A caller's validator cannot describe newly selected representation bytes.
  response.removeHeader("ETag");
  if (encoding === "gzip") response.setHeader("Content-Encoding", "gzip");
  response.send(body);
}
