import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import {
  GROK_ACP_REVIEWED_PROFILE,
  admitGrokRuntimeVersion,
} from "../../src/server/backends/grok/grok-release-guard.js";
import {
  OwnedNdjsonStdioTransportFactory,
  type OwnedNdjsonStdioTransport,
} from "../../src/server/provider-protocol/transport/owned-ndjson-stdio-transport.js";
import { isValidFramedTransportAssurance } from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import { GrokLiveReadonlyConnection } from "./grok-live-readonly-profile.js";
import { buildDisposableGrokProbeChildEnvironment } from "./grok-probe-child-environment.js";

const GROK_READONLY_PROBE_ARGUMENTS = Object.freeze([
  "--no-auto-update",
  "--permission-mode",
  "default",
  "--disable-web-search",
  "--no-subagents",
  "--no-ask-user",
  "--sandbox",
  "workspace",
  "agent",
  "--no-leader",
  "stdio",
]);

interface PinnedReleaseModule {
  readonly grokCandidateRelease: {
    readonly release: string;
    readonly build: string;
    readonly executableSha256: string;
    readonly executableBytes: number;
  };
  verifyPinnedGrokCandidateNonExecuting(options?: {
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly verifier: "pinned_grok_1.0.4";
    readonly executablePath: string;
    readonly executableSha256: string;
    readonly immutableIdentity: string;
  }>;
  stageVerifiedGrokCandidate(
    identity: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{
    readonly executablePath: string;
    readonly expectedSha256: string;
    reverify(options?: { readonly signal?: AbortSignal }): Promise<unknown>;
    cleanup(options?: { readonly signal?: AbortSignal }): Promise<void>;
  }>;
}

const pinned = (await import(
  // @ts-expect-error Standalone probe helper intentionally has no declaration.
  "./pinned-grok-release.mjs"
)) as PinnedReleaseModule;

const LIVE_OPT_IN = "SEDES_GROK_LIVE_READONLY";
const DEADLINE_MILLISECONDS = 45_000;
const CLEANUP_DEADLINE_MILLISECONDS = 10_000;
const MAXIMUM_CREDENTIAL_BYTES = 64 * 1_024;
const CREDENTIAL_FRESHNESS_MILLISECONDS =
  5 * 60_000 + DEADLINE_MILLISECONDS + 15_000;
const SCOPE = Object.freeze({
  tenantId: "grok-live-readonly-tenant",
  principalId: "grok-live-readonly-principal",
  backendInstanceId: "grok-live-readonly-backend",
  executionEnvironmentId: "grok-live-readonly-local",
});

export interface GrokLiveReadonlyGateResult {
  readonly outputPath: string;
  readonly outputSha256: string;
  readonly outputBytes: number;
}

export interface CredentialSourceIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

export interface OutputDirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

export interface OutputLeafDisposition {
  readonly identity: OutputDirectoryIdentity;
  readonly createdByRun: boolean;
}

export interface GrokLocalCredentialContinuity {
  readonly principalId: string;
  readonly principalType?: string;
  readonly teamId?: string;
  readonly organizationId?: string;
}

export async function runGrokLiveReadonlyGate(input: {
  readonly credentialSource: string;
  readonly outputPath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Fixture-only: exact live command omits every override. */
  readonly testTransportFactory?: (
    scope: typeof SCOPE,
    signal: AbortSignal,
    context: Readonly<{ grokHome: string; workspace: string }>,
  ) => Promise<OwnedNdjsonStdioTransport>;
}): Promise<GrokLiveReadonlyGateResult> {
  if (!input.testTransportFactory && input.environment !== undefined) {
    throw new Error("grok_live_readonly_custom_live_environment_forbidden");
  }
  const environment = input.environment ?? process.env;
  if (environment[LIVE_OPT_IN] !== "1") {
    throw new Error("grok_live_readonly_explicit_opt_in_required");
  }
  assertAbsoluteRegularTarget(input.credentialSource, input.outputPath);
  const deadline = new AbsoluteDeadline(DEADLINE_MILLISECONDS);
  let temporaryRoot: string | undefined;
  let staged:
    | Awaited<ReturnType<PinnedReleaseModule["stageVerifiedGrokCandidate"]>>
    | undefined;
  let channels: LocalEnvironmentChannelProvider | undefined;
  let transport: OwnedNdjsonStdioTransport | undefined;
  let connection: GrokLiveReadonlyConnection | undefined;
  let credential: Awaited<ReturnType<typeof readCredentialSource>> | undefined;
  let prepared:
    | Awaited<
        ReturnType<LocalEnvironmentChannelProvider["prepareOwnedProcess"]>
      >
    | undefined;
  let success = false;
  let completed: GrokLiveReadonlyGateResult | undefined;
  let operationFailure: unknown;
  let credentialSourceIdentity: CredentialSourceIdentity | undefined;
  const publication: { dev?: number; ino?: number } = {};
  let outputDirectories: readonly OutputDirectoryIdentity[] | undefined;
  try {
    const activeOutputDirectories = await deadline.run(
      async () =>
        await preflightOutputTarget(input.outputPath, deadline.signal),
      (value) => {
        outputDirectories = value;
      },
    );
    const activeCredential = await deadline.run(
      async () =>
        await readCredentialSource(input.credentialSource, deadline.signal),
      (value) => {
        credential = value;
        credentialSourceIdentity = value.sourceIdentity;
      },
    );
    const activeTemporaryRoot = await deadline.run(
      async () =>
        await mkdtemp(path.join(os.tmpdir(), "sedes-grok-live-readonly-")),
      (value) => {
        temporaryRoot = value;
      },
    );
    await deadline.run(async () => await chmod(activeTemporaryRoot, 0o700));
    const grokHome = path.join(activeTemporaryRoot, "grok-home");
    const processHome = path.join(activeTemporaryRoot, "process-home");
    const workspace = path.join(activeTemporaryRoot, "workspace");
    await deadline.run(
      async () =>
        await Promise.all(
          [grokHome, processHome, workspace].map(async (directory) => {
            deadline.assertActive();
            await mkdir(directory, { mode: 0o700 });
            deadline.assertActive();
            await chmod(directory, 0o700);
          }),
        ),
    );
    await deadline.run(async () => {
      await writeFile(
        path.join(grokHome, "auth.json"),
        activeCredential.stagedBytes,
        {
          mode: 0o600,
          flag: "wx",
          signal: deadline.signal,
        },
      );
    });
    await deadline.run(
      async () => await writeProbePolicy(grokHome, deadline.signal),
    );
    await deadline.run(
      async () => await assertNoSystemGrokPolicy(deadline.signal),
    );

    if (input.testTransportFactory) {
      const activeTransport = await deadline.run(
        async () =>
          await input.testTransportFactory!(SCOPE, deadline.signal, {
            grokHome,
            workspace,
          }),
        (value) => {
          transport = value;
        },
      );
      transport = activeTransport;
    } else {
      if (environment.GROK_BINARY === undefined) {
        throw new Error("grok_live_readonly_exact_binary_required");
      }
      admitGrokRuntimeVersion(
        pinned.grokCandidateRelease.release,
        pinned.grokCandidateRelease.build,
      );
      const verified = await deadline.run(
        async () =>
          await pinned.verifyPinnedGrokCandidateNonExecuting({
            signal: deadline.signal,
          }),
      );
      const activeStaged = await deadline.run(
        async () =>
          await pinned.stageVerifiedGrokCandidate(verified, {
            signal: deadline.signal,
          }),
        (value) => {
          staged = value;
        },
      );
      const childEnvironment = Object.freeze({
        ...buildDisposableGrokProbeChildEnvironment(
          { LANG: "C.UTF-8", PATH: "/usr/bin:/bin", TZ: "UTC" },
          grokHome,
          processHome,
        ),
        GROK_MANAGED_CONFIG: "0",
      });
      channels = new LocalEnvironmentChannelProvider({
        scope: SCOPE,
        executionEnvironmentId: SCOPE.executionEnvironmentId,
        environment,
      });
      const activePrepared = await deadline.run(
        async () =>
          await channels!.prepareOwnedProcess(SCOPE, {
            executablePath: activeStaged.executablePath,
            workingDirectory: workspace,
          }),
        (value) => {
          prepared = value;
        },
      );
      const factory = new OwnedNdjsonStdioTransportFactory({
        scope: SCOPE,
        channels,
        process: activePrepared,
        environment: childEnvironment,
        commandArguments: GROK_READONLY_PROBE_ARGUMENTS,
        sensitiveValues: [
          grokHome,
          processHome,
          workspace,
          input.credentialSource,
          ...activeCredential.sensitiveValues,
        ],
        limits: {
          maximumFrameBytes: 1_048_576,
          maximumInboundQueueBytes: 1_048_576,
          maximumOutboundQueueBytes: 1_048_576,
          maximumInboundQueueFrames: 8,
          maximumOutboundQueueFrames: 8,
          maximumStderrTailBytes: 8_192,
          gracefulCloseMilliseconds: 500,
          terminateMilliseconds: 1_000,
          killMilliseconds: 1_000,
        },
        assuranceDiagnosticPrefix: "grok_live_readonly",
        transportDiagnosticPrefix: "grok_live_readonly_stdio",
      });
      const activeTransport = await deadline.run(
        async () => await factory.open(SCOPE, 1, deadline.signal),
        (value) => {
          transport = value;
        },
      );
      transport = activeTransport;
    }

    connection = new GrokLiveReadonlyConnection({
      transport,
      expectedScope: SCOPE,
      connectionGeneration: 1,
    });
    const result = await deadline.run(
      async () =>
        await connection!.run(
          { cwd: workspace },
          { cancellationSignal: deadline.signal, deadlineMilliseconds: 15_000 },
        ),
    );
    await deadline.run(
      async () =>
        await assertCredentialSourceUnchanged(
          input.credentialSource,
          activeCredential.sourceIdentity,
          deadline.signal,
        ),
    );
    if (
      result.sessions.sessions.length !== 0 ||
      result.sessions.nextCursor != null
    ) {
      throw new Error("grok_live_readonly_disposable_store_not_empty");
    }
    const evidenceWithoutCleanup = {
      schemaVersion: 1,
      tranche: "L-readonly-local-credential-empty-session-list",
      release: {
        version: pinned.grokCandidateRelease.release,
        build: pinned.grokCandidateRelease.build,
        executableSha256: pinned.grokCandidateRelease.executableSha256,
        profile: GROK_ACP_REVIEWED_PROFILE,
      },
      authority: {
        credentialFilesStaged: ["auth.json"],
        localCredentialContinuity: {
          singleFreshOidcEntry: true,
          stablePrincipalIdentifierPresent: true,
          contextFieldBasis: authorityBasis(activeCredential.continuity),
          originalCredentialSourceUnchanged: true,
        },
        inheritedProviderOrSedesEnvironment: false,
        childPathProfile: "fixed-system-bin",
        managedConfigFetch: false,
        filesystemCapability: false,
        terminalCapability: false,
        sessionModelToolMutations: false,
        authenticationNetworkMayRefresh: true,
        credentialFreshAtProbeStart: true,
        stagedCredentialMayRotate: true,
      },
      initialize: {
        protocolVersion: result.initialize.protocolVersion,
        cachedTokenAdvertised:
          result.initialize.authMethods?.some(
            (method) => method.id === "cached_token",
          ) === true,
        loadSession: result.initialize.agentCapabilities?.loadSession === true,
        sessionList:
          result.initialize.agentCapabilities?.sessionCapabilities?.list !=
          null,
        sessionResume:
          result.initialize.agentCapabilities?.sessionCapabilities?.resume !=
          null,
        sessionClose:
          result.initialize.agentCapabilities?.sessionCapabilities?.close !=
          null,
      },
      authentication: {
        method: "cached_token",
        completed: true,
      },
      sessionList: {
        requestedExactDisposableCwd: true,
        sessions: 0,
        nextCursorPresent: result.sessions.nextCursor != null,
      },
      binding: payloadFreeBindingDiagnostics(result.diagnostics),
      limits: {
        absoluteDeadlineMilliseconds: DEADLINE_MILLISECONDS,
        requestDeadlineMilliseconds: 15_000,
        maximumFrameBytes: 1_048_576,
      },
    };

    const cleanup = await closeOwned(
      connection,
      transport,
      channels,
      staged,
      temporaryRoot,
      deadline,
    );
    connection = undefined;
    transport = undefined;
    channels = undefined;
    staged = undefined;
    temporaryRoot = undefined;
    await deadline.run(
      async () =>
        await assertCredentialSourceUnchanged(
          input.credentialSource,
          activeCredential.sourceIdentity,
          deadline.signal,
        ),
    );
    deadline.assertActive();
    const output = await deadline.run(
      async () =>
        await installEvidence(
          input.outputPath,
          {
            ...evidenceWithoutCleanup,
            transport: cleanup.transport,
            cleanup: cleanup.disposition,
          },
          deadline,
          (value) => {
            publication.dev = value.dev;
            publication.ino = value.ino;
          },
          activeOutputDirectories,
        ),
      (value) => {
        completed = value;
      },
    );
    deadline.assertActive();
    success = true;
    completed = output;
  } catch (error) {
    operationFailure = error;
  } finally {
    deadline.dispose();
    if (!success) {
      const emergency = new AbsoluteDeadline(
        CLEANUP_DEADLINE_MILLISECONDS,
        "grok_live_readonly_emergency_cleanup_deadline_exceeded",
      );
      try {
        const emergencyResults = await Promise.allSettled([
          emergency.run(
            async () =>
              await removeOwnedPublication(
                input.outputPath,
                publication,
                outputDirectories,
              ),
          ),
          credentialSourceIdentity
            ? emergency.run(
                async () =>
                  await assertCredentialSourceUnchanged(
                    input.credentialSource,
                    credentialSourceIdentity!,
                    emergency.signal,
                  ),
              )
            : Promise.resolve(),
          closeOwned(
            connection,
            transport,
            channels,
            staged,
            temporaryRoot,
            emergency,
            { skipStagedReverify: true },
          ),
        ]);
        if (
          emergencyResults[0]?.status === "rejected" ||
          emergencyResults[2]?.status === "rejected"
        ) {
          throw new Error("grok_live_readonly_emergency_cleanup_failed");
        }
        if (emergencyResults[1]?.status === "rejected") {
          throw new Error("grok_live_readonly_credential_source_changed");
        }
      } catch (error) {
        operationFailure =
          error instanceof Error &&
          error.message === "grok_live_readonly_credential_source_changed"
            ? error
            : new Error("grok_live_readonly_emergency_cleanup_failed");
      } finally {
        emergency.dispose();
      }
    }
  }
  if (operationFailure !== undefined) {
    throw operationFailure;
  }
  if (!completed) throw new Error("grok_live_readonly_gate_incomplete");
  return completed;
}

/** @internal Exported only for deterministic cleanup-boundary tests. */
export async function closeOwned(
  connection: { close(reason?: string): Promise<void> } | undefined,
  transport: OwnedNdjsonStdioTransport | undefined,
  channels: LocalEnvironmentChannelProvider | undefined,
  staged:
    | Awaited<ReturnType<PinnedReleaseModule["stageVerifiedGrokCandidate"]>>
    | undefined,
  temporaryRoot: string | undefined,
  cleanup: AbsoluteDeadline,
  options: Readonly<{ skipStagedReverify?: boolean }> = {},
): Promise<{
  readonly transport: Readonly<Record<string, unknown>>;
  readonly disposition: Readonly<Record<string, boolean>>;
}> {
  const closeResults = await cleanup.run(
    async () =>
      await Promise.allSettled([
        connection?.close("grok_live_readonly_cleanup"),
        transport?.close("grok_live_readonly_cleanup"),
        channels?.close(),
      ]),
  );
  if (staged && !options.skipStagedReverify) {
    await cleanup.run(
      async () => await staged.reverify({ signal: cleanup.signal }),
    );
  }
  const removalResults = await cleanup.run(
    async () =>
      await Promise.allSettled([
        staged?.cleanup({ signal: cleanup.signal }),
        temporaryRoot
          ? rm(temporaryRoot, { recursive: true, force: true })
          : undefined,
      ]),
  );
  // Every cleanup branch has been attempted before surfacing an earlier
  // failure. In particular, emergency cleanup may be retrying after the
  // normal path already removed the staged executable.
  assertAllFulfilled(closeResults);
  assertAllFulfilled(removalResults);
  const transportDiagnostics = transport?.diagnostics();
  const assuranceRevoked = transport
    ? !isValidFramedTransportAssurance(transport.assurance)
    : true;
  const [stagedExecutableRemoved, disposableRootRemoved] = await cleanup.run(
    async () =>
      await Promise.all([
        staged ? isMissing(staged.executablePath) : true,
        temporaryRoot ? isMissing(temporaryRoot) : true,
      ]),
  );
  if (
    !assuranceRevoked ||
    !stagedExecutableRemoved ||
    !disposableRootRemoved ||
    (transportDiagnostics && !transportDiagnostics.streamsDrained)
  ) {
    throw new Error("grok_live_readonly_cleanup_incomplete");
  }
  cleanup.assertActive();
  return Object.freeze({
    transport: Object.freeze(
      transportDiagnostics
        ? {
            stdoutBytesRead: transportDiagnostics.stdoutBytesRead,
            stderrBytesRead: transportDiagnostics.stderrBytesRead,
            inboundFramesRead: transportDiagnostics.inboundFramesRead,
            outboundFramesAccepted: transportDiagnostics.outboundFramesAccepted,
            outboundFramesWritten: transportDiagnostics.outboundFramesWritten,
            streamsDrained: transportDiagnostics.streamsDrained,
            processExitDisposition: transportDiagnostics.processExitDisposition,
          }
        : {},
    ),
    disposition: Object.freeze({
      connectionClosed: true,
      assuranceRevoked,
      processAndStreamsDrained: transportDiagnostics?.streamsDrained ?? true,
      stagedExecutableRemoved,
      disposableRootRemoved,
    }),
  });
}

function assertAllFulfilled(
  results: readonly PromiseSettledResult<unknown>[],
): void {
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
}

export async function isMissing(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function readCredentialSource(
  source: string,
  signal: AbortSignal,
  requiredFreshnessMilliseconds = CREDENTIAL_FRESHNESS_MILLISECONDS,
): Promise<{
  readonly stagedBytes: Uint8Array;
  readonly continuity: GrokLocalCredentialContinuity;
  readonly sensitiveValues: readonly string[];
  readonly sourceIdentity: CredentialSourceIdentity;
}> {
  signal.throwIfAborted();
  const before = await lstat(source);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size <= 0 ||
    before.size > MAXIMUM_CREDENTIAL_BYTES
  ) {
    throw new Error("grok_live_readonly_credential_source_invalid");
  }
  const handle = await open(
    source,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const descriptor = await handle.stat();
    if (descriptor.dev !== before.dev || descriptor.ino !== before.ino) {
      throw new Error("grok_live_readonly_credential_source_changed");
    }
    const bytes = await handle.readFile({ signal });
    const after = await handle.stat();
    if (
      after.dev !== descriptor.dev ||
      after.ino !== descriptor.ino ||
      after.size !== descriptor.size ||
      after.mtimeMs !== descriptor.mtimeMs
    ) {
      throw new Error("grok_live_readonly_credential_source_changed");
    }
    const extracted = extractCredential(bytes, requiredFreshnessMilliseconds);
    return Object.freeze({
      ...extracted,
      sourceIdentity: Object.freeze({
        dev: descriptor.dev,
        ino: descriptor.ino,
        size: descriptor.size,
        mtimeMs: descriptor.mtimeMs,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    });
  } finally {
    await handle.close();
  }
}

export async function assertCredentialSourceUnchanged(
  source: string,
  expected: CredentialSourceIdentity,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const handle = await open(
    source,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const current = await handle.stat();
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.size !== expected.size ||
      current.mtimeMs !== expected.mtimeMs
    ) {
      throw new Error("grok_live_readonly_credential_source_changed");
    }
    const bytes = await handle.readFile({ signal });
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error("grok_live_readonly_credential_source_changed");
    }
  } finally {
    await handle.close();
  }
}

function extractCredential(
  bytes: Uint8Array,
  requiredFreshnessMilliseconds: number,
): {
  readonly stagedBytes: Uint8Array;
  readonly continuity: GrokLocalCredentialContinuity;
  readonly sensitiveValues: readonly string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("grok_live_readonly_credential_source_invalid");
  }
  if (!isRecord(parsed)) {
    throw new Error("grok_live_readonly_credential_source_invalid");
  }
  const candidates = Object.entries(parsed).filter(
    (candidate): candidate is [string, Record<string, unknown>] =>
      nonEmpty(candidate[0]) &&
      isRecord(candidate[1]) &&
      candidate[1].auth_mode === "oidc" &&
      nonEmpty(candidate[1].key) &&
      nonEmpty(candidate[1].user_id) &&
      nonEmpty(candidate[1].principal_id) &&
      nonEmpty(candidate[1].expires_at),
  );
  if (candidates.length !== 1) {
    throw new Error("grok_live_readonly_credential_authority_ambiguous");
  }
  const [scopeKey, entry] = candidates[0]!;
  const expiresAt = Date.parse(entry.expires_at as string);
  if (
    !Number.isFinite(expiresAt) ||
    !Number.isSafeInteger(requiredFreshnessMilliseconds) ||
    requiredFreshnessMilliseconds < 0 ||
    expiresAt <= Date.now() + requiredFreshnessMilliseconds
  ) {
    throw new Error("grok_live_readonly_credential_not_fresh");
  }
  const continuity = Object.freeze({
    principalId: entry.principal_id as string,
    ...(nonEmpty(entry.principal_type)
      ? { principalType: entry.principal_type }
      : {}),
    ...(nonEmpty(entry.team_id) ? { teamId: entry.team_id } : {}),
    ...(nonEmpty(entry.organization_id)
      ? { organizationId: entry.organization_id }
      : {}),
  });
  const sensitiveValues = [...collectStrings(entry)]
    .flatMap((value) =>
      value.length >= 8 ? [value, value.slice(-8)] : [value],
    )
    .filter(
      (value, index, values) =>
        value.length > 0 && values.indexOf(value) === index,
    );
  const stagedBytes = Buffer.from(`${JSON.stringify({ [scopeKey]: entry })}\n`);
  return Object.freeze({
    stagedBytes,
    continuity,
    sensitiveValues: Object.freeze(sensitiveValues),
  });
}

function collectStrings(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    into.add(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) collectStrings(entry, into);
  }
  return into;
}

