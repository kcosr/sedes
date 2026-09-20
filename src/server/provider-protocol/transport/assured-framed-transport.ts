import {
  isValidEnvironmentAssuredTcpStreamIdentity,
  isValidEnvironmentPrivateUnixStreamIdentity,
  isValidEnvironmentOwnedProcessIdentity,
  isValidEnvironmentSecretIdentity,
  sameEnvironmentChannelScope,
  validEnvironmentChannelScope,
  type EnvironmentAssuredTcpStreamIdentity,
  type EnvironmentChannelScope,
  type EnvironmentOwnedProcessIdentity,
  type EnvironmentPrivateUnixStreamIdentity,
} from "../../execution/environment-channel.js";

/** Exact server-derived authority shared by one assured provider connection. */
export type ProviderTransportScope = EnvironmentChannelScope;

export interface OwnedProcessAssurance {
  readonly kind: "owned_process";
  readonly ownership: "owned";
  readonly channel: "process_stdio";
  readonly scope: ProviderTransportScope;
  readonly connectionGeneration: number;
  readonly environmentChannelIdentity: EnvironmentOwnedProcessIdentity;
}

export interface PrivateUnixSocketAssurance {
  readonly kind: "private_unix_socket";
  readonly ownership: "external";
  readonly channel: "unix_websocket";
  readonly scope: ProviderTransportScope;
  readonly connectionGeneration: number;
  readonly environmentChannelIdentity: EnvironmentPrivateUnixStreamIdentity;
  readonly websocketUpgradeVerified: true;
}

export interface AuthenticatedTcpAssurance {
  readonly kind: "authenticated_tcp";
  readonly ownership: "external";
  readonly channel: "tcp_websocket";
  readonly scope: ProviderTransportScope;
  readonly connectionGeneration: number;
  readonly environmentChannelIdentity: EnvironmentAssuredTcpStreamIdentity;
  readonly websocketUpgradeVerified: true;
}

export type FramedTransportAssurance =
  | OwnedProcessAssurance
  | PrivateUnixSocketAssurance
  | AuthenticatedTcpAssurance;

const validAssurances = new WeakSet<object>();
const activeAssurances = new WeakSet<object>();

export function createOwnedProcessAssurance(
  expectedScope: ProviderTransportScope,
  connectionGeneration: number,
  identity: EnvironmentOwnedProcessIdentity,
  diagnosticPrefix: string,
): OwnedProcessAssurance {
  const prefix = validatedDiagnosticPrefix(diagnosticPrefix);
  if (
    !validEnvironmentChannelScope(expectedScope) ||
    !validConnectionGeneration(connectionGeneration) ||
    !isValidEnvironmentOwnedProcessIdentity(identity) ||
    !sameEnvironmentChannelScope(expectedScope, identity.scope)
  ) {
    throw new Error(`${prefix}_owned_process_assurance_invalid`);
  }
  const assurance = Object.freeze({
    kind: "owned_process" as const,
    ownership: "owned" as const,
    channel: "process_stdio" as const,
    scope: Object.freeze({ ...expectedScope }),
    connectionGeneration,
    environmentChannelIdentity: identity,
  });
  validAssurances.add(assurance);
  activeAssurances.add(assurance);
  return assurance;
}

export interface InboundTextFrame {
  readonly text: string;
  readonly byteLength: number;
}

export interface FramedTransportClosure {
  readonly reason: string;
  readonly cause?: Error;
}

export type FrameDelivery = "not_sent" | "sent_outcome_unknown";

/** Safe provider-private classification for connection establishment. */
export class FramedTransportOpenError extends Error {
  readonly code: string;
  readonly permanent: boolean;

  constructor(code: string, permanent: boolean, options?: ErrorOptions) {
    super(code, options);
    this.name = "FramedTransportOpenError";
    this.code = code;
    this.permanent = permanent;
  }
}

/**
 * A send failure must state whether any part of the frame might have crossed
 * the transport boundary. Callers use this distinction to avoid replaying a
 * provider mutation whose acceptance is unknown.
 */
