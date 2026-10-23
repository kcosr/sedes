import { EventEmitter } from "node:events";
import type { TransformOptions } from "node:stream";
import { createGzip, constants, type Gzip, type ZlibOptions } from "node:zlib";
import type { Request, Response } from "express";
import type { AsyncCodecLease } from "../../internal/compression/async-codec-budget.js";
import { MAXIMUM_SSE_EVENT_BYTES } from "../../shared/protocol/payload.js";
import { ClientResponseCompression, negotiateResponseEncoding, responseCompressionBusy } from "../http/response-compression.js";

/** Owns one HTTP representation; the native stream supplies input backpressure and flushes. */
export class SseResponseWriter extends EventEmitter {
  readonly #response: Response;
  readonly #codec?: Gzip;
  readonly #lease?: AsyncCodecLease;
  #ending = false;
  #closed = false;
  #started = false;

  constructor(request: Request, response: Response, compression: ClientResponseCompression) {
    super();
    this.#response = response;
    if (response.destroyed || response.writableEnded) {
      this.#closed = true;
      return;
    }
    const selected = negotiateResponseEncoding(request, compression.enabled);
    if (selected.encoding === "gzip") {
      this.#lease = compression.trySse();
      if (!this.#lease && !selected.identityAllowed) throw responseCompressionBusy();
      if (this.#lease) {
        try {
          const options: ZlibOptions & Pick<TransformOptions, "writableHighWaterMark" | "readableHighWaterMark"> = {
            level: 1,
            flush: constants.Z_SYNC_FLUSH,
            writableHighWaterMark: 64 * 1_024,
            readableHighWaterMark: 16 * 1_024,
            chunkSize: 16 * 1_024,
          };
          this.#codec = createGzip(options);
        } catch (error) {
          this.#lease.release();
          throw error;
        }
        // Keep the error handler for the codec's entire lifetime, including late native completion.
        this.#codec.on("error", () => this.destroy());
        this.#codec.pipe(response);
      }
    }
    response.once("close", this.#terminal);
    response.once("finish", this.#terminal);
    response.on("error", this.#responseError);
  }

  get writableEnded(): boolean { return this.#ending || this.#closed; }
  get destroyed(): boolean { return this.#closed || this.#response.destroyed; }
  get writableLength(): number { return this.#codec?.writableLength ?? this.#response.writableLength; }
  get writableHighWaterMark(): number { return this.#codec?.writableHighWaterMark ?? this.#response.writableHighWaterMark; }

  start(): void {
    if (this.#started || this.writableEnded) return;
    this.#started = true;
    this.#response.status(200);
    this.#response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    this.#response.setHeader("Cache-Control", "no-cache, no-transform");
    this.#response.setHeader("Connection", "keep-alive");
    this.#response.setHeader("X-Accel-Buffering", "no");
    this.#response.vary("Accept-Encoding");
    if (this.#codec) this.#response.setHeader("Content-Encoding", "gzip");
    this.#response.flushHeaders();
  }

  write(frame: string): boolean {
    if (this.writableEnded || this.#response.destroyed || this.#response.writableEnded) return false;
    if (Buffer.byteLength(frame, "utf8") > MAXIMUM_SSE_EVENT_BYTES) throw new Error("sse_event_frame_byte_limit_exceeded");
    this.start();
    return this.#codec ? this.#codec.write(frame, "utf8") : this.#response.write(frame);
  }

  onceDrain(listener: () => void): void {
    if (!this.writableEnded) (this.#codec ?? this.#response).once("drain", listener);
  }

  removeDrainListener(listener: () => void): void {
    (this.#codec ?? this.#response).removeListener("drain", listener);
  }

  end(): void {
    if (this.writableEnded) return;
    this.start();
    this.#ending = true;
    if (this.#codec) this.#codec.end();
    else this.#response.end();
  }

  destroy(): void {
    if (this.#closed) return;
    this.#terminal();
    this.#response.destroy();
  }

  readonly #responseError = (): void => this.destroy();
  readonly #terminal = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.#lease?.release();
    this.#codec?.destroy();
    this.#response.removeListener("close", this.#terminal);
    this.#response.removeListener("finish", this.#terminal);
    // A real response can emit an error after close too; this handler remains harmless.
    this.emit("close");
  };
}
