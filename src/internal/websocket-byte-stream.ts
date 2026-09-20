import { WebSocket, type RawData } from "ws";
import { SidecarFrameWriteError, type SidecarByteStream, type SidecarByteStreamClosure } from "./sidecar-protocol/contracts.js";
import { OUTBOUND_RUNTIME_CHUNK_BYTES, OUTBOUND_RUNTIME_MAX_BUFFER_BYTES } from "./outbound-protocol.js";
import { DEFAULT_SIDECAR_PROTOCOL_LIMITS } from "./sidecar-protocol/limits.js";

/** A bounded ordered byte carrier. Message boundaries have no runtime meaning. */
export function createWebSocketByteStream(socket: WebSocket): SidecarByteStream {
  const queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let ended = false;
  let wake: (() => void) | undefined;
  let resolveClosed!: (closure: SidecarByteStreamClosure) => void;
  const closed = new Promise<SidecarByteStreamClosure>((resolve) => { resolveClosed = resolve; });
  let writes = Promise.resolve();
  let queuedWrites = 0;
  let queuedWriteCount = 0;
  let consumer = false;
  let requestedReason = "outbound_runtime_closed";
  const finish = (reason: string, cause?: Error) => {
    if (ended) return;
    ended = true;
    resolveClosed({ reason, ...(cause ? { cause } : {}) });
    wake?.();
  };
  const terminate = (reason: string) => {
    requestedReason = reason;
    socket.terminate();
    finish(reason);
  };
  socket.on("message", (raw: RawData, binary: boolean) => {
    if (ended) return;
    const bytes = rawBytes(raw);
    if (!binary || bytes.length > OUTBOUND_RUNTIME_CHUNK_BYTES || queuedBytes + bytes.length > OUTBOUND_RUNTIME_MAX_BUFFER_BYTES) {
      terminate("outbound_runtime_receive_limit");
      return;
    }
    if (bytes.length === 0) return;
    queue.push(bytes);
    queuedBytes += bytes.length;
    if (queuedBytes >= OUTBOUND_RUNTIME_MAX_BUFFER_BYTES / 2) socket.pause();
    wake?.();
  });
  socket.once("close", () => finish(requestedReason));
  socket.once("error", (cause) => {
    finish("outbound_runtime_error", cause);
    socket.terminate();
  });
  return {
    closed,
    bytes: {
      async *[Symbol.asyncIterator]() {
        if (consumer) throw new Error("outbound_runtime_consumer_already_attached");
        consumer = true;
        try {
          while (true) {
            const chunk = queue.shift();
            if (chunk) {
              queuedBytes -= chunk.length;
              if (queuedBytes < OUTBOUND_RUNTIME_MAX_BUFFER_BYTES / 4 && !ended) socket.resume();
              yield chunk;
            } else if (ended) return;
            else await new Promise<void>((resolve) => { wake = resolve; });
          }
        } finally {
          wake = undefined;
          queue.length = 0;
          queuedBytes = 0;
        }
      },
    },
    write(bytes, options) {
      if (ended || socket.readyState !== WebSocket.OPEN || options?.signal?.aborted) {
        return Promise.reject(new SidecarFrameWriteError("outbound_runtime_unavailable", "not_sent"));
      }
      // The frame transport may write one complete legal JSON-expanded file
      // frame. Bound that retained frame separately from WebSocket chunks.
      if (queuedWriteCount >= 32 || bytes.length > DEFAULT_SIDECAR_PROTOCOL_LIMITS.maximumFrameBytes + 8 || queuedWrites + bytes.length > DEFAULT_SIDECAR_PROTOCOL_LIMITS.maximumFrameBytes + 8 + OUTBOUND_RUNTIME_MAX_BUFFER_BYTES) {
        return Promise.reject(new SidecarFrameWriteError("outbound_runtime_write_limit", "not_sent"));
      }
      // Snapshot callers' memory before waiting behind another writer.
      const owned = Buffer.from(bytes);
      queuedWrites += owned.length;
      queuedWriteCount += 1;
      const write = writes.then(async () => {
        let attempted = false;
        try {
          for (let offset = 0; offset < owned.length; offset += OUTBOUND_RUNTIME_CHUNK_BYTES) {
            if (ended || socket.readyState !== WebSocket.OPEN || options?.signal?.aborted) throw new Error("outbound_runtime_unavailable");
            if (socket.bufferedAmount > OUTBOUND_RUNTIME_MAX_BUFFER_BYTES) throw new Error("outbound_runtime_write_limit");
            const chunk = owned.subarray(offset, offset + OUTBOUND_RUNTIME_CHUNK_BYTES);
            attempted = true;
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                terminate("outbound_runtime_write_timeout");
                reject(new Error("outbound_runtime_write_timeout"));
              }, 30_000);
              timer.unref();
              socket.send(chunk, { binary: true, compress: false }, (error) => {
                clearTimeout(timer);
                if (error) reject(error); else resolve();
              });
            });
          }
        } catch (cause) {
          // A partial byte write cannot be recovered by replaying a whole frame.
          if (attempted) terminate("outbound_runtime_partial_write");
          throw new SidecarFrameWriteError("outbound_runtime_write_failed", attempted ? "sent_outcome_unknown" : "not_sent", { cause });
        } finally { queuedWrites -= owned.length; queuedWriteCount -= 1; }
      });
      writes = write.catch(() => {});
      return write;
    },
    async close(reason) {
      if (ended) return;
      requestedReason = reason;
      socket.close(1000, reason.replace(/[^\x20-\x7e]/gu, "_").slice(0, 100));
      const timer = setTimeout(() => terminate(reason), 250);
      timer.unref();
      await closed;
      clearTimeout(timer);
    },
  };
}

export function rawBytes(raw: RawData): Buffer {
  return Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
}