export class FrameWriteError extends Error {
  readonly delivery: FrameDelivery;

  constructor(
    message: string,
    delivery: FrameDelivery,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FrameWriteError";
    this.delivery = delivery;
  }
}

/**
 * Transport-neutral provider message framing. `close` always closes only
 * the resources Sedes owns. For an external assurance that is the client
 * channel, never the provider server.
 */
export interface FramedMessageTransport {
  readonly maximumFrameBytes: number;
  readonly assurance: FramedTransportAssurance;
  readonly frames: AsyncIterable<InboundTextFrame>;
  readonly closed: Promise<FramedTransportClosure>;
  send(
    text: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly disposition: "sent" }>;
  close(reason: string): Promise<void>;
}

export interface FramedTransportFactory {
  open(
    expectedScope: ProviderTransportScope,
    connectionGeneration: number,
    signal: AbortSignal,
    lifecycle?: FramedTransportLifecycleObserver,
  ): Promise<FramedMessageTransport>;
}

/** Reports owned-server lifecycle boundaries only. External factories ignore it. */
export interface FramedTransportLifecycleObserver {
  launchStarted(): void;
  cleanupProven(): void;
  cleanupFailed(error: unknown): void;
}

export interface ExternalFramedConnection {
  readonly maximumFrameBytes: number;
  readonly frames: AsyncIterable<InboundTextFrame>;
  readonly closed: Promise<FramedTransportClosure>;
  send(
    text: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly disposition: "sent" }>;
  /** Closes only the Sedes-owned client/channel or carrier. */
  closeClient(reason: string): Promise<void>;
  /** Synchronously initiates an idempotent hard close of that client only. */
  destroyClient(reason: string): void;
}

const EXTERNAL_CLIENT_CLOSE_DEADLINE_MILLISECONDS = 1_000;

export function createAuthenticatedTcpAssurance(
  expectedScope: ProviderTransportScope,
  connectionGeneration: number,
  identity: EnvironmentAssuredTcpStreamIdentity,
  diagnosticPrefix: string,
): AuthenticatedTcpAssurance {
  const prefix = validatedDiagnosticPrefix(diagnosticPrefix);
  if (
    !validEnvironmentChannelScope(expectedScope) ||
    !validConnectionGeneration(connectionGeneration) ||
    !isValidEnvironmentAssuredTcpStreamIdentity(identity) ||
    !isValidEnvironmentSecretIdentity(identity.authenticationIdentity) ||
    !sameEnvironmentChannelScope(expectedScope, identity.scope) ||
    identity.connectionGeneration !== connectionGeneration
  ) {
    throw new Error(`${prefix}_authenticated_tcp_assurance_invalid`);
  }
  return mintAssurance({
    kind: "authenticated_tcp",
    ownership: "external",
    channel: "tcp_websocket",
    scope: Object.freeze({ ...expectedScope }),
    connectionGeneration,
    environmentChannelIdentity: identity,
    websocketUpgradeVerified: true,
  });
}

export function createPrivateUnixSocketAssurance(
  expectedScope: ProviderTransportScope,
  connectionGeneration: number,
  identity: EnvironmentPrivateUnixStreamIdentity,
  diagnosticPrefix: string,
): PrivateUnixSocketAssurance {
  const prefix = validatedDiagnosticPrefix(diagnosticPrefix);
  if (
    !validEnvironmentChannelScope(expectedScope) ||
    !validConnectionGeneration(connectionGeneration) ||
    !isValidEnvironmentPrivateUnixStreamIdentity(identity) ||
    !sameEnvironmentChannelScope(expectedScope, identity.scope)
  ) {
    throw new Error(`${prefix}_private_unix_assurance_invalid`);
  }
  return mintAssurance({
    kind: "private_unix_socket",
    ownership: "external",
    channel: "unix_websocket",
    scope: Object.freeze({ ...expectedScope }),
    connectionGeneration,
    environmentChannelIdentity: identity,
    websocketUpgradeVerified: true,
  });
}

