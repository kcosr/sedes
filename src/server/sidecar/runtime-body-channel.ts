import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { SidecarOperationRegistry, type SidecarOperationDefinition } from "../../internal/sidecar-protocol/operation-registry.js";
import type { SidecarProtocolPeer } from "../../internal/sidecar-protocol/protocol-peer.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../provider-protocol/transport/framed-message-limits.js";

export const SIDECAR_RUNTIME_BODY_CAPABILITY = "runtime_bodies";
const INLINE_BYTES = 64 * 1024;
const CREDIT_BYTES = 1024 * 1024;
// One legal native frame plus the bounded private envelope around it.
const MAXIMUM_BODY_BYTES = MAXIMUM_PROVIDER_FRAME_BYTES + 1024 * 1024;
const MAXIMUM_RESERVED_BYTES = MAXIMUM_BODY_BYTES * 4;
const transferSchema = z.strictObject({ id: z.string().uuid(), size: z.number().int().min(1).max(MAXIMUM_BODY_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
export const sidecarRuntimeBodySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("inline"), value: z.unknown() }).superRefine((value, context) => {
    if (Buffer.byteLength(JSON.stringify(value.value), "utf8") > INLINE_BYTES) context.addIssue({ code: "custom", message: "sidecar_runtime_inline_body_too_large" });
  }),
  z.strictObject({ type: z.literal("stream"), id: z.string().uuid() }),
]);
export type SidecarRuntimeBody = z.infer<typeof sidecarRuntimeBodySchema>;
const terminalSchema = z.strictObject({ size: z.number().int().min(1).max(MAXIMUM_BODY_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
export const sidecarRuntimeBodyOffer: SidecarOperationDefinition<z.infer<typeof transferSchema>, { readonly accepted: true }> = {
  capabilityId: SIDECAR_RUNTIME_BODY_CAPABILITY, majorVersion: 1, operation: "body.offer",
  requestSchema: transferSchema, responseSchema: z.strictObject({ accepted: z.literal(true) }),
  lane: "control", maximumDeadlineMilliseconds: 30_000,
};
type Incoming = { size: number; value: Promise<unknown>; reject(error: Error): void; unregister(): void; timer: ReturnType<typeof setTimeout> };

/** Ephemeral, credit-controlled body transfer shared by both ends of the
 * runtime transport capability. No provider stream is blocked by a subscriber:
 * its caller must detach slow consumers when its bounded event queue fills. */
export class SidecarRuntimeBodyChannel {
  readonly #peer: SidecarProtocolPeer;
  readonly #incoming = new Map<string, Incoming>();
  #reservedBytes = 0;
  #closed = false;

  constructor(peer: SidecarProtocolPeer, registry: SidecarOperationRegistry) {
    this.#peer = peer;
    registry.register(sidecarRuntimeBodyOffer, input => {
      if (this.#closed || this.#incoming.has(input.id) || this.#incoming.size >= 16 || this.#reservedBytes + input.size > MAXIMUM_RESERVED_BYTES) throw new Error("sidecar_runtime_body_capacity_exceeded");
      const chunks: Buffer[] = [];
      let bytes = 0;
      const hash = createHash("sha256");
      let resolve!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const value = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
      void value.catch(() => undefined);
      const stream = peer.registerIncomingStream({
        capabilityId: SIDECAR_RUNTIME_BODY_CAPABILITY, majorVersion: 1,
        streamId: input.id, initialCreditBytes: CREDIT_BYTES, terminalSchema,
        onData: record => {
          bytes += record.bytes.byteLength;
          if (bytes > input.size || record.channel !== "stdout") throw new Error("sidecar_runtime_body_size_invalid");
          const chunk = Buffer.from(record.bytes);
          chunks.push(chunk); hash.update(chunk);
          void stream.addCredit(chunk.byteLength).catch(error => reject(error instanceof Error ? error : new Error("sidecar_runtime_body_credit_failed")));
        },
        onTerminal: terminal => {
          if (terminal.size !== input.size || bytes !== input.size || terminal.sha256 !== input.sha256 || hash.digest("hex") !== input.sha256) {
            reject(new Error("sidecar_runtime_body_digest_invalid"));
            return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))); }
          catch { reject(new Error("sidecar_runtime_body_json_invalid")); }
        },
      });
      const timer = setTimeout(() => this.#release(input.id, new Error("sidecar_runtime_body_expired")), 60_000);
      timer.unref();
      this.#incoming.set(input.id, { size: input.size, value, reject, unregister: stream.unregister, timer });
      this.#reservedBytes += input.size;
      return { accepted: true as const };
    });
  }

  async encode(value: unknown): Promise<SidecarRuntimeBody> {
    if (this.#closed) throw new Error("sidecar_runtime_body_channel_closed");
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("sidecar_runtime_body_json_invalid");
    const bytes = Buffer.from(serialized, "utf8");
    if (bytes.byteLength <= INLINE_BYTES) return { type: "inline", value };
    if (bytes.byteLength > MAXIMUM_BODY_BYTES) throw new Error("sidecar_runtime_body_too_large");
    const id = randomUUID();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await this.#peer.call(sidecarRuntimeBodyOffer, { id, size: bytes.byteLength, sha256 }, { deadlineMilliseconds: 30_000 });
    const stream = this.#peer.openOutgoingStream({ capabilityId: SIDECAR_RUNTIME_BODY_CAPABILITY, majorVersion: 1, streamId: id, initialCreditBytes: CREDIT_BYTES });
    for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) await stream.send("stdout", bytes.subarray(offset, offset + 64 * 1024));
    await stream.terminal({ size: bytes.byteLength, sha256 }, terminalSchema);
    return { type: "stream", id };
  }

  async decode(body: SidecarRuntimeBody): Promise<unknown> {
    if (body.type === "inline") return body.value;
    const incoming = this.#incoming.get(body.id);
    if (!incoming) throw new Error("sidecar_runtime_body_unknown");
    try { return await incoming.value; }
    finally { this.#release(body.id); }
  }
  close(): void {
    this.#closed = true;
    for (const id of this.#incoming.keys()) this.#release(id, new Error("sidecar_runtime_body_channel_closed"));
  }
  #release(id: string, error?: Error): void {
    const incoming = this.#incoming.get(id);
    if (!incoming) return;
    this.#incoming.delete(id);
    this.#reservedBytes -= incoming.size;
    clearTimeout(incoming.timer);
    if (error) incoming.reject(error);
    incoming.unregister();
  }
}
