import type { z } from "zod";
import type { SidecarOperationRegistry, SidecarOperationDefinition } from "../../internal/sidecar-protocol/operation-registry.js";
import type { SidecarProtocolPeer } from "../../internal/sidecar-protocol/protocol-peer.js";
import { SidecarRuntimeBodyChannel, type SidecarRuntimeBody } from "./runtime-body-channel.js";

/** Authenticated attachment channel. It knows framing and bounded body
 * transfer, never provider methods, native identities, or runtime semantics. */
export class SidecarRuntimeChannel {
  readonly #bodies: SidecarRuntimeBodyChannel;
  constructor(readonly peer: SidecarProtocolPeer, registry: SidecarOperationRegistry) {
    this.#bodies = new SidecarRuntimeBodyChannel(peer, registry);
  }
  supportsOperation(definition: { readonly capabilityId: string; readonly majorVersion: number; readonly operation: string }): boolean {
    return this.peer.supportsOperation(definition);
  }
  assertReady(): void { this.peer.assertReady(); }
  call<Request, Response>(definition: SidecarOperationDefinition<Request, Response>, request: Request,
    options?: Parameters<SidecarProtocolPeer["call"]>[2]): Promise<Response> {
    return this.peer.call(definition, request, options);
  }
  onEvent<Payload>(input: { readonly capabilityId: string; readonly majorVersion: number; readonly event: string; readonly schema: z.ZodType<Payload>; readonly listener: (payload: Payload) => void }): () => void {
    return this.peer.onEvent(input);
  }
  encodeBody(value: unknown): Promise<SidecarRuntimeBody> { return this.#bodies.encode(value); }
  decodeBody(body: SidecarRuntimeBody): Promise<unknown> { return this.#bodies.decode(body); }
  close(): void { this.#bodies.close(); }
}

export interface SidecarRuntimeLease {
  readonly channel: SidecarRuntimeChannel;
  readonly controllerEpoch: number;
  readonly serviceIncarnation: string;
  readonly closed: Promise<unknown>;
  release(): void;
}
export interface SidecarRuntimeProvider {
  acquire(signal?: AbortSignal, options?: { readonly existingOnly?: boolean }): Promise<SidecarRuntimeLease>;
}

/** Only a configuration mismatch permits the narrower retained-work attachment. */
export function isSidecarRevisionChanged(error: unknown): boolean {
  for (let depth = 0; error instanceof Error && depth < 8; depth++, error = error.cause) {
    if (error.message === "sidecar_revision_changed") return true;
  }
  return false;
}