export function externalTransport(
  assurance: PrivateUnixSocketAssurance | AuthenticatedTcpAssurance,
  connection: ExternalFramedConnection,
  diagnosticPrefix: string,
): FramedMessageTransport {
  const prefix = validatedDiagnosticPrefix(diagnosticPrefix);
  if (!isValidFramedTransportAssurance(assurance)) {
    throw new Error(`${prefix}_external_transport_assurance_invalid`);
  }
  let resolveLocalClose!: (closure: FramedTransportClosure) => void;
  const localClose = new Promise<FramedTransportClosure>((resolve) => {
    resolveLocalClose = resolve;
  });
  let closePromise: Promise<void> | undefined;
  const closed = Promise.race([connection.closed, localClose]).finally(() => {
    revokeFramedTransportAssurance(assurance);
  });
  return Object.freeze({
    maximumFrameBytes: connection.maximumFrameBytes,
    assurance,
    frames: connection.frames,
    closed,
    send: connection.send.bind(connection),
    close(reason: string): Promise<void> {
      closePromise ??= closeExternalClient(connection, reason, prefix)
        .then(() => {
          resolveLocalClose({ reason });
        })
        .catch((error: unknown) => {
          resolveLocalClose({
            reason: "external_client_cleanup_failed",
            cause: asError(error),
          });
          throw error;
        });
      return closePromise;
    },
  });
}

async function closeExternalClient(
  connection: ExternalFramedConnection,
  reason: string,
  diagnosticPrefix: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const closing = connection.closeClient(reason);
    // The deadline can win before a carrier observes the hard close. Keep the
    // abandoned graceful-close rejection handled after ownership-safe
    // escalation, exactly as other bounded lifecycle races do.
    void closing.catch(() => undefined);
    await Promise.race([
      closing,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${diagnosticPrefix}_external_client_close_deadline_exceeded`,
              ),
            ),
          EXTERNAL_CLIENT_CLOSE_DEADLINE_MILLISECONDS,
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    try {
      connection.destroyClient(`${reason}:forced`);
    } catch (destroyError) {
      throw new Error(`${diagnosticPrefix}_external_client_destroy_failed`, {
        cause: destroyError,
      });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function mintAssurance<
  T extends PrivateUnixSocketAssurance | AuthenticatedTcpAssurance,
>(assurance: T): T {
  const frozen = Object.freeze(assurance);
  validAssurances.add(frozen);
  activeAssurances.add(frozen);
  return frozen;
}

/** Retires one connection generation without invalidating its environment proof. */
export function revokeFramedTransportAssurance(
  assurance: FramedTransportAssurance,
): void {
  activeAssurances.delete(assurance);
}

export function isValidFramedTransportAssurance(
  assurance: FramedTransportAssurance,
): boolean {
  return (
    validAssurances.has(assurance) &&
    activeAssurances.has(assurance) &&
    validEnvironmentChannelScope(assurance.scope) &&
    validConnectionGeneration(assurance.connectionGeneration) &&
    (assurance.kind === "private_unix_socket"
      ? isValidEnvironmentPrivateUnixStreamIdentity(
          assurance.environmentChannelIdentity,
        )
      : assurance.kind === "authenticated_tcp"
        ? isValidEnvironmentAssuredTcpStreamIdentity(
            assurance.environmentChannelIdentity,
          ) &&
          isValidEnvironmentSecretIdentity(
            assurance.environmentChannelIdentity.authenticationIdentity,
          ) &&
          assurance.environmentChannelIdentity.connectionGeneration ===
            assurance.connectionGeneration
        : true)
  );
}

export function sameProviderTransportScope(
  left: ProviderTransportScope,
  right: ProviderTransportScope,
): boolean {
  return sameEnvironmentChannelScope(left, right);
}

function validConnectionGeneration(generation: number): boolean {
  return Number.isSafeInteger(generation) && generation > 0;
}

function validatedDiagnosticPrefix(prefix: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(prefix)) {
    throw new Error("provider_transport_diagnostic_prefix_invalid");
  }
  return prefix;
}