export async function writeProbePolicy(
  grokHome: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await writeFile(
    path.join(grokHome, "config.toml"),
    [
      "[cli]",
      "auto_update = false",
      "use_leader = false",
      "",
      "[features]",
      "codebase_indexing = false",
      "managed_config = false",
      "telemetry = false",
      "feedback = false",
      "remote_fetch = false",
      "web_fetch = false",
      "lsp_tools = false",
      "write_file = false",
      "ask_user_question = false",
      "backend_tools = false",
      "session_search = false",
      "session_recap = false",
      "auto_wake = false",
      "image_gen = false",
      "video_gen = false",
      "",
      "[sandbox]",
      "auto_allow_bash = false",
      "",
      "[telemetry]",
      "trace_upload = false",
      "mixpanel_enabled = false",
      "otel_enabled = false",
      "",
      "[managed_mcps]",
      "enabled = false",
      "gateway_tools_enabled = false",
      "",
      "[ui]",
      "yolo = false",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx", signal },
  );
  signal.throwIfAborted();
  const bundled = path.join(grokHome, "bundled");
  await mkdir(bundled, { mode: 0o700 });
  signal.throwIfAborted();
  await writeFile(
    path.join(bundled, "manifest.json"),
    `${JSON.stringify({ version: "sedes-readonly-gate", checksums: {} })}\n`,
    { mode: 0o600, flag: "wx", signal },
  );
  signal.throwIfAborted();
}

export async function assertNoSystemGrokPolicy(
  signal: AbortSignal,
): Promise<void> {
  for (const candidate of [
    "/etc/grok/managed_config.toml",
    "/etc/grok/requirements.toml",
  ]) {
    signal.throwIfAborted();
    if (!(await isMissing(candidate))) {
      throw new Error("grok_live_readonly_system_policy_present");
    }
  }
}

function payloadFreeBindingDiagnostics(
  value: ReturnType<GrokLiveReadonlyConnection["diagnostics"]>,
) {
  return {
    initialized: value.initialized,
    ignoredNotifications: value.ignoredNotifications,
    ignoredNotificationBytes: value.ignoredNotificationBytes,
    deniedReverseRequests: value.deniedReverseRequests,
    handlerFailures: value.handlerFailures,
    rejectedLateResponses: value.rejectedLateResponses,
    protocolFailures: value.protocolFailures,
  };
}

function authorityBasis(
  continuity: GrokLocalCredentialContinuity,
): readonly string[] {
  return Object.keys(continuity).sort();
}

export async function installEvidence(
  outputPath: string,
  evidence: Readonly<Record<string, unknown>>,
  deadline: AbsoluteDeadline,
  registerLinkedPublication: (
    identity: Readonly<{ dev: number; ino: number }>,
  ) => void,
  outputDirectories: readonly OutputDirectoryIdentity[],
): Promise<GrokLiveReadonlyGateResult> {
  deadline.assertActive();
  await assertOutputDirectoriesUnchanged(outputDirectories);
  deadline.assertActive();
  const serialized = `${JSON.stringify(evidence)}\n`;
  const temporary = `${outputPath}.tmp-${randomBytes(8).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(serialized, {
      encoding: "utf8",
      signal: deadline.signal,
    });
    await handle.sync();
    const temporaryIdentity = await handle.stat();
    await handle.close();
    handle = undefined;
    deadline.assertActive();
    await assertOutputDirectoriesUnchanged(outputDirectories);
    deadline.assertActive();
    await link(temporary, outputPath);
    registerLinkedPublication(
      Object.freeze({ dev: temporaryIdentity.dev, ino: temporaryIdentity.ino }),
    );
    const installed = await lstat(outputPath);
    if (
      !installed.isFile() ||
      installed.isSymbolicLink() ||
      installed.dev !== temporaryIdentity.dev ||
      installed.ino !== temporaryIdentity.ino
    ) {
      throw new Error("grok_live_readonly_output_install_invalid");
    }
    await assertOutputDirectoriesUnchanged(outputDirectories);
    deadline.assertActive();
    await unlink(temporary);
    deadline.assertActive();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return Object.freeze({
    outputPath,
    outputSha256: createHash("sha256").update(serialized).digest("hex"),
    outputBytes: Buffer.byteLength(serialized),
  });
}

export async function preflightOutputTarget(
  outputPath: string,
  signal: AbortSignal,
  registerLeaf?: (leaf: OutputLeafDisposition) => void,
): Promise<readonly OutputDirectoryIdentity[]> {
  signal.throwIfAborted();
  const parent = path.dirname(outputPath);
  const grandparent = path.dirname(parent);
  const grandparentIdentity = await lstat(grandparent);
  if (
    grandparentIdentity.isSymbolicLink() ||
    !grandparentIdentity.isDirectory() ||
    grandparentIdentity.uid !== process.getuid?.() ||
    (grandparentIdentity.mode & 0o022) !== 0 ||
    (await realpath(grandparent)) !== grandparent
  ) {
    throw new Error("grok_live_readonly_output_parent_invalid");
  }
  signal.throwIfAborted();
  let createdByRun = false;
  try {
    await mkdir(parent, { mode: 0o700 });
    createdByRun = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const parentIdentity = await lstat(parent);
  if (
    parentIdentity.isSymbolicLink() ||
    !parentIdentity.isDirectory() ||
    parentIdentity.uid !== process.getuid?.() ||
    (parentIdentity.mode & 0o022) !== 0 ||
    (await realpath(parent)) !== parent
  ) {
    throw new Error("grok_live_readonly_output_parent_invalid");
  }
  signal.throwIfAborted();
  if (!(await isMissing(outputPath))) {
    throw new Error("grok_live_readonly_output_already_exists");
  }
  registerLeaf?.(
    Object.freeze({
      identity: Object.freeze({
        path: parent,
        dev: parentIdentity.dev,
        ino: parentIdentity.ino,
      }),
      createdByRun,
    }),
  );
  return Object.freeze([
    Object.freeze({
      path: grandparent,
      dev: grandparentIdentity.dev,
      ino: grandparentIdentity.ino,
    }),
    Object.freeze({
      path: parent,
      dev: parentIdentity.dev,
      ino: parentIdentity.ino,
    }),
  ]);
}

export async function removeOwnedEmptyOutputLeaf(
  leaf: OutputLeafDisposition | undefined,
): Promise<boolean> {
  if (!leaf?.createdByRun) return false;
  const current = await lstat(leaf.identity.path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== leaf.identity.dev ||
    current.ino !== leaf.identity.ino
  ) {
    throw new Error("grok_live_readonly_output_parent_changed");
  }
  await rmdir(leaf.identity.path);
  return true;
}

export async function removeOwnedPublication(
  outputPath: string,
  publication: { dev?: number; ino?: number },
  outputDirectories: readonly OutputDirectoryIdentity[] | undefined,
): Promise<void> {
  if (publication.dev === undefined || publication.ino === undefined) return;
  if (!outputDirectories) {
    throw new Error("grok_live_readonly_output_cleanup_identity_missing");
  }
  await assertOutputDirectoriesUnchanged(outputDirectories);
  const current = await lstat(outputPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!current) return;
  if (current.dev !== publication.dev || current.ino !== publication.ino) {
    throw new Error("grok_live_readonly_output_cleanup_identity_mismatch");
  }
  await unlink(outputPath);
}

async function assertOutputDirectoriesUnchanged(
  expected: readonly OutputDirectoryIdentity[],
): Promise<void> {
  for (const identity of expected) {
    const current = await lstat(identity.path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.uid !== process.getuid?.() ||
      (current.mode & 0o022) !== 0 ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      (await realpath(identity.path)) !== identity.path
    ) {
      throw new Error("grok_live_readonly_output_parent_changed");
    }
  }
}

function assertAbsoluteRegularTarget(
  credentialSource: string,
  outputPath: string,
): void {
  if (
    !path.isAbsolute(credentialSource) ||
    !path.isAbsolute(outputPath) ||
    path.normalize(credentialSource) !== credentialSource ||
    path.normalize(outputPath) !== outputPath ||
    credentialSource === outputPath ||
    !outputPath.endsWith(
      "/protocol/grok-acp/1.0.4/evidence/l-readonly/capture.json",
    )
  ) {
    throw new Error("grok_live_readonly_path_invalid");
  }
}

export class AbsoluteDeadline {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #timer: NodeJS.Timeout;

  constructor(
    milliseconds: number,
    diagnostic = "grok_live_readonly_deadline_exceeded",
  ) {
    this.signal = this.#controller.signal;
    this.#timer = setTimeout(
      () => this.#controller.abort(new Error(diagnostic)),
      milliseconds,
    );
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
      this.assertActive();
      operation = start().then((value) => {
        // Registration is part of settlement, so an abort at the same
        // fulfillment boundary cannot discard newly acquired authority.
        registerFulfilled?.(value);
        return value;
      });
      return await Promise.race([operation, aborted]);
    } catch (error) {
      if (!this.signal.aborted) throw error;
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

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCli(arguments_: readonly string[]): {
  readonly credentialSource: string;
  readonly outputPath: string;
} {
  const values = new Map<string, string>();
  for (const argument of arguments_) {
    const match = /^--(credential-source|output)=(.+)$/u.exec(argument);
    if (!match || values.has(match[1]!)) {
      throw new Error("grok_live_readonly_cli_invalid");
    }
    values.set(match[1]!, match[2]!);
  }
  const credentialSource = values.get("credential-source");
  const outputPath = values.get("output");
  if (!credentialSource || !outputPath || values.size !== 2) {
    throw new Error("grok_live_readonly_cli_invalid");
  }
  return { credentialSource, outputPath };
}

async function main(): Promise<void> {
  try {
    const input = parseCli(process.argv.slice(2));
    const result = await runGrokLiveReadonlyGate(input);
    process.stdout.write(
      `${JSON.stringify({ status: "passed", ...result })}\n`,
    );
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        status: "failed",
        code: "grok_live_readonly_gate_failed",
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
