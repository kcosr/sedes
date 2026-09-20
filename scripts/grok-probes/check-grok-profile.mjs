import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const profileRoot = path.join(repositoryRoot, "protocol/grok-acp/1.0.4");
const manifestPath = path.join(profileRoot, "artifact-manifest.json");
const requiredFiles = [
  "README.md",
  "release.json",
  "profile.json",
  "source-image-mechanics.json",
  "source-route-candidates.json",
  "evidence/o0/capture.json",
  "evidence/o1/capture.json",
  "evidence/o2a/capture.json",
  "evidence/l-readonly/capture.json",
  "evidence/o0/version.json",
  "evidence/o0/help-root.txt",
  "evidence/o0/help-agent.txt",
  "evidence/o0/help-agent-stdio.txt",
];

// These tokens are immutable observations in pre-rename evidence or exact
// provider source paths. Active profile prose and newly generated captures
// must use Sedes; no unlisted Harness token is admitted.
const historicalHarnessTokenInventory = new Map([
  [
    "evidence/o1/capture.json",
    [
      [".harness-grok-probe-canary", 16],
      [".harness-grok-probe-mcp-canary", 2],
    ],
  ],
  [
    "evidence/o2a/capture.json",
    [
      [".harness-grok-probe-canary", 16],
      [".harness-grok-probe-mcp-canary", 2],
    ],
  ],
  [
    "evidence/l-readonly/capture.json",
    [["inheritedProviderOrHarnessEnvironment", 1]],
  ],
  [
    "source-route-candidates.json",
    [["xai-grok-pager-pty-harness", 6]],
  ],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function visit(directory, prefix = "") {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const relative = path.posix.join(prefix, name);
    if (relative === "artifact-manifest.json") continue;
    const absolute = path.join(directory, name);
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) {
      throw new Error(`Profile artifact ${relative} must not be a symlink.`);
    }
    if (entry.isDirectory()) files.push(...visit(absolute, relative));
    else if (entry.isFile()) files.push(relative);
    else
      throw new Error(`Profile artifact ${relative} must be a regular file.`);
  }
  return files;
}

function parseJson(relative, format = "pretty") {
  const text = readFileSync(path.join(profileRoot, relative), "utf8");
  const value = JSON.parse(text);
  const canonical =
    format === "compact"
      ? `${JSON.stringify(value)}\n`
      : `${JSON.stringify(value, null, 2)}\n`;
  if (canonical !== text) {
    throw new Error(`${relative} is not canonical formatted JSON.`);
  }
  return value;
}

function validateHistoricalHarnessTokens(relative, text) {
  let unaccounted = text;
  for (const [token, expectedCount] of
    historicalHarnessTokenInventory.get(relative) ?? []) {
    const actualCount = unaccounted.split(token).length - 1;
    if (actualCount !== expectedCount) {
      throw new Error(
        `${relative} historical token ${token} count drifted: expected ${expectedCount}, received ${actualCount}.`,
      );
    }
    unaccounted = unaccounted.split(token).join("");
  }
  if (/harness/iu.test(unaccounted)) {
    throw new Error(`${relative} contains an unclassified Harness token.`);
  }
}

function buildManifest() {
  const files = visit(profileRoot);
  for (const required of requiredFiles) {
    if (!files.includes(required)) throw new Error(`Missing ${required}.`);
  }
  return {
    schemaVersion: 1,
    profile: "grok-acp/1.0.4",
    generatedBy: "npm run check:grok-profile -- --write-manifest",
    files: files.map((relative) => {
      const bytes = readFileSync(path.join(profileRoot, relative));
      return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
    }),
  };
}

