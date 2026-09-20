import type { SidecarProtocolPeer } from "../../internal/sidecar-protocol/protocol-peer.js";
import type { SidecarOperationDefinition } from "../../internal/sidecar-protocol/operation-registry.js";

export class SidecarUpstreamUnavailableError extends Error {
  readonly code = "upstream_unavailable";
  constructor() { super("upstream_unavailable"); this.name = "SidecarUpstreamUnavailableError"; }
}

/** Replaceable event/callback route; providers retain their own live state. */
export class SidecarRuntimeAttachment {
  #peer: SidecarProtocolPeer | undefined;
  #controllerEpoch = 0;
  #ready = false;
  readonly #listeners = new Set<(event: "attached" | "detached") => void>();

  get currentPeer(): SidecarProtocolPeer | undefined { return this.#ready ? this.#peer : undefined; }
  get controllerEpoch(): number { return this.#controllerEpoch; }

  replace(peer: SidecarProtocolPeer, controllerEpoch: number): void {
    this.detach(this.#controllerEpoch);
    this.#peer = peer;
    this.#controllerEpoch = controllerEpoch;
  }

  ready(controllerEpoch: number): void {
    if (controllerEpoch !== this.#controllerEpoch || !this.#peer) return;
    this.#ready = true;
    for (const listener of this.#listeners) listener("attached");
  }

  detach(controllerEpoch: number): void {
    if (controllerEpoch !== this.#controllerEpoch) return;
    const peer = this.#peer;
    this.#peer = undefined;
    this.#ready = false;
    if (peer) {
      for (const listener of this.#listeners) listener("detached");
      void peer.close("sidecar_upstream_detached").catch(() => undefined);
    }
  }

  subscribe(listener: (event: "attached" | "detached") => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async sendEvent<Payload>(input: {
    readonly capabilityId: string; readonly majorVersion: number; readonly event: string;
    readonly payload: Payload; readonly schema: import("zod").z.ZodType<Payload>;
  }): Promise<boolean> {
    const peer = this.currentPeer;
    if (!peer) return false;
    try { await peer.sendEvent(input); return true; }
    catch (error) {
      if (peer !== this.currentPeer) return false;
      // A failed subscriber must never stop consumption of provider output.
      this.detach(this.#controllerEpoch);
      return false;
    }
  }

  async call<Request, Response>(definition: SidecarOperationDefinition<Request, Response>, request: Request,
    options?: Parameters<SidecarProtocolPeer["call"]>[2]): Promise<Response> {
    const peer = this.currentPeer;
    if (!peer) throw new SidecarUpstreamUnavailableError();
    return await peer.call(definition, request, options);
  }
}
