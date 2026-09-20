import { SidecarConnectionError, SidecarProvisionerCleanupError, SidecarServiceManagementError, SidecarServiceStagingError, type SidecarProvisioner, type SidecarServiceControlInput, type SidecarServiceControlBoundary, type SidecarArtifactInstallation, type PersistentSidecarByteStream } from "./sidecar-provisioner.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SidecarByteStream } from "../../internal/sidecar-protocol/contracts.js";
import {
  assertManagedSidecarSshConfiguration,
  openOwnedSshStdio,
  SshOwnedStdioCleanupError,
  SshOwnedStdioWriteError,
  type SshBidirectionalProcessSpawner,
  type SshOwnedStdioChannel,
} from "../execution/ssh-owned-stdio.js";
import type { SshProcessSpawner } from "../execution/ssh-open-ssh.js";
import {
  assertSidecarArtifactRegistration,
  readVerifiedSidecarArtifactPayload,
  type SidecarArtifactRegistration,
} from "./sidecar-artifact.js";
import { buildSanitizedSidecarEnvironment } from "./sanitized-sidecar-environment.js";
import { SIDECAR_WIRE_VERSION } from "../../internal/sidecar-protocol/envelopes.js";
import {
  readSidecarManagementRecord,
  writeSidecarManagementRecord,
} from "../../internal/sidecar-protocol/service-management-channel.js";
import {
  SIDECAR_MANAGEMENT_VERSION,
  sameSidecarServiceConfiguration,
  sameSidecarServiceScope,
  sidecarManagementResponseSchema,
  sidecarServiceScopeSchema,
  sidecarServiceConfigurationSchema,
  type SidecarServiceScope,
  type SidecarServiceConfiguration,
  type SidecarServiceStatus,
  type SidecarManagementRequest,
  type SidecarManagementReceipt,
  type SidecarManagementResponse,
} from "../../internal/sidecar-protocol/service-management-v1.js";
import { sidecarManagementProxyCommand } from "./ssh-sidecar-management-proxy.js";

const INSTALL_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_BOOTSTRAP_STDOUT_BYTES = 16 * 1_024;
const REMOTE_ARTIFACT_FILENAME = "sedes";

export class SshSidecarArtifactCleanupError extends SidecarProvisionerCleanupError {
  constructor(options: ErrorOptions) {
    super(options, "ssh_sidecar_artifact_cleanup_failed");
    this.name = "SshSidecarArtifactCleanupError";
  }
}

/** SSH failed before a complete bootstrap/management reply was received.
 * Retrying observation is safe; this is never permission to replay mutations. */
export class SshSidecarConnectionError extends SidecarConnectionError {

  constructor(options: ErrorOptions) {
    super(options, "ssh_sidecar_connection_failed");
    this.name = "SshSidecarConnectionError";
  }
}

import { REMOTE_BOOTSTRAP_SOURCE } from "./sidecar-artifact-bootstrap.js";
export { REMOTE_BOOTSTRAP_SOURCE } from "./sidecar-artifact-bootstrap.js";

export interface SshSidecarArtifactInstallation extends SidecarArtifactInstallation {
  readonly envExecutable: string;
}

export interface SshSidecarArtifactInstallerOptions {
  readonly host: string;
  readonly artifact: SidecarArtifactRegistration;
  readonly agentToolEndpointKey: string;
  readonly serviceScope: SidecarServiceScope;
  readonly configuration: SidecarServiceConfiguration;
  readonly sshExecutable?: string;
  readonly spawnProcess?: SshProcessSpawner;
  /** Simulates an isolated passwd entry in disposable-sshd integration tests. */
  readonly testOnlyAccountHome?: string;
}

export class SshSidecarArtifactInstaller implements SidecarProvisioner {
  readonly transportKind = "ssh_stdio";
  readonly #host: string;
  readonly #artifact: SidecarArtifactRegistration;
  readonly #agentToolEndpointKey: string;
  readonly #sshExecutable: string | undefined;
  readonly #spawnProcess: SshProcessSpawner | undefined;
  readonly #testOnlyAccountHome: string | undefined;
  readonly #serviceScope: SidecarServiceScope;
  readonly #configuration: SidecarServiceConfiguration;
  #installation: SshSidecarArtifactInstallation | undefined;

