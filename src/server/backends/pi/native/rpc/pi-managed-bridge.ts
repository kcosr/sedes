import { createServer, type Server, type Socket } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { chmod, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PiRpcCallError, type PiRpcRequestOptions } from "./pi-rpc-client.js";
import { PI_RPC_MAXIMUM_BYTES, piBoundedJson } from "./pi-rpc-wire.js";
import { PI_MANAGED_PROTOCOL_VERSION, parsePiManagedCommand, parsePiManagedResult, piManagedEventSchema, piManagedStateSchema, type PiManagedCommand, type PiManagedEvent, type PiManagedState } from "./pi-managed-protocol.js";

const envelope = z.union([
  z.object({ type: z.literal("hello"), version: z.literal(PI_MANAGED_PROTOCOL_VERSION), token: z.string().max(256) }).strict(),
  z.object({ type: z.literal("ready"), state: piManagedStateSchema }).strict(),
  z.object({ type: z.literal("response"), id: z.string().max(128), success: z.literal(true), data: z.unknown().optional() }).strict(),
  z.object({ type: z.literal("response"), id: z.string().max(128), success: z.literal(false), code: z.string().max(512) }).strict(),
  z.object({ type: z.literal("event"), event: piManagedEventSchema }).strict(),
]);
type Pending = { command: PiManagedCommand; resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void };

/** One owner-only, authenticated control channel for one owned CLI process. */
export class PiManagedBridge {
  readonly socketPath: string;
  readonly bootstrapPath: string;
  readonly #token = randomBytes(32).toString("base64url");
  readonly #authenticationKey: Buffer;
  readonly ready: Promise<PiManagedState>;
  readonly closed: Promise<{ readonly reason: string }>;
  readonly #server: Server;
  readonly #pending = new Map<string, Pending>();
  readonly #retired = new Set<string>();
  readonly #listeners = new Set<(event: PiManagedEvent) => void>();
  readonly #resolveReady: (state: PiManagedState) => void;
  readonly #rejectReady: (error: unknown) => void;
  readonly #resolveClosed: (closure: { reason: string }) => void;
  #socket?: Socket;
  #authenticated = false;
  #ready = false;
  #reason?: string;
  #closing?: Promise<void>;

