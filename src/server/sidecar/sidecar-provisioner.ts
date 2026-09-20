import type { SidecarByteStream } from "../../internal/sidecar-protocol/contracts.js";
import type { SidecarServiceConfiguration, SidecarServiceStatus, SidecarManagementReceipt } from "../../internal/sidecar-protocol/service-management-v1.js";

export interface SidecarServiceControlInput {
  readonly mutationId: string;
  readonly operation: "stop" | "restart" | "upgrade";
  readonly expectedServiceIncarnation: string;
  readonly controllerEpoch: number;
  readonly expectedConfiguration: SidecarServiceConfiguration;
  readonly expectedResourcesFingerprint: string;
  readonly force: boolean;
}
/** Artifact staging finishes before this boundary may fence or close callers.
 * The supplied effect owns shutdown and replacement; the boundary holds local
 * admission until that effect (including owner attachment retirement) settles. */
export type SidecarServiceControlBoundary = (
  effect: () => Promise<SidecarServiceStatus | undefined>,
) => Promise<SidecarServiceStatus | undefined>;
export interface PersistentSidecarByteStream extends SidecarByteStream {
  /** Target-resolved metadata of the artifact actually serving this attachment. */
  readonly installation: SidecarArtifactInstallation;
  readonly serviceStatus: SidecarServiceStatus;
}
export class SidecarServiceManagementError extends Error {
  readonly status: SidecarServiceStatus | undefined;
  constructor(
    readonly code: string,
    status?: SidecarServiceStatus,
    readonly outcome: "rejected" | "unknown" = "unknown",
  ) {
    super(code);
    this.name = "SidecarServiceManagementError";
    this.status = status;
  }
}

/** This attempt failed before sending any shutdown/restart command. */
export class SidecarServiceStagingError extends Error {
  constructor(cause: unknown) {
    super("sidecar_service_staging_failed", { cause });
    this.name = "SidecarServiceStagingError";
  }
}

export interface SidecarArtifactInstallation {
  readonly accountHome: string;
  readonly nodeExecutable: string;
  readonly stateRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly executableDirectory: string;
  readonly executablePath: string;
}

/** The carrier could not prove cleanup; no replacement may bypass this fence. */
export class SidecarProvisionerCleanupError extends Error {
  readonly diagnosticCode: string;
  constructor(options: ErrorOptions, diagnosticCode = "sidecar_provisioner_cleanup_failed") {
    super(diagnosticCode, options);
    this.name = "SidecarProvisionerCleanupError";
    this.diagnosticCode = diagnosticCode;
  }
}

/** A carrier failed before a complete bootstrap/management reply.
 * Observation may be retried; this never authorizes replaying a mutation. */
export class SidecarConnectionError extends Error {
  readonly diagnosticCode: string;
  constructor(options: ErrorOptions, diagnosticCode = "sidecar_connection_failed") {
    super(diagnosticCode, options);
    this.name = "SidecarConnectionError";
    this.diagnosticCode = diagnosticCode;
  }
}

/** Scoped provisioning/connection strategy; contains no backend interpretation.
 * install stages artifacts only; attachExisting must never launch a daemon.
 * A runtime stream has already consumed its management attachment response. */
export interface SidecarProvisioner {
  readonly transportKind: string;
  install(signal: AbortSignal): Promise<SidecarArtifactInstallation>;
  launch(carrierGeneration: number, sessionNonce: string, signal: AbortSignal): Promise<PersistentSidecarByteStream>;
  attachExisting(carrierGeneration: number, sessionNonce: string, signal: AbortSignal): Promise<PersistentSidecarByteStream>;
  inspect(signal: AbortSignal): Promise<SidecarServiceStatus | undefined>;
  inspectReceipt(mutationId: string, signal: AbortSignal): Promise<SidecarManagementReceipt | undefined>;
  withdrawReceipt(mutationId: string, expectedServiceIncarnation: string, signal: AbortSignal): Promise<SidecarManagementReceipt | undefined>;
  control(input: SidecarServiceControlInput, signal: AbortSignal, boundary?: SidecarServiceControlBoundary): Promise<SidecarServiceStatus | undefined>;
}
