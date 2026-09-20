import type { EnvironmentProcessWriteDelivery } from "../../server/execution/environment-channel.js";

export type SidecarFrameLane = "control" | "operation";

export interface SidecarFrameWriteDiagnostic {
  readonly stage: "queued" | "write_start" | "write_complete" | "write_failed";
  readonly queuedWriteBytes: number;
  readonly queuedWriteFrames: number;
  readonly activeWriteBytes: number;
  readonly frameBytes: number;
  readonly durationMs: number;
}

export interface SidecarFrameSendOptions {
  readonly lane: SidecarFrameLane;
  readonly signal?: AbortSignal;
  /** Uses capacity reserved solely for a stream's terminal settlement frame. */
  readonly settlement?: boolean;
  /** Local observation only; never encoded or allowed to affect delivery. */
  readonly onWriteDiagnostic?: (record: SidecarFrameWriteDiagnostic) => void;
}

export interface SidecarTransportAssurance {
  readonly kind: string;
  readonly carrierGeneration: number;
}

export interface SidecarFrame {
  readonly bytes: Uint8Array;
}

export interface SidecarTransportClosure {
  readonly reason: string;
  readonly cause?: Error;
}

/** The carrier could not prove that its owned byte stream was closed. */
export class SidecarTransportCleanupError extends Error {
  readonly diagnosticCode = "sidecar_transport_cleanup_failed" as const;

  constructor(options: ErrorOptions) {
    super("sidecar_transport_cleanup_failed", options);
    this.name = "SidecarTransportCleanupError";
  }
}

export class SidecarFrameWriteError extends Error {
  readonly delivery: EnvironmentProcessWriteDelivery;

  constructor(
    message: string,
    delivery: EnvironmentProcessWriteDelivery,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SidecarFrameWriteError";
    this.delivery = delivery;
  }
}

/** Request delivery when the carrier/session closes without a terminal response. */
export class SidecarProtocolDeliveryError extends Error {
  readonly delivery: EnvironmentProcessWriteDelivery;

  constructor(message: string, delivery: EnvironmentProcessWriteDelivery) {
    super(message);
    this.name = "SidecarProtocolDeliveryError";
    this.delivery = delivery;
  }
}

/** Carrier-independent, ordered, reliable delivery of complete protocol frames. */
export interface SidecarFrameTransport {
  readonly assurance: SidecarTransportAssurance;
  readonly frames: AsyncIterable<SidecarFrame>;
  readonly closed: Promise<SidecarTransportClosure>;
  diagnosticSnapshot?(): Readonly<{ queuedWriteBytes: number; queuedWriteFrames: number; activeWriteBytes: number }>;
  send(
    bytes: Uint8Array,
    options: SidecarFrameSendOptions,
  ): Promise<{ readonly disposition: "sent" }>;
  close(reason: string): Promise<void>;
}

export interface SidecarByteStreamClosure {
  readonly reason: string;
  readonly cause?: Error;
  /** Present for installation-owned process carriers. */
  readonly exitCode?: number | null;
  /** Present for installation-owned process carriers. */
  readonly signal?: NodeJS.Signals | null;
}

/** A carrier-owned byte stream. It exposes no SSH, process, socket, or stdio type. */
export interface SidecarByteStream {
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly closed: Promise<SidecarByteStreamClosure>;
  write(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  close(reason: string): Promise<void>;
}