  private constructor(directory: string, authenticationKey: Uint8Array) {
    this.socketPath = process.platform === "win32" ? `\\\\.\\pipe\\sedes-pi-${randomUUID()}` : path.join(directory, "bridge.sock");
    this.bootstrapPath = path.join(directory, `bootstrap-${randomUUID()}.json`);
    this.#authenticationKey = Buffer.from(authenticationKey);
    let resolveReady!: (state: PiManagedState) => void; let rejectReady!: (error: unknown) => void;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void this.ready.catch(() => undefined);
    this.#resolveReady = resolveReady; this.#rejectReady = rejectReady;
    let resolveClosed!: (closure: { reason: string }) => void;
    this.closed = new Promise((resolve) => { resolveClosed = resolve; }); this.#resolveClosed = resolveClosed;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  static async listen(directory: string, authenticationKey: Uint8Array): Promise<PiManagedBridge> {
    if (authenticationKey.byteLength < 32 || authenticationKey.byteLength > 4096) throw new Error("pi_managed_key_invalid");
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error("pi_managed_directory_insecure");
    const bridge = new PiManagedBridge(directory, authenticationKey);
    if (process.platform !== "win32" && Buffer.byteLength(bridge.socketPath) > 103) throw new Error("pi_managed_socket_path_too_long");
    try {
      await new Promise<void>((resolve, reject) => {
        bridge.#server.once("error", reject);
        bridge.#server.listen(bridge.socketPath, () => { bridge.#server.removeListener("error", reject); resolve(); });
      });
      bridge.#server.on("error", () => { void bridge.close("pi_managed_server_failed").catch(() => undefined); });
      if (process.platform !== "win32") await chmod(bridge.socketPath, 0o600);
      const file = await open(bridge.bootstrapPath, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ version: PI_MANAGED_PROTOCOL_VERSION, socketPath: bridge.socketPath, token: bridge.#token })); }
      finally { await file.close(); }
      return bridge;
    } catch (error) { await bridge.close("pi_managed_bootstrap_failed"); throw error; }
  }

  subscribe(listener: (event: PiManagedEvent) => void): () => void {
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  }

  request(command: PiManagedCommand, options: PiRpcRequestOptions = {}): Promise<unknown> {
    let parsed: PiManagedCommand;
    try { parsed = parsePiManagedCommand(command); }
    catch (cause) { return Promise.reject(new PiRpcCallError("pi_managed_command_invalid", "not_sent", { cause })); }
    if (!this.#ready || !this.#socket || this.#reason) return Promise.reject(new PiRpcCallError("pi_managed_unavailable", "not_sent"));
    if (options.signal?.aborted) return Promise.reject(new PiRpcCallError("pi_managed_aborted", "not_sent"));
    const remaining = options.deadlineAt === null ? null : (options.deadlineAt ?? Date.now() + 30_000) - Date.now();
    if (remaining !== null && (!Number.isFinite(remaining) || remaining <= 0)) return Promise.reject(new PiRpcCallError("pi_managed_expired", "not_sent"));
    if (this.#pending.size >= 128) return Promise.reject(new PiRpcCallError("pi_managed_pending_limit", "not_sent"));
    const id = randomUUID(); const frame = JSON.stringify({ type: "request", id, command: parsed }) + "\n";
    if (Buffer.byteLength(frame) > PI_RPC_MAXIMUM_BYTES || this.#socket.writableLength + Buffer.byteLength(frame) > PI_RPC_MAXIMUM_BYTES) return Promise.reject(new PiRpcCallError("pi_managed_outbound_limit", "not_sent"));
    return new Promise((resolve, reject) => {
      const retire = () => { this.#retired.add(id); if (this.#retired.size > 1024) this.#retired.delete(this.#retired.values().next().value!); };
      const fail = () => { if (!this.#pending.delete(id)) return; cleanup(); retire(); reject(new PiRpcCallError("pi_managed_wait_ended", "sent_outcome_unknown")); };
      const timer = remaining === null ? undefined : setTimeout(fail, Math.min(remaining, 2_147_483_647));
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", fail); };
      this.#pending.set(id, { command: parsed, resolve, reject, cleanup });
      options.signal?.addEventListener("abort", fail, { once: true });
      this.#socket!.write(frame, (error) => { if (error) void this.close("pi_managed_write_failed").catch(() => undefined); });
    });
  }

  close(reason = "pi_managed_closed"): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#reason = reason;
    this.#rejectReady(new Error(reason));
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(new PiRpcCallError(reason, "sent_outcome_unknown")); }
    this.#pending.clear(); this.#socket?.destroy(); this.#authenticationKey.fill(0);
    this.#closing = (async () => {
      const results = await Promise.allSettled([
        new Promise<void>(resolve => this.#server.close(() => { this.#resolveClosed({ reason }); resolve(); })),
        unlink(this.bootstrapPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }),
      ]);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return this.#closing;
  }

  #accept(socket: Socket): void {
    if (this.#socket || this.#reason) { socket.destroy(); return; }
    this.#socket = socket;
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => { void this.close("pi_managed_handshake_timeout").catch(() => undefined); }, 5_000);
    socket.on("data", (chunk: Buffer) => {
      try {
        if (buffered.length + chunk.length > PI_RPC_MAXIMUM_BYTES) throw new Error("pi_managed_frame_limit");
        buffered = Buffer.concat([buffered, chunk]);
        let index: number;
        while ((index = buffered.indexOf(10)) >= 0) {
          const frame = buffered.subarray(0, index); buffered = buffered.subarray(index + 1);
          const decoded = envelope.parse(piBoundedJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame))));
          if (!this.#authenticated) {
            if (decoded.type !== "hello") throw new Error("pi_managed_hello_missing");
            const expected = Buffer.from(this.#token); const received = Buffer.from(decoded.token);
            if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("pi_managed_authentication_failed");
            // The capability file must be gone before the evidence key leaves
            // the host. The companion consumes it before installing any tools.
            try { lstatSync(this.bootstrapPath); throw new Error("pi_managed_bootstrap_not_consumed"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            clearTimeout(timer); this.#authenticated = true;
            socket.write(JSON.stringify({ type: "initialize", version: PI_MANAGED_PROTOCOL_VERSION,
              authenticationKey: this.#authenticationKey.toString("base64url") }) + "\n");
            continue;
          }
          if (decoded.type === "hello") throw new Error("pi_managed_duplicate_hello");
          if (decoded.type === "ready") {
            if (this.#ready) throw new Error("pi_managed_duplicate_ready");
            this.#ready = true; this.#resolveReady(decoded.state); continue;
          }
          if (!this.#ready) throw new Error("pi_managed_not_ready");
          if (decoded.type === "event") { for (const listener of [...this.#listeners]) listener(decoded.event); continue; }
          const pending = this.#pending.get(decoded.id);
          if (!pending) { if (this.#retired.has(decoded.id)) continue; throw new Error("pi_managed_response_unknown"); }
          const value = decoded.success ? parsePiManagedResult(pending.command, decoded.data) : undefined;
          this.#pending.delete(decoded.id); pending.cleanup();
          this.#retired.add(decoded.id); if (this.#retired.size > 1024) this.#retired.delete(this.#retired.values().next().value!);
          if (decoded.success) pending.resolve(value);
          else pending.reject(new PiRpcCallError(decoded.code, "rejected"));
        }
      } catch { void this.close("pi_managed_protocol_failed").catch(() => undefined); }
    });
    socket.on("error", () => { void this.close("pi_managed_socket_failed").catch(() => undefined); });
    socket.on("close", () => { clearTimeout(timer); void this.close("pi_managed_socket_closed").catch(() => undefined); });
  }
}