function validateSemantics() {
  const release = parseJson("release.json");
  const profile = parseJson("profile.json");
  const routes = parseJson("source-route-candidates.json");
  const imageMechanics = parseJson("source-image-mechanics.json");
  const capture = parseJson("evidence/o0/capture.json");
  const o1Capture = parseJson("evidence/o1/capture.json", "compact");
  const o2aCapture = parseJson("evidence/o2a/capture.json", "compact");
  const lReadonlyCapture = parseJson(
    "evidence/l-readonly/capture.json",
    "compact",
  );
  const version = parseJson("evidence/o0/version.json");
  if (
    release.candidate.release !== "1.0.4" ||
    release.candidate.build !== "d846eb93d9" ||
    release.candidate.executableSha256 !==
      "79f49625f153923db491a5c290e9b04c3444da488b6b9d6aac533ccb5bff2455" ||
    release.candidate.executableBytes !== 166196224
  ) {
    throw new Error("release.json candidate identity drifted.");
  }
  if (
    release.runtimeAdmission.status !== "production-admitted-stable-1.x" ||
    release.runtimeAdmission.productionAdmissionDecision !==
      "stable-1.x-reviewed-floor" ||
    release.runtimeAdmission.reviewedAt !== "2026-08-16"
  ) {
    throw new Error("Exact-build production admission drifted.");
  }
  if (
    profile.tranches.O0.status !== "contained-captured" ||
    profile.tranches.O1.status !== "contained-captured" ||
    profile.tranches.O2a.status !== "contained-captured" ||
    profile.tranches.O2b.status !== "pending" ||
    profile.tranches["L-readonly"].status !== "contained-captured" ||
    profile.tranches.L.status !== "production-native-suite-passed"
  ) {
    throw new Error("G0 tranche statuses are not truthful.");
  }
  const o1Evidence = readFileSync(
    path.join(profileRoot, "evidence/o1/capture.json"),
  );
  if (
    profile.tranches.O1.providerCapacity !== false ||
    profile.tranches.O1.evidence !== "evidence/o1/capture.json" ||
    profile.tranches.O1.evidenceSha256 !== sha256(o1Evidence)
  ) {
    throw new Error("O1 profile evidence binding drifted.");
  }
  const o2aEvidence = readFileSync(
    path.join(profileRoot, "evidence/o2a/capture.json"),
  );
  if (
    profile.acp.initializeEvidence !== "contained-O2a" ||
    profile.tranches.O2a.providerCapacity !== false ||
    profile.tranches.O2a.evidence !== "evidence/o2a/capture.json" ||
    profile.tranches.O2a.evidenceSha256 !== sha256(o2aEvidence) ||
    profile.tranches.O2a.boundedObservationMilliseconds !== 750 ||
    profile.tranches.O2a.ignoredNotifications !== 1 ||
    profile.tranches.O2a.ignoredNotificationBytes !== 81
  ) {
    throw new Error("O2a profile evidence binding drifted.");
  }
  const lReadonlyEvidence = readFileSync(
    path.join(profileRoot, "evidence/l-readonly/capture.json"),
  );
  if (
    lReadonlyEvidence.length !== 1843 ||
    sha256(lReadonlyEvidence) !==
      "ea0e21e316189fe9bb288c132e00a17a110db5ba57194931b0e8a9f4ba3a7c2d" ||
    profile.status !== "production-admitted" ||
    profile.acp.authenticatedEvidence !== "production-native-L-suite" ||
    profile.acp.shippingCodec !== "first-class-stable-1.x" ||
    profile.tranches["L-readonly"].providerCapacity !== true ||
    profile.tranches["L-readonly"].authenticated !== true ||
    profile.tranches["L-readonly"].evidence !==
      "evidence/l-readonly/capture.json" ||
    profile.tranches["L-readonly"].evidenceSha256 !==
      sha256(lReadonlyEvidence) ||
    profile.tranches.L.providerCapacity !== true ||
    profile.tranches.L.authenticated !== true ||
    profile.tranches.L.evidence !== null ||
    profile.tranches.L.suite !==
      "tests/real-grok/grok-session-lifecycle.test.ts" ||
    profile.tranches.L.verifiedAt !== "2026-08-16" ||
    profile.tranches.L.exactBuild !== "d846eb93d9" ||
    !profile.disposition.includes("normal HOME/GROK_HOME") ||
    !profile.disposition.includes("O2b is nonblocking") ||
    JSON.stringify(profile.acp.productionCapabilityClaims) !==
      JSON.stringify([
        "native cached-token authentication",
        "model catalog and effective session selection",
        "bounded session-list discovery",
        "provider-assigned session creation",
        "bounded authoritative load replay",
        "ordered text, Task, staged file, and native image submission with durable operation correlation",
        "standard ACP resource links for path-native staged files",
        "standard ACP image content blocks from canonical attachment bytes",
        "restart reconciliation",
        "session close as unload",
      ])
  ) {
    throw new Error("Production/native-L profile binding drifted.");
  }
  if (
    routes.revisions.length !== 2 ||
    routes.revisions.some((r) => !r.claim.includes("not exact-binary"))
  ) {
    throw new Error(
      "Source evidence must remain explicitly non-binary evidence.",
    );
  }
  if (
    imageMechanics.revision.releaseDeclaration !== "1.0.4" ||
    imageMechanics.revision.commit !==
      "5163763e703c319e4554c2f455535c5adb6e51e8" ||
    imageMechanics.revision.sourceRevision !==
      "84ae1223e57a5048afb570d74d45c051fa604982" ||
    !imageMechanics.extraction.claim.includes("not exact-binary") ||
    JSON.stringify(imageMechanics.mechanics.map(({ id }) => id)) !==
      JSON.stringify([
        "standard_acp_image_content_ingest",
        "standard_acp_resource_link_ingest",
        "meta_free_resource_link_path_projection",
        "canonical_base64_image_bytes",
        "model_explicit_image_boolean_precedence",
        "model_input_modalities_negative_evidence",
      ]) ||
    imageMechanics.mechanics.some(
      ({ path, line, evidenceSha256 }) =>
        typeof path !== "string" ||
        !path.startsWith("crates/codegen/") ||
        !Number.isSafeInteger(line) ||
        line <= 0 ||
        !/^[0-9a-f]{64}$/u.test(evidenceSha256),
    )
  ) {
    throw new Error("Grok source image mechanics evidence drifted.");
  }
  if (
    version.currentVersion !== "1.0.4 (d846eb93d9)" ||
    !["stable", "unknown"].includes(version.channel) ||
    capture.schemaVersion !== 2 ||
    capture.status !== "contained-captured" ||
    capture.providerCapacity.used !== false
  ) {
    throw new Error("O0 capture identity drifted.");
  }
  if (
    capture.candidate.release !== release.candidate.release ||
    capture.candidate.build !== release.candidate.build ||
    capture.candidate.executableSha256 !== release.candidate.executableSha256 ||
    capture.candidate.executableBytes !== release.candidate.executableBytes ||
    capture.candidate.channelIsAdmissionAuthority !== false ||
    capture.candidate.pathEvidence.canonicalPath !==
      "<REDACTED_INSTALL_ROOT>/grok-1.0.4-linux-x86_64" ||
    capture.candidate.pathEvidence.stat.bytes !== 166196224 ||
    capture.candidate.pathEvidence.stat.type !== "regular-file"
  ) {
    throw new Error("O0 sanitized path/stat evidence drifted.");
  }
  const expectedCommands = [
    { id: "version", command: "version_json", args: ["version", "--json"] },
    { id: "root", command: "root_help", args: ["--help"] },
    { id: "agent", command: "agent_help", args: ["agent", "--help"] },
    {
      id: "agent-stdio",
      command: "agent_stdio_help",
      args: ["agent", "stdio", "--help"],
    },
  ];
  if (
    JSON.stringify(
      capture.commands.map(({ id, command, args }) => ({ id, command, args })),
    ) !== JSON.stringify(expectedCommands) ||
    capture.commands.some(
      (item) =>
        item.observation.sandbox.networkNamespace !== true ||
        item.observation.sandbox.hostRootMounted !== false ||
        item.observation.sandbox.hostHomesHidden !== true ||
        item.observation.cleanup.ownedProcessGroupTerminated !== true ||
        item.observation.cleanup.invocationTemporaryRootRemoved !== true ||
        item.observation.stderr.bytes !== 0,
    ) ||
    capture.constraints.noAcpFrames !== true ||
    capture.constraints.authenticate !== false ||
    capture.candidate.stagedCopy.retainedReadOnlyFdMount !== true ||
    capture.candidate.stagedCopy.reverifiedAfterEveryInvocation !== true ||
    capture.evidenceHistory.priorDraftUnsandboxedCapture !==
      "replaced-not-retained"
  ) {
    throw new Error("O0 containment and cleanup evidence drifted.");
  }
  const versionCommand = capture.commands[0];
  const rawVersion = `${JSON.stringify(version)}\n`;
  if (
    versionCommand.bytes !== Buffer.byteLength(rawVersion) ||
    versionCommand.sha256 !== sha256(rawVersion)
  ) {
    throw new Error("O0 version command capture is not bound to version.json.");
  }
  for (const item of capture.commands.filter(({ id }) => id !== "version")) {
    const text = readFileSync(
      path.join(profileRoot, `evidence/o0/help-${item.id}.txt`),
    );
    if (text.length !== item.bytes || sha256(text) !== item.sha256) {
      throw new Error(`O0 ${item.id} help capture hash drifted.`);
    }
  }
  const o1ChangePaths = o1Capture.filesystem.changes.map((change) =>
    change.kind === "changed" ? change.after.path : change.entry.path,
  );
  if (
    o1Capture.tranche !== "o1_no_initialize" ||
    o1Capture.observation.quiet !== true ||
    o1Capture.executableIdentity.executableSha256 !==
      release.candidate.executableSha256 ||
    o1Capture.executableIdentity.productionGrokAssuranceClaimed !== false ||
    o1Capture.executableIdentity.stagedMountedFileIdentityStable !== true ||
    o1Capture.protocolAdmission.authenticate !== false ||
    o1Capture.protocolAdmission.providerCapacity !== false ||
    o1Capture.protocolAdmission.maximumOutboundFrames !== 0 ||
    o1Capture.protocolAdmission.allowedMethods.length !== 0 ||
    o1Capture.transport.inboundFramesRead !== 0 ||
    o1Capture.transport.outboundFramesAccepted !== 0 ||
    o1Capture.transport.outboundFramesWritten !== 0 ||
    o1Capture.transport.stdoutBytesRead !== 0 ||
    o1Capture.transport.stderrBytesRead !== 0 ||
    o1Capture.transport.streamsDrained !== true ||
    o1Capture.transport.assuranceRevoked !== true ||
    o1Capture.cleanup.assuranceRevoked !== true ||
    o1Capture.cleanup.sandboxTemporaryRootRemoved !== true ||
    o1Capture.cleanup.stagedExecutableRemoved !== true ||
    o1Capture.operationDeadline.disposition !==
      "completed_within_absolute_deadline" ||
    o1Capture.operationDeadline.coveredThrough !==
      "sanitized_evidence_atomic_install" ||
    o1Capture.filesystem.changes.length === 0 ||
    o1ChangePaths.some(
      (changedPath) => !changedPath.startsWith("home/.grok/"),
    ) ||
    !o1ChangePaths.includes("home/.grok/config.toml") ||
    !o1ChangePaths.includes("home/.grok/active_sessions.json") ||
    !o1ChangePaths.includes("home/.grok/README.md") ||
    !o1ChangePaths.includes("home/.grok/docs/user-guide/01-getting-started.md")
  ) {
    throw new Error("O1 contained startup evidence drifted.");
  }
  const o2aChangePaths = o2aCapture.filesystem.changes.map((change) =>
    change.kind === "changed" ? change.after.path : change.entry.path,
  );
  const expectedInitialize = {
    agentInfoPresent: false,
    authentication: { kinds: ["agent"], methodCount: 1 },
    capabilities: {
      auth: { logout: false, present: true },
      loadSession: true,
      mcp: { acp: false, http: true, present: true, sse: true },
      nes: false,
      positionEncoding: false,
      present: true,
      promptCapabilities: {
        audio: false,
        embeddedContext: true,
        image: false,
        present: true,
      },
      providers: false,
      session: {
        additionalDirectories: false,
        close: true,
        delete: false,
        fork: false,
        list: true,
        present: true,
        resume: true,
      },
    },
    metaKeys: {
      auth: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      authLogout: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      capabilities: {
        encounteredKnownKeys: [
          "x.ai/capabilities",
          "x.ai/fs_notify",
          "x.ai/hooks",
        ],
        unknownKeyCount: 0,
      },
      mcp: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      nes: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      promptCapabilities: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      providers: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      response: {
        encounteredKnownKeys: [
          "agentId",
          "agentInstanceId",
          "agentVersion",
          "availableCommands",
          "cancelRewind",
          "currentWorkingDirectory",
          "defaultAuthMethodId",
          "grokShell",
          "hostname",
          "mcpApps",
          "mcpServers",
          "metadata",
          "modelState",
          "sessionRecap",
          "voiceMode",
          "x.ai/mcp/sdk",
          "x.ai/pluginDirs",
        ],
        unknownKeyCount: 0,
      },
      session: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      sessionAdditionalDirectories: {
        encounteredKnownKeys: [],
        unknownKeyCount: 0,
      },
      sessionClose: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      sessionDelete: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      sessionFork: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      sessionList: { encounteredKnownKeys: [], unknownKeyCount: 0 },
      sessionResume: { encounteredKnownKeys: [], unknownKeyCount: 0 },
    },
    protocolVersion: 1,
  };
  if (
    o2aCapture.tranche !== "o2a_initialize_only" ||
    JSON.stringify(o2aCapture.initialize) !==
      JSON.stringify(expectedInitialize) ||
    o2aCapture.observation.initializeCompleted !== true ||
    o2aCapture.observation.boundedObservationCompleted !== true ||
    o2aCapture.observation.boundedObservationMilliseconds !== 750 ||
    o2aCapture.observation.ignoredNotifications !== 1 ||
    o2aCapture.observation.ignoredNotificationBytes !== 81 ||
    o2aCapture.executableIdentity.executableSha256 !==
      release.candidate.executableSha256 ||
    o2aCapture.executableIdentity.productionGrokAssuranceClaimed !== false ||
    o2aCapture.executableIdentity.stagedMountedFileIdentityStable !== true ||
    JSON.stringify(o2aCapture.protocolAdmission.allowedMethods) !==
      JSON.stringify(["initialize"]) ||
    o2aCapture.protocolAdmission.authenticate !== false ||
    o2aCapture.protocolAdmission.providerCapacity !== false ||
    o2aCapture.protocolAdmission.filesystemCapability !== false ||
    o2aCapture.protocolAdmission.terminalCapability !== false ||
    o2aCapture.protocolAdmission.maximumIgnoredNotifications !== 1 ||
    o2aCapture.protocolAdmission.maximumIgnoredNotificationBytes !== 65536 ||
    o2aCapture.protocolAdmission.maximumInboundFrames !== 2 ||
    o2aCapture.protocolAdmission.maximumOutboundFrames !== 1 ||
    o2aCapture.transport.inboundFramesRead !== 2 ||
    o2aCapture.transport.outboundFramesAccepted !== 1 ||
    o2aCapture.transport.outboundFramesWritten !== 1 ||
    o2aCapture.transport.stderrBytesRead !== 0 ||
    o2aCapture.transport.streamsDrained !== true ||
    o2aCapture.transport.assuranceRevoked !== true ||
    o2aCapture.binding.initialized !== true ||
    o2aCapture.binding.ignoredNotifications !== 1 ||
    o2aCapture.binding.ignoredNotificationBytes !== 81 ||
    o2aCapture.binding.activeNotifications !== 0 ||
    o2aCapture.binding.activeReverseRequests !== 0 ||
    o2aCapture.binding.deniedReverseRequests !== 0 ||
    o2aCapture.binding.deniedExtensionReverseRequests !== 0 ||
    o2aCapture.binding.protocolFailures !== 0 ||
    o2aCapture.binding.handlerFailures !== 0 ||
    o2aCapture.binding.captureFailures !== 0 ||
    o2aCapture.binding.pendingRequests !== 0 ||
    o2aCapture.binding.pendingNotifications !== 0 ||
    o2aCapture.cleanup.assuranceRevoked !== true ||
    o2aCapture.cleanup.emergencyFailureCleanupUsed !== false ||
    o2aCapture.cleanup.sandboxTemporaryRootRemoved !== true ||
    o2aCapture.cleanup.stagedExecutableRemoved !== true ||
    o2aCapture.operationDeadline.boundedObservationMilliseconds !== 750 ||
    o2aCapture.operationDeadline.disposition !==
      "completed_within_absolute_deadline" ||
    o2aCapture.operationDeadline.coveredThrough !==
      "sanitized_evidence_atomic_install" ||
    o2aCapture.filesystem.changes.length === 0 ||
    o2aChangePaths.some(
      (changedPath) => !changedPath.startsWith("home/.grok/"),
    ) ||
    !o2aChangePaths.includes("home/.grok/config.toml") ||
    !o2aChangePaths.includes("home/.grok/active_sessions.json") ||
    !o2aChangePaths.includes("home/.grok/README.md") ||
    !o2aChangePaths.includes("home/.grok/sessions/session_search.sqlite") ||
    !o2aChangePaths.includes("home/.grok/worktrees.db")
  ) {
    throw new Error("O2a contained initialize evidence drifted.");
  }
  const expectedLReadonlyCapture = {
    schemaVersion: 1,
    tranche: "L-readonly-local-credential-empty-session-list",
    release: {
      version: "1.0.4",
      build: "d846eb93d9",
      executableSha256:
        "79f49625f153923db491a5c290e9b04c3444da488b6b9d6aac533ccb5bff2455",
      profile: "grok-acp/1.0.4",
    },
    authority: {
      credentialFilesStaged: ["auth.json"],
      localCredentialContinuity: {
        singleFreshOidcEntry: true,
        stablePrincipalIdentifierPresent: true,
        contextFieldBasis: ["principalId", "principalType", "teamId"],
        originalCredentialSourceUnchanged: true,
      },
      inheritedProviderOrHarnessEnvironment: false,
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
      protocolVersion: 1,
      cachedTokenAdvertised: true,
      loadSession: true,
      sessionList: true,
      sessionResume: true,
      sessionClose: true,
    },
    authentication: { method: "cached_token", completed: true },
    sessionList: {
      requestedExactDisposableCwd: true,
      sessions: 0,
      nextCursorPresent: false,
    },
    binding: {
      initialized: true,
      ignoredNotifications: 3,
      ignoredNotificationBytes: 723,
      deniedReverseRequests: 0,
      handlerFailures: 0,
      rejectedLateResponses: 0,
      protocolFailures: 0,
    },
    limits: {
      absoluteDeadlineMilliseconds: 45000,
      requestDeadlineMilliseconds: 15000,
      maximumFrameBytes: 1048576,
      maximumStdoutBytes: 2097152,
      maximumStderrBytes: 1048576,
      maximumInboundFrames: 16,
      maximumOutboundFrames: 8,
    },
    transport: {
      stdoutBytesRead: 4801,
      stderrBytesRead: 0,
      inboundFramesRead: 6,
      outboundFramesAccepted: 3,
      outboundFramesWritten: 3,
      streamsDrained: true,
      processExitDisposition: "signal_exit",
    },
    cleanup: {
      connectionClosed: true,
      assuranceRevoked: true,
      processAndStreamsDrained: true,
      stagedExecutableRemoved: true,
      disposableRootRemoved: true,
    },
  };
  if (
    JSON.stringify(lReadonlyCapture) !==
    JSON.stringify(expectedLReadonlyCapture)
  ) {
    throw new Error("L-readonly narrowed semantic evidence drifted.");
  }
  for (const relative of visit(profileRoot)) {
    const text = readFileSync(path.join(profileRoot, relative), "utf8");
    validateHistoricalHarnessTokens(relative, text);
    if (/\/home\/[A-Za-z0-9._-]+\//u.test(text)) {
      throw new Error(
        `${relative} contains a host-private absolute home path.`,
      );
    }
    if (
      /(?:bearer\s+[A-Za-z0-9._~-]{12,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token)["'\s:=]+[A-Za-z0-9._~-]{12,})/iu.test(
        text,
      )
    ) {
      throw new Error(`${relative} resembles captured credential material.`);
    }
  }
}

validateSemantics();
const expected = `${JSON.stringify(buildManifest(), null, 2)}\n`;
if (process.argv.includes("--write-manifest")) {
  writeFileSync(manifestPath, expected);
} else if (readFileSync(manifestPath, "utf8") !== expected) {
  throw new Error("Grok profile artifact manifest has drifted.");
}
