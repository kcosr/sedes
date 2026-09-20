import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { lstat, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import type {
  EnvironmentChannelScope,
  EnvironmentOwnedProcessChannel,
} from "../../src/server/execution/environment-channel.js";
import {
  isValidFramedTransportAssurance,
  type FramedMessageTransport,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import {
  OwnedNdjsonStdioTransport,
  type OwnedNdjsonStdioDiagnostics,
  type OwnedNdjsonStdioLimits,
} from "../../src/server/provider-protocol/transport/owned-ndjson-stdio-transport.js";
import {
  createGrokInitializeOnlyProbe,
  type GrokProbeDiagnostics,
} from "./grok-probe-profile.js";

export type GrokOfflineTranche = "o1_no_initialize" | "o2a_initialize_only";

export interface GrokOfflineTrancheInput {
  readonly tranche: GrokOfflineTranche;
  readonly scope: EnvironmentChannelScope;
  readonly connectionGeneration: number;
  readonly outputPath: string;
  /** Fixture-only. Exact runs always use a private staged pinned candidate. */
  readonly executablePath?: string;
  readonly scriptPath?: string;
  readonly arguments?: readonly string[];
  readonly bubblewrapPath?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly sensitiveValues?: readonly string[];
  readonly observationMilliseconds?: number;
  readonly deadlineMilliseconds?: number;
  /** Fixture-only emergency cleanup budget used by bounded failure tests. */
  readonly emergencyCleanupMilliseconds?: number;
  readonly transportLimits?: Partial<OwnedNdjsonStdioLimits>;
  readonly sandboxLimits?: Readonly<Record<string, number>>;
  readonly candidateVerifier?: GrokProbeCandidateVerifier;
}

export interface GrokProbeCandidateIdentity {
  readonly verifier: "pinned_grok_1.0.4" | "fixture_callback";
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly immutableIdentity: string;
}

export interface GrokProbeCandidateVerifier {
  verify(options?: {
    readonly signal?: AbortSignal;
  }): Promise<GrokProbeCandidateIdentity>;
  cleanup?(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export interface GrokOfflineTrancheResult {
  readonly tranche: GrokOfflineTranche;
  readonly outputPath: string;
  readonly outputSha256: string;
  readonly outputBytes: number;
}

export class GrokOfflineTrancheFailure extends Error {
  readonly code: string;
  readonly diagnostics: Readonly<Record<string, unknown>>;

  constructor(code: string, diagnostics: Readonly<Record<string, unknown>>) {
    super(`${code}:${JSON.stringify(diagnostics)}`);
    this.name = "GrokOfflineTrancheFailure";
    this.code = code;
    this.diagnostics = Object.freeze({ ...diagnostics });
  }
}

export function serializeGrokOfflineCliFailure(error: unknown): string {
  const record =
    error instanceof GrokOfflineTrancheFailure
      ? {
          status: "failed",
          code: error.code,
          diagnostics: error.diagnostics,
        }
      : { status: "failed", code: "grok_probe_failed" };
  return `${JSON.stringify(record)}\n`;
}

interface CandidateLease {
  readonly privateStagedArtifact: boolean;
  readonly executablePath: string;
  readonly retainedFileDescriptor?: number;
  readonly expectedSha256?: string;
  readonly expectedBytes?: number;
  readonly identity: GrokProbeCandidateIdentity;
  reverify(options?: {
    readonly signal?: AbortSignal;
  }): Promise<GrokProbeCandidateIdentity>;
  cleanup(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

interface InstalledEvidencePublication {
  readonly result: GrokOfflineTrancheResult;
  rollback(): Promise<void>;
}

interface SandboxLaunchPlan {
  readonly launch: {
    readonly executablePath: string;
    readonly workingDirectory: string;
    readonly commandArguments: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly inheritedFileDescriptors: readonly Readonly<{
      readonly sourceFd: number;
      readonly targetFd: number;
      readonly disposition: "read_only_executable_bytes";
    }>[];
    readonly sensitiveValues: readonly string[];
  };
  readonly protocolAdmission: {
    readonly maximumOutboundFrames?: number;
    readonly maximumInboundFrames?: number;
    readonly allowedMethods: readonly string[];
    readonly authenticate: boolean;
    readonly providerCapacity: boolean;
    readonly filesystemCapability: boolean;
    readonly terminalCapability: boolean;
  };
  readonly writableMounts: {
    readonly home: string;
    readonly workspace: string;
  };
  finalize(options?: { readonly signal?: AbortSignal }): Promise<{
    readonly filesystem: unknown;
    readonly cleanup: { readonly temporaryRootRemoved: boolean };
  }>;
}

interface SandboxModule {
  readonly GROK_PROBE_MODES: {
    readonly O1_NO_INITIALIZE: string;
    readonly O2A_INITIALIZE_ONLY: string;
  };
  createGrokProbeSandboxLaunchPlan(
    input: Readonly<Record<string, unknown>>,
  ): Promise<SandboxLaunchPlan>;
}

interface SanitizerModule {
  sanitizeGrokEvidence(input: {
    readonly inputPath: string;
    readonly outputPath: string;
    readonly format: "json";
    readonly workspacePaths: readonly string[];
    readonly homePaths: readonly string[];
    readonly sensitiveValues: readonly string[];
    readonly secretCanaries: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<{ readonly outputSha256: string; readonly outputBytes: number }>;
}

interface PinnedReleaseModule {
  verifyPinnedGrokCandidateNonExecuting(options?: {
    readonly signal?: AbortSignal;
  }): Promise<GrokProbeCandidateIdentity>;
  stageVerifiedGrokCandidate(
    expectedOriginalIdentity: GrokProbeCandidateIdentity,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{
    readonly executablePath: string;
    readonly retainedFileDescriptor: number;
    readonly expectedSha256: string;
    readonly expectedBytes: number;
    readonly identity: GrokProbeCandidateIdentity;
    reverify(options?: {
      readonly signal?: AbortSignal;
    }): Promise<GrokProbeCandidateIdentity>;
    cleanup(options?: { readonly signal?: AbortSignal }): Promise<void>;
  }>;
}

// Standalone probe utilities intentionally have no application declarations.
// @ts-expect-error TypeScript does not synthesize declarations for .mjs scripts.
const sandbox = (await import("./grok-probe-sandbox.mjs")) as SandboxModule;
const sanitizer =
  // @ts-expect-error TypeScript does not synthesize declarations for .mjs scripts.
  (await import("./sanitize-grok-evidence.mjs")) as SanitizerModule;
const pinnedRelease =
  // @ts-expect-error TypeScript does not synthesize declarations for .mjs scripts.
  (await import("./pinned-grok-release.mjs")) as PinnedReleaseModule;

// Exact G0 probes keep the process alive long enough for startup-side effects
// or unsolicited traffic to become observable before controlled shutdown.
const DEFAULT_OBSERVATION_MILLISECONDS = 750;
const DEFAULT_DEADLINE_MILLISECONDS = 30_000;
const DEFAULT_EMERGENCY_CLEANUP_MILLISECONDS = 10_000;
const EXACT_GROK_ARGUMENTS = Object.freeze([
  "--no-auto-update",
  "agent",
  "--no-leader",
  "stdio",
]);
const INHERITED_READONLY_LAUNCHER = fileURLToPath(
  new URL("./inherited-readonly-launcher.mjs", import.meta.url),
);
const MAX_META_KEYS = 128;
const RESPONSE_META_KEYS = new Set([
  "grokShell",
  "defaultAuthMethodId",
  "x.ai/mcp/sdk",
  "currentWorkingDirectory",
  "agentVersion",
  "agentId",
  "agentInstanceId",
  "hostname",
  "modelState",
  "mcpServers",
  "mcpApps",
  "metadata",
  "availableCommands",
  "cancelRewind",
  "sessionRecap",
  "voiceMode",
  "x.ai/pluginDirs",
]);
const CAPABILITY_META_KEYS = new Set([
  "x.ai/fs_notify",
  "x.ai/hooks",
  "x.ai/capabilities",
]);
const NO_KNOWN_META_KEYS = new Set<string>();

export async function runGrokOfflineTranche(
  input: GrokOfflineTrancheInput,
): Promise<GrokOfflineTrancheResult> {
  validateInput(input);
  const deadline = new AbsoluteDeadline(
    input.deadlineMilliseconds ?? DEFAULT_DEADLINE_MILLISECONDS,
  );
  let lease: CandidateLease | undefined;
  let launchPlan: SandboxLaunchPlan | undefined;
  let channels: LocalEnvironmentChannelProvider | undefined;
  let processChannel: EnvironmentOwnedProcessChannel | undefined;
  let transport: FramedMessageTransport | undefined;
  let operationError: unknown;
  let sandboxResult:
    Awaited<ReturnType<SandboxLaunchPlan["finalize"]>> | undefined;
  let stagedIdentity: GrokProbeCandidateIdentity | undefined;
  let leaseCleaned = false;
  let result: GrokOfflineTrancheResult | undefined;
  let evidencePublication: InstalledEvidencePublication | undefined;

  try {
    const activeLease = await acquireCandidateLease(
      input,
      deadline,
      (value) => {
        lease = value;
      },
    );
    const activeLaunchPlan = await deadline.run(
      async () =>
        await sandbox.createGrokProbeSandboxLaunchPlan({
          signal: deadline.signal,
          mode:
            input.tranche === "o1_no_initialize"
              ? sandbox.GROK_PROBE_MODES.O1_NO_INITIALIZE
              : sandbox.GROK_PROBE_MODES.O2A_INITIALIZE_ONLY,
          executablePath: activeLease.executablePath,
          ...(activeLease.privateStagedArtifact
            ? {
                retainedFileDescriptor: activeLease.retainedFileDescriptor,
                expectedSha256: activeLease.expectedSha256,
                expectedBytes: activeLease.expectedBytes,
              }
            : {}),
          ...(input.scriptPath ? { scriptPath: input.scriptPath } : {}),
          ...(input.bubblewrapPath
            ? { bubblewrapPath: input.bubblewrapPath }
            : {}),
          arguments: input.scriptPath
            ? [...(input.arguments ?? [])]
            : [...EXACT_GROK_ARGUMENTS],
          environment: { ...(input.environment ?? {}) },
          sensitiveValues: [...(input.sensitiveValues ?? [])],
          limits: { ...(input.sandboxLimits ?? {}) },
        }),
      (value) => {
        launchPlan = value;
      },
    );
    assertLaunchDescriptorContribution(activeLaunchPlan, activeLease);
    channels = new LocalEnvironmentChannelProvider({
      scope: input.scope,
      executionEnvironmentId: input.scope.executionEnvironmentId,
      environment: {},
    });
    const processLaunch = await deadline.run(
      async () =>
        await resolveProbeProcessLaunch(activeLaunchPlan, activeLease),
    );
    const prepared = await deadline.run(
      async () =>
        await channels!.prepareOwnedProcess(input.scope, {
          executablePath: processLaunch.executablePath,
          workingDirectory: processLaunch.workingDirectory,
        }),
    );
    const transportLimits = resolvedTransportLimits(input);
    const activeProcessChannel = await deadline.run(
      async () =>
        await channels!.openOwnedProcess(
          input.scope,
          {
            prepared,
            arguments: processLaunch.arguments,
            environment: processLaunch.environment,
            cleanup: {
              gracefulCloseMilliseconds:
                transportLimits.gracefulCloseMilliseconds,
              terminateMilliseconds: transportLimits.terminateMilliseconds,
              killMilliseconds: transportLimits.killMilliseconds,
            },
          },
          deadline.signal,
        ),
      (value) => {
        processChannel = value;
      },
    );
    transport = new OwnedNdjsonStdioTransport({
      scope: input.scope,
      connectionGeneration: input.connectionGeneration,
      channel: activeProcessChannel,
      limits: transportLimits,
      sensitiveValues: activeLaunchPlan.launch.sensitiveValues,
      assuranceDiagnosticPrefix: "grok_probe_assurance",
      transportDiagnosticPrefix: "grok_probe_stdio",
    });
    const structural =
      input.tranche === "o1_no_initialize"
        ? await runO1(transport, input, activeLaunchPlan, deadline)
        : await runO2a(transport, input, activeLaunchPlan, deadline);
    const verifiedStagedIdentity = await deadline.run(
      async () => await activeLease.reverify({ signal: deadline.signal }),
      (identity) => {
        assertSameCandidate(activeLease.identity, identity);
        stagedIdentity = identity;
      },
    );
    const finalizedSandbox = await deadline.run(
      async () => await activeLaunchPlan.finalize({ signal: deadline.signal }),
      (finalized) => {
        sandboxResult = finalized;
      },
    );
    await deadline.run(
      async () => await activeLease.cleanup({ signal: deadline.signal }),
      () => {
        leaseCleaned = true;
      },
    );
    deadline.assertActive();

    const record = Object.freeze({
      ...structural,
      executableIdentity: {
        verifier: verifiedStagedIdentity.verifier,
        executableSha256: verifiedStagedIdentity.executableSha256,
        privateStagedArtifact: activeLease.privateStagedArtifact,
        stagedMountedFileIdentityStable: activeLease.privateStagedArtifact,
        fixtureMountedFileIdentityStable: !activeLease.privateStagedArtifact,
        mountIdentityMechanism: activeLease.privateStagedArtifact
          ? "retained_read_only_descriptor_inherited_bwrap_ro_bind_fd"
          : "fixture_verified_path",
        transportAssuranceSubject: activeLease.privateStagedArtifact
          ? "probe_inherited_descriptor_launcher"
          : "bubblewrap_carrier",
        productionGrokAssuranceClaimed: false,
      },
      filesystem: finalizedSandbox.filesystem,
      cleanup: {
        assuranceRevoked: true,
        sandboxTemporaryRootRemoved:
          finalizedSandbox.cleanup.temporaryRootRemoved === true,
        stagedExecutableRemoved: true,
        emergencyFailureCleanupUsed: false,
      },
      operationDeadline: {
        disposition: "completed_within_absolute_deadline",
        coveredThrough: "sanitized_evidence_atomic_install",
        absoluteDeadlineMilliseconds:
          input.deadlineMilliseconds ?? DEFAULT_DEADLINE_MILLISECONDS,
        ...(input.tranche === "o1_no_initialize"
          ? {
              quiescenceObservationMilliseconds: observationMilliseconds(input),
            }
          : {
              boundedObservationMilliseconds: observationMilliseconds(input),
            }),
      },
    });
    const publication = await deadline.run(
      async () =>
        await installSanitizedEvidence(
          record,
          input,
          activeLaunchPlan,
          deadline.signal,
        ),
      (installed) => {
        evidencePublication = installed;
      },
    );
    result = publication.result;
    deadline.assertActive();
  } catch (error) {
    operationError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (operationError !== undefined) {
      const emergency = new AbsoluteDeadline(
        input.emergencyCleanupMilliseconds ??
          DEFAULT_EMERGENCY_CLEANUP_MILLISECONDS,
        "grok_probe_emergency_cleanup_deadline_exceeded",
      );
      await emergency
        .run(async () => {
          if (evidencePublication) {
            await evidencePublication
              .rollback()
              .then(() => {
                evidencePublication = undefined;
              })
              .catch((error) => cleanupErrors.push(error));
          }
          if (
            transport &&
            isValidFramedTransportAssurance(transport.assurance)
          ) {
            await transport
              .close("grok_probe_failure_cleanup")
              .catch((error) => cleanupErrors.push(error));
            await transport.closed.catch((error) => cleanupErrors.push(error));
          } else if (processChannel) {
            await processChannel
              .close("grok_probe_construction_failure_cleanup")
              .catch((error) => cleanupErrors.push(error));
            await processChannel.closed.catch((error) =>
              cleanupErrors.push(error),
            );
          }
          channels?.close();
          if (lease && stagedIdentity === undefined) {
            await lease
              .reverify({ signal: emergency.signal })
              .then((identity) => {
                assertSameCandidate(lease!.identity, identity);
                stagedIdentity = identity;
              })
              .catch((error) => cleanupErrors.push(error));
          }
          if (launchPlan && sandboxResult === undefined) {
            await launchPlan
              .finalize({ signal: emergency.signal })
              .then((finalized) => {
                sandboxResult = finalized;
              })
              .catch((error) => cleanupErrors.push(error));
          }
          if (lease && !leaseCleaned) {
            await lease
              .cleanup({ signal: emergency.signal })
              .then(() => {
                leaseCleaned = true;
              })
              .catch((error) => cleanupErrors.push(error));
          }
        })
        .catch((error) => cleanupErrors.push(error));
      emergency.dispose();
    } else {
      channels?.close();
    }
    deadline.dispose();
    if (operationError instanceof GrokOfflineTrancheFailure) {
      operationError = new GrokOfflineTrancheFailure(
        operationError.code,
        Object.freeze({
          ...operationError.diagnostics,
          cleanup: {
            assuranceRevoked:
              transport !== undefined &&
              !isValidFramedTransportAssurance(transport.assurance),
            sandboxTemporaryRootRemoved:
              sandboxResult?.cleanup.temporaryRootRemoved === true,
            stagedExecutableRemoved: leaseCleaned,
            evidenceInstalled: false,
            emergencyCleanupCompleted: cleanupErrors.length === 0,
          },
        }),
      );
    }
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(
        cleanupErrors,
        "grok_probe_cleanup_failed",
      );
      operationError = operationError
        ? new AggregateError(
            [operationError, cleanupFailure],
            "grok_probe_operation_and_cleanup_failed",
          )
        : cleanupFailure;
    }
  }

  if (operationError !== undefined) throw operationError;
  if (!result) {
    throw new Error("grok_probe_completion_record_missing");
  }
  return result;
}

function assertLaunchDescriptorContribution(
  launchPlan: SandboxLaunchPlan,
  lease: CandidateLease,
): void {
  const descriptors = launchPlan.launch.inheritedFileDescriptors;
  if (lease.privateStagedArtifact) {
    if (
      descriptors.length !== 1 ||
      descriptors[0]?.sourceFd !== lease.retainedFileDescriptor ||
      descriptors[0]?.targetFd !== 3 ||
      descriptors[0]?.disposition !== "read_only_executable_bytes"
    ) {
      throw new Error("grok_probe_retained_descriptor_contribution_invalid");
    }
    return;
  }
  if (descriptors.length !== 0) {
    throw new Error("grok_probe_fixture_descriptor_contribution_invalid");
  }
}

async function resolveProbeProcessLaunch(
  launchPlan: SandboxLaunchPlan,
  lease: CandidateLease,
): Promise<{
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}> {
  const descriptors = launchPlan.launch.inheritedFileDescriptors;
  if (!lease.privateStagedArtifact) {
    if (descriptors.length !== 0) {
      throw new Error("grok_probe_fixture_descriptor_contribution_invalid");
    }
    return Object.freeze({
      executablePath: launchPlan.launch.executablePath,
      workingDirectory: launchPlan.launch.workingDirectory,
      arguments: launchPlan.launch.commandArguments,
      environment: launchPlan.launch.environment,
    });
  }
  const descriptor = descriptors[0];
  if (
    descriptors.length !== 1 ||
    descriptor === undefined ||
    descriptor.sourceFd !== lease.retainedFileDescriptor ||
    descriptor.targetFd !== 3 ||
    descriptor.disposition !== "read_only_executable_bytes" ||
    lease.expectedSha256 === undefined ||
    lease.expectedBytes === undefined
  ) {
    throw new Error("grok_probe_retained_descriptor_contribution_invalid");
  }
  const retained = await stat(`/proc/self/fd/${String(descriptor.sourceFd)}`, {
    bigint: true,
  });
  if (!retained.isFile()) {
    throw new Error("grok_probe_retained_descriptor_identity_invalid");
  }
  const configuration = JSON.stringify({
    arguments: launchPlan.launch.commandArguments,
    device: retained.dev.toString(),
    environment: launchPlan.launch.environment,
    executablePath: launchPlan.launch.executablePath,
    expectedBytes: lease.expectedBytes,
    expectedSha256: lease.expectedSha256,
    inode: retained.ino.toString(),
    sourcePath: lease.executablePath,
    workingDirectory: launchPlan.launch.workingDirectory,
  });
  return Object.freeze({
    executablePath: process.execPath,
    workingDirectory: launchPlan.launch.workingDirectory,
    arguments: Object.freeze([INHERITED_READONLY_LAUNCHER, configuration]),
    environment: Object.freeze({}),
  });
}

async function runO1(
  transport: FramedMessageTransport,
  input: GrokOfflineTrancheInput,
  launchPlan: SandboxLaunchPlan,
  deadline: AbsoluteDeadline,
): Promise<Readonly<Record<string, unknown>>> {
  assertAdmission(launchPlan, 0, []);
  const observation = await observeSilence(
    transport,
    observationMilliseconds(input),
    deadline,
  );
  if (observation !== "quiet") {
    throw new Error(
      observation === "frame"
        ? "grok_o1_unexpected_stdout"
        : "grok_o1_early_process_close",
    );
  }
  assertTransportCounts(transport, input, {
    inboundFrames: 0,
    outboundFrames: 0,
    stdoutBytes: 0,
  });
  await closeAndProveRevocation(transport, "grok_o1_complete", deadline);
  assertTransportCounts(transport, input, {
    inboundFrames: 0,
    outboundFrames: 0,
    stdoutBytes: 0,
    streamsDrained: true,
  });
  return Object.freeze({
    tranche: input.tranche,
    protocolAdmission: admissionRecord(launchPlan),
    observation: { quiet: true },
    transport: transportRecord(transport),
  });
}

async function runO2a(
  transport: FramedMessageTransport,
  input: GrokOfflineTrancheInput,
  launchPlan: SandboxLaunchPlan,
  deadline: AbsoluteDeadline,
): Promise<Readonly<Record<string, unknown>>> {
  assertAdmission(launchPlan, 1, ["initialize"], 2);
  const probe = createGrokInitializeOnlyProbe({
    transport,
    expectedScope: input.scope,
    expectedConnectionGeneration: input.connectionGeneration,
  });
  const response = await deadline.run(
    async () => await probe.initialize({ signal: deadline.signal }),
  );
  const capabilityProjection = projectInitializeResponse(response);
  const observation = await observeClosureOnly(
    transport,
    observationMilliseconds(input),
    deadline,
  );
  if (observation === "closed") {
    const closure = await transport.closed;
    throw new GrokOfflineTrancheFailure(
      "grok_o2a_early_process_close",
      Object.freeze({
        phase: "post_initialize_bounded_observation",
        initializeResponseAdmitted: true,
        initializeCapabilityProjectionCompleted: true,
        initialize: capabilityProjection,
        closureDisposition:
          closure.reason === "process_exit"
            ? "process_exit"
            : "transport_closed",
        transport: failureTransportRecord(transport),
        binding: bindingRecord(probe.diagnostics()),
      }),
    );
  }
  probe.assertQuiescentClean();
  const diagnostics = probe.diagnostics();
  const ignoredNotifications = assertIgnoredNotificationBounds(diagnostics);
  assertTransportCounts(transport, input, {
    inboundFrames: 1 + ignoredNotifications,
    outboundFrames: 1,
  });
  await deadline.run(async () => await probe.close("grok_o2a_complete"));
  await deadline.run(async () => await transport.closed);
  assertAssuranceRevoked(transport);
  assertTransportCounts(transport, input, {
    inboundFrames: 1 + ignoredNotifications,
    outboundFrames: 1,
    streamsDrained: true,
  });
  return Object.freeze({
    tranche: input.tranche,
    protocolAdmission: admissionRecord(launchPlan),
    observation: {
      initializeCompleted: true,
      boundedObservationCompleted: true,
      boundedObservationMilliseconds: observationMilliseconds(input),
      ignoredNotifications,
      ignoredNotificationBytes: diagnostics.binding.ignoredNotificationBytes,
    },
    initialize: capabilityProjection,
    binding: bindingRecord(diagnostics),
    transport: transportRecord(transport),
  });
}

function projectInitializeResponse(
  response: InitializeResponse,
): Readonly<Record<string, unknown>> {
  const capabilities = response.agentCapabilities;
  const session = capabilities?.sessionCapabilities;
  const prompt = capabilities?.promptCapabilities;
  const mcp = capabilities?.mcpCapabilities;
  const authKinds = (response.authMethods ?? [])
    .map((method) => ("type" in method ? method.type : "agent"))
    .sort();
  if (
    authKinds.some(
      (kind) => kind !== "agent" && kind !== "env_var" && kind !== "terminal",
    )
  ) {
    throw new Error("grok_probe_auth_kind_invalid");
  }
  return Object.freeze({
    protocolVersion: response.protocolVersion,
    agentInfoPresent: response.agentInfo != null,
    capabilities: {
      present: capabilities !== undefined,
      loadSession: capabilities?.loadSession === true,
      promptCapabilities: {
        present: prompt !== undefined,
        image: prompt?.image === true,
        audio: prompt?.audio === true,
        embeddedContext: prompt?.embeddedContext === true,
      },
      mcp: {
        present: mcp !== undefined,
        http: mcp?.http === true,
        sse: mcp?.sse === true,
        acp: mcp?.acp === true,
      },
      session: {
        present: session !== undefined,
        list: session?.list != null,
        delete: session?.delete != null,
        additionalDirectories: session?.additionalDirectories != null,
        fork: session?.fork != null,
        resume: session?.resume != null,
        close: session?.close != null,
      },
      auth: {
        present: capabilities?.auth !== undefined,
        logout: capabilities?.auth?.logout != null,
      },
      providers: capabilities?.providers != null,
      nes: capabilities?.nes != null,
      positionEncoding: capabilities?.positionEncoding != null,
    },
    authentication: { methodCount: authKinds.length, kinds: authKinds },
    metaKeys: {
      response: safeMetaInventory(response._meta, RESPONSE_META_KEYS),
      capabilities: safeMetaInventory(
        capabilities?._meta,
        CAPABILITY_META_KEYS,
      ),
      promptCapabilities: safeMetaInventory(prompt?._meta, NO_KNOWN_META_KEYS),
      mcp: safeMetaInventory(mcp?._meta, NO_KNOWN_META_KEYS),
      session: safeMetaInventory(session?._meta, NO_KNOWN_META_KEYS),
      sessionList: safeMetaInventory(session?.list?._meta, NO_KNOWN_META_KEYS),
      sessionDelete: safeMetaInventory(
        session?.delete?._meta,
        NO_KNOWN_META_KEYS,
      ),
      sessionAdditionalDirectories: safeMetaInventory(
        session?.additionalDirectories?._meta,
        NO_KNOWN_META_KEYS,
      ),
      sessionFork: safeMetaInventory(session?.fork?._meta, NO_KNOWN_META_KEYS),
      sessionResume: safeMetaInventory(
        session?.resume?._meta,
        NO_KNOWN_META_KEYS,
      ),
      sessionClose: safeMetaInventory(
        session?.close?._meta,
        NO_KNOWN_META_KEYS,
      ),
      auth: safeMetaInventory(capabilities?.auth?._meta, NO_KNOWN_META_KEYS),
      authLogout: safeMetaInventory(
        capabilities?.auth?.logout?._meta,
        NO_KNOWN_META_KEYS,
      ),
      providers: safeMetaInventory(
        capabilities?.providers?._meta,
        NO_KNOWN_META_KEYS,
      ),
      nes: safeMetaInventory(capabilities?.nes?._meta, NO_KNOWN_META_KEYS),
    },
  });
}

function safeMetaInventory(
  meta: Readonly<Record<string, unknown>> | null | undefined,
  knownKeys: ReadonlySet<string>,
): Readonly<{
  encounteredKnownKeys: readonly string[];
  unknownKeyCount: number;
}> {
  const keys = Object.keys(meta ?? {}).sort();
  if (keys.length > MAX_META_KEYS) {
    throw new Error("grok_probe_meta_key_inventory_invalid");
  }
  return Object.freeze({
    encounteredKnownKeys: keys.filter((key) => knownKeys.has(key)),
    unknownKeyCount: keys.filter((key) => !knownKeys.has(key)).length,
  });
}

function assertTransportCounts(
  transport: FramedMessageTransport,
  input: GrokOfflineTrancheInput,
  expected: {
    readonly inboundFrames: number;
    readonly outboundFrames: number;
    readonly stdoutBytes?: number;
    readonly streamsDrained?: boolean;
  },
): void {
  const diagnostics = stdioDiagnostics(transport);
  if (
    diagnostics.inboundFramesRead !== expected.inboundFrames ||
    diagnostics.outboundFramesAccepted !== expected.outboundFrames ||
    diagnostics.outboundFramesWritten !== expected.outboundFrames ||
    (expected.stdoutBytes !== undefined &&
      diagnostics.stdoutBytesRead !== expected.stdoutBytes) ||
    (expected.streamsDrained !== undefined &&
      diagnostics.streamsDrained !== expected.streamsDrained)
  ) {
    throw new Error("grok_probe_transport_counts_invalid");
  }
}

function resolvedTransportLimits(
  input: GrokOfflineTrancheInput,
): OwnedNdjsonStdioLimits {
  return {
    maximumFrameBytes: input.transportLimits?.maximumFrameBytes ?? 64 * 1024,
    maximumInboundQueueBytes:
      input.transportLimits?.maximumInboundQueueBytes ?? 128 * 1024,
    maximumInboundQueueFrames:
      input.transportLimits?.maximumInboundQueueFrames ?? 4,
    maximumOutboundQueueBytes:
      input.transportLimits?.maximumOutboundQueueBytes ?? 128 * 1024,
    maximumOutboundQueueFrames:
      input.transportLimits?.maximumOutboundQueueFrames ?? 4,
    maximumStderrTailBytes:
      input.transportLimits?.maximumStderrTailBytes ?? 4 * 1024,
    gracefulCloseMilliseconds:
      input.transportLimits?.gracefulCloseMilliseconds ?? 250,
    terminateMilliseconds: input.transportLimits?.terminateMilliseconds ?? 500,
    killMilliseconds: input.transportLimits?.killMilliseconds ?? 1_000,
  };
}

async function acquireCandidateLease(
  input: GrokOfflineTrancheInput,
  deadline: AbsoluteDeadline,
  register: (lease: CandidateLease) => void,
): Promise<CandidateLease> {
  if (input.scriptPath === undefined) {
    const original = await deadline.run(
      async () =>
        await pinnedRelease.verifyPinnedGrokCandidateNonExecuting({
          signal: deadline.signal,
        }),
    );
    return await deadline.run(async () => {
      const staged = await pinnedRelease.stageVerifiedGrokCandidate(original, {
        signal: deadline.signal,
      });
      return Object.freeze({ ...staged, privateStagedArtifact: true });
    }, register);
  }
  const verifier = input.candidateVerifier!;
  const identity = await deadline.run(
    async () => await verifier.verify({ signal: deadline.signal }),
  );
  if (
    identity.verifier !== "fixture_callback" ||
    identity.executablePath !== input.executablePath
  ) {
    throw new Error("grok_probe_fixture_candidate_identity_invalid");
  }
  const lease = Object.freeze({
    privateStagedArtifact: false,
    executablePath: identity.executablePath,
    identity,
    reverify: async (options?: { readonly signal?: AbortSignal }) =>
      await verifier.verify(options),
    cleanup: async (options?: { readonly signal?: AbortSignal }) => {
      if (verifier.cleanup) return await verifier.cleanup(options);
      if (options?.signal?.aborted) throw options.signal.reason;
    },
  });
  register(lease);
  return lease;
}

async function installSanitizedEvidence(
  record: Readonly<Record<string, unknown>>,
  input: GrokOfflineTrancheInput,
  launchPlan: SandboxLaunchPlan,
  signal: AbortSignal,
): Promise<InstalledEvidencePublication> {
  if (signal.aborted) throw signal.reason;
  const rawDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sedes-grok-offline-tranche-"),
  );
  const rawPath = path.join(rawDirectory, "record.json");
  try {
    await writeFile(rawPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const sanitized = await sanitizer.sanitizeGrokEvidence({
      inputPath: rawPath,
      outputPath: path.resolve(input.outputPath),
      format: "json",
      workspacePaths: [launchPlan.writableMounts.workspace],
      homePaths: [launchPlan.writableMounts.home],
      sensitiveValues: [
        ...launchPlan.launch.sensitiveValues,
        ...(input.sensitiveValues ?? []),
      ],
      secretCanaries: launchPlan.launch.sensitiveValues,
      signal,
    });
    const result = Object.freeze({
      tranche: input.tranche,
      outputPath: path.resolve(input.outputPath),
      outputSha256: sanitized.outputSha256,
      outputBytes: sanitized.outputBytes,
    });
    const identity = await evidenceFileIdentity(result.outputPath);
    return Object.freeze({
      result,
      rollback: async () => {
        const current = await lstat(result.outputPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        });
        if (!current) return;
        if (
          !current.isFile() ||
          current.dev !== identity.device ||
          current.ino !== identity.inode
        ) {
          throw new Error("grok_probe_evidence_rollback_identity_changed");
        }
        await unlink(result.outputPath);
      },
    });
  } finally {
    await rm(rawDirectory, { recursive: true, force: true });
  }
}

async function evidenceFileIdentity(
  outputPath: string,
): Promise<Readonly<{ device: number; inode: number }>> {
  const metadata = await lstat(outputPath);
  if (!metadata.isFile()) {
    throw new Error("grok_probe_evidence_install_identity_invalid");
  }
  return Object.freeze({ device: metadata.dev, inode: metadata.ino });
}

async function observeSilence(
  transport: FramedMessageTransport,
  milliseconds: number,
  deadline: AbsoluteDeadline,
): Promise<"quiet" | "frame" | "closed"> {
  const iterator = transport.frames[Symbol.asyncIterator]();
  return await deadline.run(
    async () =>
      await Promise.race([
        iterator
          .next()
          .then((next) =>
            next.done ? ("closed" as const) : ("frame" as const),
          ),
        transport.closed.then(() => "closed" as const),
        delay(milliseconds).then(() => "quiet" as const),
      ]),
  );
}

async function observeClosureOnly(
  transport: FramedMessageTransport,
  milliseconds: number,
  deadline: AbsoluteDeadline,
): Promise<"quiet" | "closed"> {
  return await deadline.run(
    async () =>
      await Promise.race([
        transport.closed.then(() => "closed" as const),
        delay(milliseconds).then(() => "quiet" as const),
      ]),
  );
}

async function closeAndProveRevocation(
  transport: FramedMessageTransport,
  reason: string,
  deadline: AbsoluteDeadline,
): Promise<void> {
  await deadline.run(async () => await transport.close(reason));
  await deadline.run(async () => await transport.closed);
  assertAssuranceRevoked(transport);
}

function assertAssuranceRevoked(transport: FramedMessageTransport): void {
  if (isValidFramedTransportAssurance(transport.assurance)) {
    throw new Error("grok_probe_transport_assurance_not_revoked");
  }
}

function assertAdmission(
  launchPlan: SandboxLaunchPlan,
  maximumOutboundFrames: number,
  allowedMethods: readonly string[],
  maximumInboundFrames?: number,
): void {
  const admission = launchPlan.protocolAdmission;
  if (
    admission.maximumOutboundFrames !== maximumOutboundFrames ||
    admission.maximumInboundFrames !== maximumInboundFrames ||
    admission.authenticate ||
    admission.providerCapacity ||
    admission.filesystemCapability ||
    admission.terminalCapability ||
    admission.allowedMethods.length !== allowedMethods.length ||
    admission.allowedMethods.some(
      (method, index) => method !== allowedMethods[index],
    )
  ) {
    throw new Error("grok_probe_protocol_admission_invalid");
  }
}

function admissionRecord(
  launchPlan: SandboxLaunchPlan,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    maximumOutboundFrames: launchPlan.protocolAdmission.maximumOutboundFrames,
    ...(launchPlan.protocolAdmission.maximumInboundFrames !== undefined
      ? {
          maximumInboundFrames:
            launchPlan.protocolAdmission.maximumInboundFrames,
        }
      : {}),
    allowedMethods: [...launchPlan.protocolAdmission.allowedMethods],
    authenticate: launchPlan.protocolAdmission.authenticate,
    providerCapacity: launchPlan.protocolAdmission.providerCapacity,
    filesystemCapability: launchPlan.protocolAdmission.filesystemCapability,
    terminalCapability: launchPlan.protocolAdmission.terminalCapability,
  });
}

function bindingRecord(
  diagnostics: GrokProbeDiagnostics,
): Readonly<Record<string, unknown>> {
  const binding = diagnostics.binding;
  return Object.freeze({
    initialized: binding.initialized,
    pendingRequests: binding.pendingRequests,
    activeReverseRequests: binding.activeReverseRequests,
    activeNotifications: binding.activeNotifications,
    pendingNotifications: binding.pendingNotifications,
    notificationOrderingKeys: binding.notificationOrderingKeys,
    ignoredNotifications: binding.ignoredNotifications,
    ignoredNotificationBytes: binding.ignoredNotificationBytes,
    deniedReverseRequests: binding.deniedReverseRequests,
    handlerFailures: binding.handlerFailures,
    rejectedLateResponses: binding.rejectedLateResponses,
    protocolFailures: binding.protocolFailures,
    captured: diagnostics.captured,
    droppedCaptures: diagnostics.droppedCaptures,
    captureFailures: diagnostics.captureFailures,
    deniedExtensionReverseRequests: diagnostics.deniedExtensionReverseRequests,
  });
}

function assertIgnoredNotificationBounds(
  diagnostics: GrokProbeDiagnostics,
): number {
  const count = diagnostics.binding.ignoredNotifications;
  const bytes = diagnostics.binding.ignoredNotificationBytes;
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 1 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > 64 * 1024 ||
    (count === 0) !== (bytes === 0)
  ) {
    throw new Error("grok_o2a_ignored_notification_bounds_invalid");
  }
  return count;
}

function transportRecord(
  transport: FramedMessageTransport,
): Readonly<Record<string, unknown>> {
  const diagnostics = stdioDiagnostics(transport);
  return Object.freeze({
    assuranceKind: transport.assurance.kind,
    assuranceRevoked: !isValidFramedTransportAssurance(transport.assurance),
    stdoutBytesRead: diagnostics.stdoutBytesRead,
    stderrBytesRead: diagnostics.stderrBytesRead,
    inboundFramesRead: diagnostics.inboundFramesRead,
    outboundFramesAccepted: diagnostics.outboundFramesAccepted,
    outboundFramesWritten: diagnostics.outboundFramesWritten,
    streamsDrained: diagnostics.streamsDrained,
  });
}

function failureTransportRecord(
  transport: FramedMessageTransport,
): Readonly<Record<string, unknown>> {
  const diagnostics = stdioDiagnostics(transport);
  return Object.freeze({
    ...transportRecord(transport),
    processExitDisposition: diagnostics.processExitDisposition,
  });
}

function stdioDiagnostics(
  transport: FramedMessageTransport,
): OwnedNdjsonStdioDiagnostics {
  const diagnostics = (
    transport as FramedMessageTransport & {
      diagnostics?: () => OwnedNdjsonStdioDiagnostics;
    }
  ).diagnostics;
  if (!diagnostics) throw new Error("grok_probe_stdio_diagnostics_missing");
  return diagnostics.call(transport);
}

function assertSameCandidate(
  initial: GrokProbeCandidateIdentity,
  current: GrokProbeCandidateIdentity,
): void {
  if (
    initial.verifier !== current.verifier ||
    initial.executablePath !== current.executablePath ||
    initial.executableSha256 !== current.executableSha256 ||
    initial.immutableIdentity !== current.immutableIdentity
  ) {
    throw new Error("grok_probe_candidate_changed");
  }
}

function observationMilliseconds(input: GrokOfflineTrancheInput): number {
  return input.observationMilliseconds ?? DEFAULT_OBSERVATION_MILLISECONDS;
}

function validateInput(input: GrokOfflineTrancheInput): void {
  if (
    input.tranche !== "o1_no_initialize" &&
    input.tranche !== "o2a_initialize_only"
  ) {
    throw new TypeError("grok_probe_tranche_invalid");
  }
  if (
    !Number.isSafeInteger(input.connectionGeneration) ||
    input.connectionGeneration <= 0
  ) {
    throw new TypeError("grok_probe_connection_generation_invalid");
  }
  if (!path.isAbsolute(input.outputPath)) {
    throw new TypeError("grok_probe_output_path_invalid");
  }
  const observation = observationMilliseconds(input);
  const deadline = input.deadlineMilliseconds ?? DEFAULT_DEADLINE_MILLISECONDS;
  const emergencyCleanup =
    input.emergencyCleanupMilliseconds ??
    DEFAULT_EMERGENCY_CLEANUP_MILLISECONDS;
  if (
    !Number.isSafeInteger(observation) ||
    observation < 10 ||
    observation > 10_000 ||
    !Number.isSafeInteger(deadline) ||
    deadline < observation ||
    deadline > 120_000 ||
    !Number.isSafeInteger(emergencyCleanup) ||
    emergencyCleanup < 10 ||
    emergencyCleanup > DEFAULT_EMERGENCY_CLEANUP_MILLISECONDS
  ) {
    throw new TypeError("grok_probe_time_bound_invalid");
  }
  const fixture = input.scriptPath !== undefined;
  if (
    fixture !== (input.candidateVerifier !== undefined) ||
    fixture !== (input.executablePath !== undefined) ||
    (fixture && !path.isAbsolute(input.executablePath!)) ||
    (!fixture &&
      (input.arguments !== undefined ||
        input.environment !== undefined ||
        input.sensitiveValues !== undefined ||
        input.observationMilliseconds !== undefined ||
        input.deadlineMilliseconds !== undefined ||
        input.emergencyCleanupMilliseconds !== undefined ||
        input.transportLimits !== undefined ||
        input.sandboxLimits !== undefined ||
        input.bubblewrapPath !== undefined))
  ) {
    throw new TypeError(
      fixture
        ? "grok_probe_candidate_mode_invalid"
        : "grok_probe_exact_policy_override_forbidden",
    );
  }
}

export class AbsoluteDeadline {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #timer: NodeJS.Timeout;

  constructor(
    milliseconds: number,
    diagnostic = "grok_probe_deadline_exceeded",
  ) {
    this.signal = this.#controller.signal;
    this.#timer = setTimeout(() => {
      this.#controller.abort(new Error(diagnostic));
    }, milliseconds);
  }

  async run<T>(
    start: () => Promise<T>,
    registerFulfilled?: (value: T) => void,
  ): Promise<T> {
    this.assertActive();
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(this.signal.reason);
    this.signal.addEventListener("abort", onAbort, { once: true });
    let operation: Promise<T> | undefined;
    try {
      // Close the timer/listener setup race before starting new authority.
      this.assertActive();
      operation = start().then((value) => {
        // Registration is part of operation settlement. If abort wins the
        // outer race at the same boundary, the joined operation still places
        // acquired authority/publication under caller cleanup ownership.
        registerFulfilled?.(value);
        return value;
      });
      return await Promise.race([operation, aborted]);
    } catch (error) {
      if (!this.signal.aborted) throw error;
      // Every abort-aware operation must settle before authority or temporary
      // resources can leave this tranche's ownership boundary.
      await operation?.catch(() => undefined);
      throw this.signal.reason;
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  assertActive(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }

  dispose(): void {
    clearTimeout(this.#timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseCli(argv: readonly string[]): {
  readonly tranche: GrokOfflineTranche;
  readonly outputPath: string;
} {
  if (argv.length !== 4) {
    throw new Error("grok_probe_cli_arguments_invalid");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      (key !== "--tranche" && key !== "--output") ||
      value === undefined ||
      values.has(key)
    ) {
      throw new Error("grok_probe_cli_arguments_invalid");
    }
    values.set(key, value);
  }
  const tranche = values.get("--tranche");
  const outputPath = values.get("--output");
  if (
    (tranche !== "o1_no_initialize" && tranche !== "o2a_initialize_only") ||
    outputPath === undefined ||
    !path.isAbsolute(outputPath) ||
    values.size !== 2
  ) {
    throw new Error("grok_probe_cli_arguments_invalid");
  }
  return { tranche, outputPath };
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    const cli = parseCli(process.argv.slice(2));
    const result = await runGrokOfflineTranche({
      tranche: cli.tranche,
      outputPath: cli.outputPath,
      scope: {
        tenantId: "grok-g0-probe",
        principalId: "grok-g0-probe",
        backendInstanceId: "grok-g0-probe",
        executionEnvironmentId: "grok-g0-probe",
      },
      connectionGeneration: 1,
    });
    process.stdout.write(
      `${JSON.stringify({
        tranche: result.tranche,
        outputPath: result.outputPath,
        outputSha256: result.outputSha256,
        outputBytes: result.outputBytes,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(serializeGrokOfflineCliFailure(error));
    process.exitCode = 1;
  }
}
