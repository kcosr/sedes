import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createWebSocketByteStream } from "../../src/internal/websocket-byte-stream.js";
import { OUTBOUND_RUNTIME_CHUNK_BYTES, OUTBOUND_RUNTIME_MAX_BUFFER_BYTES } from "../../src/internal/outbound-protocol.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  paused = false;
  writes: Buffer[] = [];
  failWrite = false;
  send(data: Buffer, _options: unknown, callback: (error?: Error) => void) { this.writes.push(Buffer.from(data)); queueMicrotask(() => callback(this.failWrite ? new Error("lost") : undefined)); }
  terminate() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  close() { this.terminate(); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  get ws(): WebSocket { return this as unknown as WebSocket; }
}

describe("outbound bounded WebSocket byte stream", () => {
  it("chunks a legal large file frame independently of message limits", async () => {
    const socket = new Socket();
    const stream = createWebSocketByteStream(socket.ws);
    const bytes = Buffer.alloc(6 * 1024 * 1024 + 7, "a");
    await stream.write(bytes);
    expect(socket.writes.every(chunk => chunk.length <= OUTBOUND_RUNTIME_CHUNK_BYTES)).toBe(true);
    expect(Buffer.concat(socket.writes).equals(bytes)).toBe(true);
    await stream.close("done");
  });
  it("uses flow control before the bounded receive queue fills", async () => {
    const socket = new Socket();
    const stream = createWebSocketByteStream(socket.ws);
    const count = OUTBOUND_RUNTIME_MAX_BUFFER_BYTES / OUTBOUND_RUNTIME_CHUNK_BYTES / 2;
    for (let i = 0; i < count; i++) socket.emit("message", Buffer.alloc(OUTBOUND_RUNTIME_CHUNK_BYTES, i), true);
    expect(socket.paused).toBe(true);
    const iterator = stream.bytes[Symbol.asyncIterator]();
    for (let i = 0; i < count; i++) expect((await iterator.next()).value?.[0]).toBe(i);
    expect(socket.paused).toBe(false);
    await stream.close("done");
    expect((await iterator.next()).done).toBe(true);
  });
  it("rejects text and overlarge binary messages", async () => {
    for (const [bytes, binary] of [[Buffer.from("text"), false], [Buffer.alloc(OUTBOUND_RUNTIME_CHUNK_BYTES + 1), true]] as const) {
      const socket = new Socket();
      const stream = createWebSocketByteStream(socket.ws);
      socket.emit("message", bytes, binary);
      await expect(stream.closed).resolves.toMatchObject({ reason: "outbound_runtime_receive_limit" });
    }
  });
  it("closes a peer that ignores receive backpressure", async () => {
    const socket = new Socket();
    const stream = createWebSocketByteStream(socket.ws);
    for (let i = 0; i <= OUTBOUND_RUNTIME_MAX_BUFFER_BYTES / OUTBOUND_RUNTIME_CHUNK_BYTES; i++) socket.emit("message", Buffer.alloc(OUTBOUND_RUNTIME_CHUNK_BYTES), true);
    await expect(stream.closed).resolves.toMatchObject({ reason: "outbound_runtime_receive_limit" });
  });
  it("labels failed attempted writes unknown and closes the partial byte stream", async () => {
    const socket = new Socket();
    const stream = createWebSocketByteStream(socket.ws);
    socket.failWrite = true;
    await expect(stream.write(Buffer.alloc(100))).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    await expect(stream.closed).resolves.toMatchObject({ reason: "outbound_runtime_partial_write" });
    await expect(stream.write(Buffer.alloc(100))).rejects.toMatchObject({ delivery: "not_sent" });
  });
  it("does not send an already aborted write", async () => {
    const socket = new Socket();
    const stream = createWebSocketByteStream(socket.ws);
    await expect(stream.write(Buffer.alloc(100), { signal: AbortSignal.abort() })).rejects.toMatchObject({ delivery: "not_sent" });
    expect(socket.writes).toHaveLength(0);
    await stream.close("done");
  });
});
