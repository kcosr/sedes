import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Vite's content-hashed build output: `assets/<name>-<8-character hash>.<ext>`. */
const HASHED_ASSET = /^\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/u;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
// index.html and unhashed public files change in place between builds.
const REVALIDATE_CACHE_CONTROL = "no-cache";

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css", ".html", ".js", ".json", ".map", ".mjs", ".svg", ".txt", ".wasm", ".webmanifest", ".xml",
]);
const MINIMUM_COMPRESSED_FILE_BYTES = 1_024;
// The built client is about 11 MiB raw and 3 MiB compressed per encoding.
const MAXIMUM_CACHED_COMPRESSED_BYTES = 32 * 1_024 * 1_024;

type Encoding = "br" | "gzip";

type CompressedAsset = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly body: Buffer;
};

export function clientAssetCacheControl(requestPath: string): string {
  return HASHED_ASSET.test(requestPath) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}

function compressible(filePath: string): boolean {
  return COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * The client file a static request names, or undefined when the request is
 * not an ordinary file path: undecodable, a dot segment or dotfile, a
 * backslash or NUL, or outside the client root. Those requests fall through
 * to `express.static`, which applies its own rules.
 */
function clientFilePath(root: string, requestPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const segments = decoded.slice(1).split("/");
  if (segments.at(-1) === "") segments[segments.length - 1] = "index.html";
  if (segments.some((segment) => segment === "" || segment.startsWith("."))) return undefined;
  const filePath = path.join(root, ...segments);
  return filePath.startsWith(`${root}${path.sep}`) ? filePath : undefined;
}

/**
 * Serves the built client. Compressible files are sent with Brotli or gzip
 * when the browser accepts it, compressed once per file version and kept in a
 * bounded in-process cache; SSE and API responses are never compressed.
 * Content-hashed assets are immutable for a year; every other file, including
 * index.html, is revalidated on each use.
 */
export function clientAssets(clientDirectory: string): RequestHandler {
  const root = path.resolve(clientDirectory);
  const compressed = new Map<string, CompressedAsset>();
  const pending = new Map<string, Promise<CompressedAsset>>();
  let cachedBytes = 0;

  const serveStatic = express.static(root, {
    cacheControl: false,
    setHeaders: (response, filePath) => {
      const relative = path.relative(root, filePath).split(path.sep).join("/");
      response.setHeader("Cache-Control", clientAssetCacheControl(`/${relative}`));
      if (compressible(filePath)) response.vary("Accept-Encoding");
    },
  });

  const compress = async (filePath: string, encoding: Encoding, size: number, mtimeMs: number): Promise<CompressedAsset> => {
    const key = `${encoding}\0${filePath}`;
    const cached = compressed.get(key);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached;
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const work = (async () => {
      const source = await readFile(filePath);
      const body = encoding === "br"
        ? await brotliCompressAsync(source, {
          params: {
            // Quality 9 is within a few percent of 11 at a small fraction of its CPU.
            [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.length,
          },
        })
        : await gzipAsync(source, { level: 9 });
      // A file replaced after its stat has a new mtime, so its next request compresses it again.
      const asset = { size, mtimeMs, body };
      const previous = compressed.get(key);
      if (previous) cachedBytes -= previous.body.length;
      compressed.delete(key);
      if (body.length <= MAXIMUM_CACHED_COMPRESSED_BYTES) {
        compressed.set(key, asset);
        cachedBytes += body.length;
        for (const [oldestKey, oldest] of compressed) {
          if (cachedBytes <= MAXIMUM_CACHED_COMPRESSED_BYTES) break;
          compressed.delete(oldestKey);
          cachedBytes -= oldest.body.length;
        }
      }
      return asset;
    })();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  };

  const serveCompressed = async (request: Request, response: Response): Promise<boolean> => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    if (request.headers.range !== undefined) return false;
    const filePath = clientFilePath(root, request.path);
    if (!filePath || !compressible(filePath)) return false;
    // Prefer Brotli whenever it is acceptable at all; browsers list gzip first.
    const encoding: Encoding | undefined = request.acceptsEncodings("br") === "br"
      ? "br"
      : request.acceptsEncodings("gzip") === "gzip" ? "gzip" : undefined;
    if (!encoding) return false;
    const file = await stat(filePath).catch(() => undefined);
    if (!file?.isFile() || file.size < MINIMUM_COMPRESSED_FILE_BYTES) return false;
    const asset = await compress(filePath, encoding, file.size, file.mtimeMs);
    response.status(200);
    response.type(path.extname(filePath));
    response.setHeader("Cache-Control", clientAssetCacheControl(request.path.endsWith("/") ? `${request.path}index.html` : request.path));
    response.setHeader("Content-Encoding", encoding);
    response.vary("Accept-Encoding");
    response.setHeader("ETag", `W/"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}-${encoding}"`);
    response.setHeader("Last-Modified", file.mtime.toUTCString());
    if (request.fresh) {
      response.status(304).end();
      return true;
    }
    response.setHeader("Content-Length", String(asset.body.length));
    if (request.method === "HEAD") response.end();
    else response.end(asset.body);
    return true;
  };

  return (request: Request, response: Response, next: NextFunction) => {
    serveCompressed(request, response)
      .catch(() => {
        // Failures happen before any encoded header is written; serve the file as is.
        response.removeHeader("Content-Encoding");
        return false;
      })
      .then((served) => { if (!served) serveStatic(request, response, next); })
      .catch(next);
  };
}
