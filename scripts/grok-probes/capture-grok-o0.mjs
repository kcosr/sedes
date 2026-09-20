import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  grokCandidateRelease,
  stageVerifiedGrokCandidate,
  verifyPinnedGrokCandidateNonExecuting,
  assertSameVerifiedIdentity,
} from "./pinned-grok-release.mjs";
import { runGrokStaticProbe } from "./grok-probe-sandbox.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const evidenceRoot = path.join(
  repositoryRoot,
  "protocol/grok-acp/1.0.4/evidence/o0",
);
const limits = Object.freeze({
  timeoutMs: 4_000,
  terminateGraceMs: 300,
  killGraceMs: 1_000,
  maxStdoutBytes: 256 * 1024,
  maxStderrBytes: 64 * 1024,
  maxFilesystemEntries: 512,
  maxFilesystemBytes: 4 * 1024 * 1024,
  maxManifestFileBytes: 256 * 1024,
  maxManifestDepth: 12,
});
const commands = Object.freeze([
  Object.freeze({ id: "version", command: "version_json", args: ["version", "--json"] }),
  Object.freeze({ id: "root", command: "root_help", args: ["--help"] }),
  Object.freeze({ id: "agent", command: "agent_help", args: ["agent", "--help"] }),
  Object.freeze({
    id: "agent-stdio",
    command: "agent_stdio_help",
    args: ["agent", "stdio", "--help"],
  }),
]);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalizeCapturedText(text) {
  return text.replaceAll("\r\n", "\n").replace(/[\t ]+(?=\n|$)/gu, "");
}

function assertContainedResult(result, expectedMode) {
  if (
    result.mode !== expectedMode ||
    result.violation !== undefined ||
    result.exit.code !== 0 ||
    result.exit.signal !== null ||
    result.exit.timedOut !== false ||
    result.stderr.bytes !== 0 ||
    result.stderr.redactedTail !== "" ||
    result.cleanup.processGroupTerminated !== true ||
    result.cleanup.temporaryRootRemovedOnReturn !== true ||
    result.sandbox.userNamespace !== true ||
    result.sandbox.pidNamespace !== true ||
    result.sandbox.networkNamespace !== true ||
    result.sandbox.hostRootMounted !== false ||
    result.sandbox.runtimeMountsReadOnly !== true ||
    result.sandbox.hostHomesHidden !== true
  ) {
    throw new Error(`Contained Grok O0 command ${expectedMode} failed its safety contract.`);
  }
  if (typeof result.stdout.sanitizedText !== "string") {
    throw new Error(`Contained Grok O0 command ${expectedMode} returned no bounded text.`);
  }
}

function safeObservation(result) {
  return Object.freeze({
    sandbox: Object.freeze({
      bubblewrapVersion: result.sandbox.bubblewrapVersion,
      userNamespace: true,
      pidNamespace: true,
      networkNamespace: true,
      hostRootMounted: false,
      runtimeMountsReadOnly: true,
      hostHomesHidden: true,
      environmentNames: result.sandbox.environmentNames,
    }),
    exit: Object.freeze({ code: 0, signal: null, timedOut: false }),
    stderr: Object.freeze({
      bytes: result.stderr.bytes,
      sha256: result.stderr.sha256,
      empty: true,
    }),
    filesystem: Object.freeze({
      before: Object.freeze({
        entryCount: result.filesystem.before.entries.length,
        totalBytes: result.filesystem.before.totalBytes,
      }),
      after: Object.freeze({
        entryCount: result.filesystem.after.entries.length,
        totalBytes: result.filesystem.after.totalBytes,
      }),
      changes: result.filesystem.changes,
    }),
    cleanup: Object.freeze({
      ownedProcessGroupTerminated: true,
      invocationTemporaryRootRemoved: true,
    }),
  });
}

export async function captureContainedGrokO0() {
  const original = await verifyPinnedGrokCandidateNonExecuting();
  const staged = await stageVerifiedGrokCandidate(original);
  const captures = [];
  try {
    for (const descriptor of commands) {
      const result = await runGrokStaticProbe({
        executablePath: staged.executablePath,
        retainedFileDescriptor: staged.retainedFileDescriptor,
        expectedSha256: staged.expectedSha256,
        expectedBytes: staged.expectedBytes,
        command: descriptor.command,
        limits,
      });
      assertContainedResult(result, `o0_${descriptor.command}`);
      const current = await staged.reverify();
      assertSameVerifiedIdentity(staged.identity, current);
      const text = canonicalizeCapturedText(result.stdout.sanitizedText);
      captures.push(
        Object.freeze({
          ...descriptor,
          text,
          bytes: Buffer.byteLength(text),
          sha256: sha256(text),
          observation: safeObservation(result),
        }),
      );
    }
    await staged.reverify();
  } finally {
    await staged.cleanup();
  }

  const versionCapture = captures.find(({ id }) => id === "version");
  let version;
  try {
    version = JSON.parse(versionCapture.text);
  } catch {
    throw new Error("Contained Grok version --json did not return JSON.");
  }
  const expectedVersion = `${grokCandidateRelease.release} (${grokCandidateRelease.build})`;
  if (
    version.currentVersion !== expectedVersion ||
    !["stable", "unknown"].includes(version.channel)
  ) {
    throw new Error("Contained Grok version/build identity did not match the candidate.");
  }

  const summary = Object.freeze({
    schemaVersion: 2,
    tranche: "O0",
    status: "contained-captured",
    providerCapacity: Object.freeze({
      used: false,
      enforcement: [
        "fresh bubblewrap network namespace with no host network",
        "minimal tmpfs root with no host home, credential store, or host root mount",
        "four closed static version/help commands; no ACP or authentication input",
      ],
    }),
    candidate: Object.freeze({
      ...grokCandidateRelease,
      capturedChannel: version.channel,
      channelIsAdmissionAuthority: false,
      pathEvidence: original.pathEvidence,
      stagedCopy: Object.freeze({
        privateRootMode: "0700",
        executableMode: "0500",
        boundedStreamingCopyAndHash: true,
        retainedReadOnlyFdMount: true,
        mountedOnlyAfterVerification: true,
        reverifiedAfterEveryInvocation: true,
        removedAfterCapture: true,
      }),
    }),
    commands: captures.map(({ id, command, args, bytes, sha256: digest, observation }) =>
      Object.freeze({ id, command, args, bytes, sha256: digest, observation }),
    ),
    constraints: Object.freeze({
      ...limits,
      stdin: "closed-empty",
      commandAllowlist: commands.map(({ command, args }) => ({ command, args })),
      noAcpFrames: true,
      authenticate: false,
      filesystemCapability: false,
      terminalCapability: false,
      processOwnership: "detached bubblewrap process group with TERM/KILL cleanup proof",
    }),
    evidenceHistory: Object.freeze({
      priorDraftUnsandboxedCapture: "replaced-not-retained",
      currentAuthority: "contained O0 capture only",
    }),
  });

  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    path.join(evidenceRoot, "version.json"),
    `${JSON.stringify(version, null, 2)}\n`,
  );
  for (const capture of captures.filter(({ id }) => id !== "version")) {
    await writeFile(path.join(evidenceRoot, `help-${capture.id}.txt`), capture.text);
  }
  await writeFile(
    path.join(evidenceRoot, "capture.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    throw new Error("Usage: capture-grok-o0.mjs");
  }
  await captureContainedGrokO0();
}