  constructor(input: SshSidecarArtifactInstallerOptions) {
    assertSidecarArtifactRegistration(input.artifact);
    if (!/^[0-9a-f]{24}$/u.test(input.agentToolEndpointKey)) {
      throw new Error("sidecar_agent_tool_endpoint_key_invalid");
    }
    if (
      input.testOnlyAccountHome !== undefined &&
      (process.env.VITEST !== "true" ||
        !isCanonicalRemoteAbsolute(input.testOnlyAccountHome) ||
        input.testOnlyAccountHome === "/")
    ) {
      throw new Error("sidecar_test_account_home_invalid");
    }
    this.#host = input.host;
    this.#artifact = input.artifact;
    this.#agentToolEndpointKey = input.agentToolEndpointKey;
    this.#sshExecutable = input.sshExecutable;
    this.#spawnProcess = input.spawnProcess;
    this.#testOnlyAccountHome = input.testOnlyAccountHome;
    this.#serviceScope = Object.freeze(
      sidecarServiceScopeSchema.parse(input.serviceScope),
    );
    this.#configuration = Object.freeze(
      sidecarServiceConfigurationSchema.parse(input.configuration),
    );
  }

  get artifact(): SidecarArtifactRegistration {
    return this.#artifact;
  }

  async inspect(
    signal: AbortSignal,
  ): Promise<SidecarServiceStatus | undefined> {
    const response = await this.#management(
      {
        managementVersion: SIDECAR_MANAGEMENT_VERSION,
        requestId: randomUUID(),
        scope: this.#serviceScope,
        operation: "status",
      },
      signal,
    );
    if (response.outcome === "absent") return undefined;
    return this.#status(response);
  }

  async inspectReceipt(
    mutationId: string,
    signal: AbortSignal,
  ): Promise<SidecarManagementReceipt | undefined> {
    const response = await this.#management(
      {
        managementVersion: SIDECAR_MANAGEMENT_VERSION,
        requestId: randomUUID(),
        scope: this.#serviceScope,
        operation: "receipt",
        mutationId,
      },
      signal,
    );
    if (response.outcome === "error")
      throw new SidecarServiceManagementError(response.code, response.status);
    if (response.outcome !== "receipt")
      throw new Error("sidecar_management_response_invalid");
    return response.receipt ?? undefined;
  }

  /**
   * Fences a control whose acknowledgement was lost. The service records a
   * terminal `withdrawn` receipt for the id unless one already exists, in
   * which case that receipt is returned. Undefined means the service is gone.
   */
  async withdrawReceipt(
    mutationId: string,
    expectedServiceIncarnation: string,
    signal: AbortSignal,
  ): Promise<SidecarManagementReceipt | undefined> {
    const response = await this.#management(
      {
        managementVersion: SIDECAR_MANAGEMENT_VERSION,
        requestId: randomUUID(),
        scope: this.#serviceScope,
        operation: "withdraw",
        mutationId,
        expectedServiceIncarnation,
      },
      signal,
    );
    if (response.outcome === "absent") return undefined;
    if (response.outcome === "error")
      throw new SidecarServiceManagementError(response.code, response.status);
    if (response.outcome !== "receipt" || !response.receipt)
      throw new Error("sidecar_management_response_invalid");
    return response.receipt;
  }

  async control(
    input: SidecarServiceControlInput,
    signal: AbortSignal,
    boundary: SidecarServiceControlBoundary = effect => effect(),
  ): Promise<SidecarServiceStatus | undefined> {
    // Artifact staging is complete before any old resource is interrupted.
    if (input.operation !== "stop") {
      try { await this.install(signal); }
      catch (error) {
        // An unretired installer carrier must keep its existing cleanup fence.
        if (error instanceof SshSidecarArtifactCleanupError) throw error;
        throw new SidecarServiceStagingError(error);
      }
    }
    signal.throwIfAborted();
    return await boundary(() => this.#controlStaged(input, signal));
  }

  async #controlStaged(input: SidecarServiceControlInput, signal: AbortSignal): Promise<SidecarServiceStatus | undefined> {
    let response = await this.#management(
      {
        managementVersion: SIDECAR_MANAGEMENT_VERSION,
        requestId: input.mutationId,
        scope: this.#serviceScope,
        operation: input.operation === "stop" ? "stop" : "restart",
        expectedServiceIncarnation: input.expectedServiceIncarnation,
        controllerEpoch: input.controllerEpoch,
        expectedConfiguration: input.expectedConfiguration,
        expectedResourcesFingerprint: input.expectedResourcesFingerprint,
        force: input.force,
      },
      signal,
    );
    let admitted = true;
    if (response.outcome === "absent") {
      const receipt = await this.inspectReceipt(input.mutationId, signal);
      // The proxy answers "absent" only for a durably stopped service or an
      // ended target lifetime, and every effect is preceded by a receipt. A
      // missing receipt therefore proves this command was never admitted; the
      // service is already gone, which is the requested end state for a stop
      // and the precondition for starting a replacement.
      admitted = receipt !== undefined;
      response = {
        managementVersion: SIDECAR_MANAGEMENT_VERSION,
        requestId: input.mutationId,
        outcome: "receipt",
        receipt: receipt ?? null,
      };
    }
    if (response.outcome === "receipt" && admitted) {
      // A withdrawn id was fenced by lifecycle recovery before this replay
      // landed; the service refused it without executing anything.
      if (response.receipt?.state === "withdrawn")
        throw new SidecarServiceManagementError(
          "sidecar_management_mutation_withdrawn", undefined, "rejected",
        );
      if (
        response.receipt?.state === "failed" ||
        response.receipt?.state === "handoff_pending"
      )
        throw new SidecarServiceManagementError(
          response.receipt.code ?? "sidecar_management_failed",
          undefined, "rejected",
        );
      if (response.receipt?.state !== "completed")
        throw new SidecarServiceManagementError(
          "sidecar_management_outcome_unknown",
        );
    } else if (response.outcome !== "receipt") {
      if (response.outcome === "error") throw new SidecarServiceManagementError(response.code, response.status, "rejected");
      const stopped = this.#status(response);
      if (stopped.state !== "stopped")
        throw new SidecarServiceManagementError(
          "sidecar_service_stop_unconfirmed",
          stopped,
        );
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      signal.throwIfAborted();
      const current = await this.inspect(signal);
      if (!current) break;
      if (current.serviceIncarnation !== input.expectedServiceIncarnation) {
        if (input.operation === "stop") return undefined;
        if (
          current.buildId !== this.#artifact.buildId ||
          current.artifactSha256 !== this.#artifact.artifactSha256 ||
          !sameSidecarServiceConfiguration(
            current.effectiveConfiguration,
            this.#configuration,
          )
        )
          throw new SidecarServiceManagementError(
            "sidecar_service_replaced_concurrently",
            current,
          );
        return current;
      }
      if (attempt === 99)
        throw new SidecarServiceManagementError(
          "sidecar_service_stop_unconfirmed",
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (input.operation === "stop") return undefined;
    // The old service is gone; connect spawns a fresh daemon from the artifact.
    const stream = await this.#openPersistentAttachment(
      1,
      randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      undefined,
      signal,
    );
    try {
      return stream.serviceStatus;
    } finally {
      await stream.close("sidecar_management_replacement_ready");
    }
  }

  async install(signal: AbortSignal): Promise<SshSidecarArtifactInstallation> {
    const bytes = await readVerifiedSidecarArtifactPayload(this.#artifact);
    const attempt = deadlineSignal(signal, INSTALL_TIMEOUT_MILLISECONDS);
    let channel: SshOwnedStdioChannel | undefined;
    try {
      await assertManagedSidecarSshConfiguration({
        host: this.#host,
        signal: attempt.signal,
        ...(this.#sshExecutable ? { sshExecutable: this.#sshExecutable } : {}),
        ...(this.#spawnProcess ? { spawnProcess: this.#spawnProcess } : {}),
      });
      channel = await openOwnedSshStdio({
        host: this.#host,
        remoteCommand: bootstrapCommand(
          this.#artifact,
          this.#testOnlyAccountHome,
        ),
        signal: attempt.signal,
        ...(this.#sshExecutable ? { sshExecutable: this.#sshExecutable } : {}),
        ...(this.#spawnProcess ? { spawnProcess: this.#spawnProcess } : {}),
      });
      const lines = boundedLines(
        channel.stdout,
        MAXIMUM_BOOTSTRAP_STDOUT_BYTES,
      )[Symbol.asyncIterator]();
      let response = await nextLine(lines, attempt.signal);
      if (response === "send") {
        await channel.writeStdin(bytes, { signal: attempt.signal });
        channel.closeStdin();
        response = await nextLine(lines, attempt.signal);
      } else if (response.startsWith("ready ")) {
        channel.closeStdin();
      } else {
        throw new Error("sidecar_install_response_invalid");
      }
      const installation = parseInstallationProof(
        response,
        this.#artifact.artifactSha256,
      );
      const closure = await waitForClosure(channel.closed, attempt.signal);
      if (closure.exitCode !== 0 || closure.reason !== "exit") {
        throw new Error("sidecar_install_failed");
      }
      this.#installation = installation;
      return installation;
    } catch (error) {
      try {
        await channel?.close("sidecar_install_failed");
      } catch (cleanupError) {
        throw new SshSidecarArtifactCleanupError({ cause: cleanupError });
      }
      if (error instanceof SshOwnedStdioCleanupError) {
        throw new SshSidecarArtifactCleanupError({ cause: error });
      }
      if (attempt.signal.aborted) {
        throw new Error("sidecar_unavailable", {
          cause: attempt.signal.reason,
        });
      }
      if (channel) throw await classifyConnectionFailure(error, channel, signal);
      throw error;
    } finally {
      attempt.dispose();
    }
  }

  async launch(
    carrierGeneration: number,
    sessionNonce: string,
    signal: AbortSignal,
  ): Promise<PersistentSidecarByteStream> {
    if (
      !Number.isSafeInteger(carrierGeneration) ||
      carrierGeneration <= 0 ||
      sessionNonce.length < 32 ||
      sessionNonce.length > 160 ||
      !/^[A-Za-z0-9_-]+$/u.test(sessionNonce)
    ) {
      throw new Error("sidecar_carrier_generation_invalid");
    }
    let existing = await this.inspect(signal);
    for (
      let attempt = 0;
      existing &&
      (existing.buildId !== this.#artifact.buildId ||
        existing.artifactSha256 !== this.#artifact.artifactSha256 ||
        existing.runtimeWireVersion !== SIDECAR_WIRE_VERSION ||
        !sameSidecarServiceConfiguration(
          existing.effectiveConfiguration,
          this.#configuration,
        ));
      attempt += 1
    ) {
      // Inventory already proves replacement cannot be admitted. Do not mint
      // a durable failed control on every ordinary reconnect attempt.
      if (existing.resources.some((resource) => resource.state === "active" || resource.state === "unknown" || resource.blockers.length > 0)) {
        if (existing.runtimeWireVersion !== SIDECAR_WIRE_VERSION) throw new SidecarServiceManagementError("sidecar_runtime_upgrade_required", existing);
        // A compatible but outdated service keeps serving. It is reported as
        // outdated and replaced automatically once its work settles.
        break;
      }
      const outdated = existing;
      try {
        // A completed upgrade reports the replacement service, or nothing
        // when connect must spawn a fresh daemon from the new artifact.
        existing = await this.control(
          {
            mutationId: randomUUID(),
            operation: "upgrade",
            expectedServiceIncarnation: outdated.serviceIncarnation,
            controllerEpoch: outdated.controllerEpoch,
            expectedConfiguration: outdated.desiredConfiguration,
            expectedResourcesFingerprint: outdated.resourcesFingerprint,
            force: false,
          },
          signal,
        );
        break;
      } catch (error) {
        // Refreshing provider-native idle evidence can legitimately advance the
        // resource fingerprint. An automatic upgrade may recapture and retry
        // only the same service, and every attempt still refuses all blockers.
        if (
          !(error instanceof SidecarServiceManagementError) ||
          error.code !== "sidecar_service_confirmation_stale" ||
          !error.status ||
          error.status.serviceIncarnation !== outdated.serviceIncarnation ||
          attempt >= 2
        )
          throw error;
        existing = error.status;
      }
    }
    return await this.#openPersistentAttachment(
      carrierGeneration,
      sessionNonce,
      existing,
      signal,
    );
  }

  async #openPersistentAttachment(
    carrierGeneration: number,
    sessionNonce: string,
    serving: SidecarServiceStatus | undefined,
    signal: AbortSignal,
  ): Promise<PersistentSidecarByteStream> {
    const installation = this.#installation;
    if (!installation) throw new Error("sidecar_artifact_not_installed");
    let channel: SshOwnedStdioChannel;
    try {
      // Recheck effective Host configuration for every new carrier. The
      // operator may edit ssh_config after the artifact was installed.
      await assertManagedSidecarSshConfiguration({
        host: this.#host,
        signal,
        ...(this.#sshExecutable ? { sshExecutable: this.#sshExecutable } : {}),
        ...(this.#spawnProcess ? { spawnProcess: this.#spawnProcess } : {}),
      });
      channel = await openOwnedSshStdio({
        host: this.#host,
        remoteCommand: launchCommand(
          this.#artifact,
          installation,
          carrierGeneration,
          sessionNonce,
          this.#agentToolEndpointKey,
          this.#serviceScope,
          this.#configuration,
        ),
        signal,
        ...(this.#sshExecutable ? { sshExecutable: this.#sshExecutable } : {}),
        ...(this.#spawnProcess ? { spawnProcess: this.#spawnProcess } : {}),
      });
    } catch (error) {
      if (error instanceof SshOwnedStdioCleanupError) {
        throw new SshSidecarArtifactCleanupError({ cause: error });
      }
      throw error;
    }
    const stream = sidecarByteStream(channel);
    const request: SidecarManagementRequest = {
      managementVersion: SIDECAR_MANAGEMENT_VERSION,
      requestId: randomUUID(),
      scope: this.#serviceScope,
      operation: "attach",
      // Attach names the build actually serving: a compatible but outdated
      // predecessor that still owns work, or the new artifact when connect
      // spawns a fresh daemon from it. The runtime handshake then verifies
      // the hello against this same status.
      expectedBuildId: serving?.buildId ?? this.#artifact.buildId,
      expectedArtifactSha256: serving?.artifactSha256 ?? this.#artifact.artifactSha256,
      runtimeWireVersion: SIDECAR_WIRE_VERSION,
      sessionNonce,
      carrierGeneration,
      configuration: this.#configuration,
      mode: "normal",
    };
    try {
      await writeSidecarManagementRecord(stream, request, signal);
      const parsed = await readSidecarManagementRecord(
        stream,
        sidecarManagementResponseSchema,
        signal,
      );
      if (parsed.value.requestId !== request.requestId)
        throw new Error("sidecar_management_response_identity_invalid");
      const serviceStatus = this.#status(parsed.value);
      if (!this.#installation) throw new Error("sidecar_artifact_not_installed");
      return Object.freeze({
        ...parsed.stream, serviceStatus,
        installation: servingInstallation(this.#installation, serviceStatus),
      });
    } catch (error) {
      await stream
        .close("sidecar_management_attach_failed")
        .catch(() => undefined);
      // The remote bootstrap reports why it could not reach or start the
      // service as its final stderr line. That is the actionable outcome.
      const diagnostic = (await Promise.race([channel.closed, new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 250).unref(); })]))?.diagnostic;
      if (diagnostic?.startsWith("sidecar_")) throw new SidecarServiceManagementError(diagnostic, undefined, "rejected");
      throw error;
    }
  }

  async attachExisting(
    carrierGeneration: number,
    sessionNonce: string,
    signal: AbortSignal,
  ): Promise<PersistentSidecarByteStream> {
    const existing = await this.inspect(signal);
    if (!existing) throw new Error("sidecar_service_absent");
    if (existing.runtimeWireVersion !== SIDECAR_WIRE_VERSION) {
      throw new SidecarServiceManagementError("sidecar_runtime_upgrade_required", existing);
    }
    // Recovery speaks the existing service's exact runtime protocol and build.
    // This also works when that service predates relaxed recovery admission.
    const request: SidecarManagementRequest = {
      managementVersion: SIDECAR_MANAGEMENT_VERSION,
      requestId: randomUUID(),
      scope: this.#serviceScope,
      operation: "attach",
      expectedBuildId: existing.buildId,
      expectedArtifactSha256: existing.artifactSha256,
      runtimeWireVersion: SIDECAR_WIRE_VERSION,
      sessionNonce,
      carrierGeneration,
      configuration: this.#configuration,
      mode: "recovery",
    };
    const channel = await this.#openManagement(request, signal);
    const stream = sidecarByteStream(channel);
    try {
      await writeSidecarManagementRecord(stream, request, signal);
      const parsed = await readSidecarManagementRecord(
        stream,
        sidecarManagementResponseSchema,
        signal,
      );
      if (parsed.value.requestId !== request.requestId)
        throw new Error("sidecar_management_response_identity_invalid");
      const serviceStatus = this.#status(parsed.value);
      if (!this.#installation) throw new Error("sidecar_artifact_not_installed");
      return Object.freeze({
        ...parsed.stream, serviceStatus,
        installation: servingInstallation(this.#installation, serviceStatus),
      });
    } catch (error) {
      await stream
        .close("sidecar_recovery_attach_failed")
        .catch(() => undefined);
      throw await classifyConnectionFailure(error, channel, signal);
    }
  }

  #status(response: SidecarManagementResponse): SidecarServiceStatus {
    if (response.outcome === "error")
      throw new SidecarServiceManagementError(response.code, response.status);
    if (response.outcome !== "ok")
      throw new Error("sidecar_management_response_invalid");
    if (!sameSidecarServiceScope(response.status.scope, this.#serviceScope))
      throw new Error("sidecar_service_scope_mismatch");
    return response.status;
  }

  async #management(
    request: SidecarManagementRequest,
    signal: AbortSignal,
  ): Promise<SidecarManagementResponse> {
    const channel = await this.#openManagement(request, signal);
    const stream = sidecarByteStream(channel);
    try {
      if (request.operation !== "receipt")
        await writeSidecarManagementRecord(stream, request, signal);
      const { value } = await readSidecarManagementRecord(
        stream,
        sidecarManagementResponseSchema,
        signal,
      );
      if (value.requestId !== request.requestId)
        throw new Error("sidecar_management_response_identity_invalid");
      return value;
    } catch (error) {
      await stream.close("sidecar_management_failed");
      throw await classifyConnectionFailure(error, channel, signal);
    } finally {
      await stream.close("sidecar_management_complete");
    }
  }

  async #openManagement(
    request: SidecarManagementRequest,
    signal: AbortSignal,
  ): Promise<SshOwnedStdioChannel> {
    await assertManagedSidecarSshConfiguration({
      host: this.#host,
      signal,
      ...(this.#sshExecutable ? { sshExecutable: this.#sshExecutable } : {}),
      ...(this.#spawnProcess ? { spawnProcess: this.#spawnProcess } : {}),
    });
    return await openOwnedSshStdio({
      host: this.#host,
      remoteCommand: sidecarManagementProxyCommand({
        scope: this.#serviceScope,
        requestId: request.requestId,
        ...(request.operation === "receipt"
          ? { receipt: request.mutationId }
          : {}),
        ...(this.#testOnlyAccountHome
          ? { testOnlyAccountHome: this.#testOnlyAccountHome }
          : {}),
      }),
      signal,
      ...(this.#sshExecutable ? { sshExecutable: this.#sshExecutable } : {}),
      ...(this.#spawnProcess ? { spawnProcess: this.#spawnProcess } : {}),
    });
  }
}

async function classifyConnectionFailure(
  error: unknown,
  channel: SshOwnedStdioChannel,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    signal.aborted ||
    !(error instanceof Error) ||
    (!(error instanceof SshOwnedStdioWriteError) &&
      error.message !== "sidecar_install_output_incomplete" &&
      error.message !== "sidecar_management_response_incomplete")
  ) return error;
  // The caller has joined channel cleanup. An EOF alone could be a malformed
  // remote program; only OpenSSH's failure exit classifies a connection failure.
  const closure = await Promise.race([channel.closed, Promise.resolve(undefined)]);
  return closure?.reason === "exit" && closure.exitCode === 255 &&
    closure.signal === null && !closure.diagnostic?.startsWith("sidecar_")
    ? new SshSidecarConnectionError({ cause: error })
    : error;
}

function sidecarByteStream(channel: SshOwnedStdioChannel): SidecarByteStream {
  return Object.freeze({
    bytes: channel.stdout,
    closed: channel.closed.then((closure) => ({
      reason:
        closure.reason === "stderr_overflow"
          ? "ssh_sidecar_stderr_overflow"
          : closure.reason === "spawn_error"
            ? "ssh_sidecar_spawn_error"
            : "ssh_sidecar_exited",
      ...(closure.cause ? { cause: closure.cause } : {}),
    })),
    write: async (
      bytes: Uint8Array,
      options?: { readonly signal?: AbortSignal },
    ) => {
      try {
        await channel.writeStdin(bytes, options);
      } catch (error) {
        if (error instanceof SshOwnedStdioWriteError) throw error;
        throw new SshOwnedStdioWriteError(
          "ssh_sidecar_write_failed",
          "sent_outcome_unknown",
          { cause: error },
        );
      }
    },
    close: async (reason: string) => await channel.close(reason),
  });
}

function bootstrapCommand(
  artifact: SidecarArtifactRegistration,
  testOnlyAccountHome?: string,
): string {
  const source = testOnlyAccountHome
    ? testBootstrapSource(testOnlyAccountHome)
    : REMOTE_BOOTSTRAP_SOURCE;
  return [
    "exec node -e",
    posixQuote(source),
    posixQuote(artifact.artifactSha256),
    posixQuote(artifact.buildId),
    posixQuote(String(artifact.artifactBytes)),
    posixQuote(
      Buffer.from(JSON.stringify(artifact.nativeAssets), "utf8").toString(
        "base64url",
      ),
    ),
  ].join(" ");
}

function testBootstrapSource(accountHome: string): string {
  const accountLookup = "o.userInfo().homedir";
  const replacement = JSON.stringify(accountHome);
  const source = REMOTE_BOOTSTRAP_SOURCE.replace(accountLookup, replacement);
  if (source === REMOTE_BOOTSTRAP_SOURCE || source.includes(accountLookup)) {
    throw new Error("sidecar_test_account_lookup_seam_invalid");
  }
  return source;
}

function launchCommand(
  artifact: SidecarArtifactRegistration,
  installation: SshSidecarArtifactInstallation,
  carrierGeneration: number,
  sessionNonce: string,
  agentToolEndpointKey: string,
  serviceScope: SidecarServiceScope,
  configuration: SidecarServiceConfiguration,
): string {
  return [
    "exec",
    posixQuote(installation.envExecutable),
    "-i",
    ...Object.entries(installation.environment).map(([name, value]) =>
      posixQuote(`${name}=${value}`),
    ),
    posixQuote(installation.nodeExecutable),
    posixQuote(installation.executablePath),
    "service",
    "connect",
    "--expected-digest",
    posixQuote(artifact.artifactSha256),
    "--expected-build",
    posixQuote(artifact.buildId),
    "--service-scope",
    posixQuote(
      Buffer.from(JSON.stringify(serviceScope), "utf8").toString("base64url"),
    ),
    "--configuration",
    posixQuote(
      Buffer.from(JSON.stringify(configuration), "utf8").toString("base64url"),
    ),
    "--agent-tool-endpoint-key",
    posixQuote(agentToolEndpointKey),
  ].join(" ");
}

function parseInstallationProof(
  line: string,
  artifactSha256: string,
): SshSidecarArtifactInstallation {
  if (!line.startsWith("ready ")) {
    throw new Error("sidecar_install_response_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(line.slice("ready ".length));
  } catch (error) {
    throw new Error("sidecar_install_response_invalid", { cause: error });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 7 ||
    !("accountHome" in value) ||
    !("nodeExecutable" in value) ||
    !("envExecutable" in value) ||
    !("stateRoot" in value) ||
    !("environment" in value) ||
    !("executableDirectory" in value) ||
    !("executablePath" in value) ||
    typeof value.accountHome !== "string" ||
    typeof value.nodeExecutable !== "string" ||
    typeof value.envExecutable !== "string" ||
    typeof value.stateRoot !== "string" ||
    !validBoundEnvironment(value.environment, value.accountHome) ||
    typeof value.executableDirectory !== "string" ||
    typeof value.executablePath !== "string" ||
    value.executableDirectory.length === 0 ||
    value.executableDirectory.length > 4_096 ||
    value.executablePath.length === 0 ||
    value.executablePath.length > 4_096 ||
    !path.posix.isAbsolute(value.executableDirectory) ||
    path.posix.normalize(value.executableDirectory) !==
      value.executableDirectory ||
    !isCanonicalRemoteAbsolute(value.accountHome) ||
    value.accountHome === "/" ||
    !isCanonicalRemoteAbsolute(value.nodeExecutable) ||
    !isCanonicalRemoteAbsolute(value.envExecutable) ||
    !isCanonicalRemoteAbsolute(value.stateRoot) ||
    value.stateRoot !==
      path.posix.join(
        value.accountHome,
        ".local",
        "state",
        "sedes",
        "sidecar",
      ) ||
    value.executableDirectory !==
      path.posix.join(value.stateRoot, "artifacts", "sha256", artifactSha256) ||
    value.executablePath !==
      path.posix.join(value.executableDirectory, REMOTE_ARTIFACT_FILENAME) ||
    /[\u0000-\u001f\u007f]/u.test(value.executableDirectory) ||
    /[\u0000-\u001f\u007f]/u.test(value.executablePath)
  ) {
    throw new Error("sidecar_install_response_invalid");
  }
  return Object.freeze({
    accountHome: value.accountHome,
    nodeExecutable: value.nodeExecutable,
    envExecutable: value.envExecutable,
    stateRoot: value.stateRoot,
    environment: Object.freeze({ ...value.environment }),
    executableDirectory: value.executableDirectory,
    executablePath: value.executablePath,
  });
}

function isCanonicalRemoteAbsolute(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validBoundEnvironment(
  value: unknown,
  accountHome: string,
): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (entries.length > 40 || entries.length === 0) return false;
  let bytes = 0;
  for (const [name, entry] of entries) {
    if (typeof entry !== "string") return false;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(entry);
  }
  if (bytes > 32 * 1_024 || record["HOME"] !== accountHome) return false;
  const sanitized = buildSanitizedSidecarEnvironment(
    record as NodeJS.ProcessEnv,
  );
  return (
    Object.keys(sanitized).length === entries.length &&
    entries.every(([name, entry]) => sanitized[name] === entry)
  );
}

function posixQuote(value: string): string {
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("sidecar_remote_command_value_invalid");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function* boundedLines(
  bytes: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): AsyncIterable<string> {
  let buffered = Buffer.alloc(0);
  let observed = 0;
  for await (const chunk of bytes) {
    observed += chunk.byteLength;
    if (observed > maximumBytes) {
      throw new Error("sidecar_install_output_overflow");
    }
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    while (true) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) break;
      const line = buffered.subarray(0, newline).toString("utf8");
      buffered = buffered.subarray(newline + 1);
      yield line;
    }
  }
  if (buffered.byteLength !== 0) {
    throw new Error("sidecar_install_output_incomplete");
  }
}

async function nextLine(
  iterator: AsyncIterator<string>,
  signal: AbortSignal,
): Promise<string> {
  const result = await withAbort(iterator.next(), signal);
  if (result.done) throw new Error("sidecar_install_output_incomplete");
  return result.value;
}

async function waitForClosure<T>(
  closure: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return await withAbort(closure, signal);
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => finish(false, signal.reason);
    const finish = (success: boolean, value: unknown) => {
      signal.removeEventListener("abort", abort);
      if (success) resolve(value as T);
      else reject(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => finish(true, value),
      (error) => finish(false, error),
    );
  });
}

function deadlineSignal(signal: AbortSignal, milliseconds: number) {
  const controller = new AbortController();
  const callerAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", callerAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("sidecar_install_timeout")),
    milliseconds,
  );
  timer.unref();
  if (signal.aborted) callerAbort();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener("abort", callerAbort);
    },
  };
}

// Retained for test construction without widening the production spawner type.
export type SshSidecarProcessSpawner = SshBidirectionalProcessSpawner;

/** SSH targets use the admitted POSIX artifact layout, independently of main's OS. */
function servingInstallation(installation: SshSidecarArtifactInstallation, status: SidecarServiceStatus): SshSidecarArtifactInstallation {
  const executableDirectory = path.posix.join(installation.stateRoot, "artifacts", "sha256", status.artifactSha256);
  return Object.freeze({ ...installation, executableDirectory, executablePath: path.posix.join(executableDirectory, "sedes") });
}
