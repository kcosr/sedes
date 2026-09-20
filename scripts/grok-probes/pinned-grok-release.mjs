import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const grokCandidateRelease = Object.freeze({
  release: "1.0.4",
  build: "d846eb93d9",
  executableSha256:
    "79f49625f153923db491a5c290e9b04c3444da488b6b9d6aac533ccb5bff2455",
  executableBytes: 166_196_224,
  observedChannel: "stable",
  nodePlatform: "linux",
  nodeArch: "x64",
});

const COPY_CHUNK_BYTES = 64 * 1024;
const STAGED_DIRECTORY_PREFIX = "sedes-grok-candidate-";

function optionSignal(options) {
  if (
    options === undefined ||
    (options !== null && typeof options === "object" && !Array.isArray(options))
  ) {
    if (options && Object.keys(options).some((key) => key !== "signal")) {
      throw new TypeError("Unknown Grok candidate operation option.");
    }
    const signal = options?.signal;
    if (signal === undefined || signal instanceof AbortSignal) return signal;
  }
  throw new TypeError("Grok candidate operation options must contain only an AbortSignal.");
}

function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

function findOnPath(command) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the bounded PATH search.
    }
  }
  throw new Error(`${command} is not executable on PATH.`);
}

export function resolveGrokBinary() {
  const configured = process.env.GROK_BINARY;
  if (configured !== undefined && !path.isAbsolute(configured)) {
    throw new Error("GROK_BINARY must be an absolute path when set.");
  }
  const executable = configured ?? findOnPath("grok");
  accessSync(executable, constants.R_OK | constants.X_OK);
  return executable;
}

function statIdentity(value) {
  return Object.freeze({
    device: value.dev.toString(),
    inode: value.ino.toString(),
    size: value.size.toString(),
    modifiedNanoseconds: value.mtimeNs.toString(),
    changedNanoseconds: value.ctimeNs.toString(),
    mode: value.mode.toString(),
  });
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function hashOpenFileBounded(file, maximumBytes, copyTo, signal) {
  throwIfAborted(signal);
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  while (true) {
    throwIfAborted(signal);
    const { bytesRead } = await file.read(
      buffer,
      0,
      buffer.length,
      position,
    );
    if (bytesRead === 0) break;
    throwIfAborted(signal);
    position += bytesRead;
    if (position > maximumBytes) {
      throw new Error("Grok executable exceeded the bounded hash size.");
    }
    const chunk = buffer.subarray(0, bytesRead);
    digest.update(chunk);
    if (copyTo) {
      let written = 0;
      while (written < chunk.length) {
        throwIfAborted(signal);
        const result = await copyTo.write(
          chunk,
          written,
          chunk.length - written,
          position - bytesRead + written,
        );
        if (result.bytesWritten === 0) {
          throw new Error("Grok staged copy made no write progress.");
        }
        written += result.bytesWritten;
      }
    }
  }
  throwIfAborted(signal);
  return Object.freeze({ bytes: position, sha256: digest.digest("hex") });
}

function assertExpectedCandidate(stat, hashed) {
  if (
    !stat.isFile() ||
    stat.size !== BigInt(grokCandidateRelease.executableBytes) ||
    hashed.bytes !== grokCandidateRelease.executableBytes ||
    hashed.sha256 !== grokCandidateRelease.executableSha256
  ) {
    throw new Error("Grok executable does not match the pinned G0 candidate.");
  }
}

async function inspectOriginalCandidate(executable, copyTo, signal) {
  throwIfAborted(signal);
  const requestedBefore = lstatSync(executable, { bigint: true });
  const canonicalPath = realpathSync(executable);
  const canonicalBefore = statSync(canonicalPath, { bigint: true });
  const file = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const descriptorBefore = await file.stat({ bigint: true });
    if (!sameIdentity(statIdentity(canonicalBefore), statIdentity(descriptorBefore))) {
      throw new Error("Grok executable changed before verification.");
    }
    const hashed = await hashOpenFileBounded(
      file,
      grokCandidateRelease.executableBytes,
      copyTo,
      signal,
    );
    throwIfAborted(signal);
    const descriptorAfter = await file.stat({ bigint: true });
    const canonicalAfter = statSync(canonicalPath, { bigint: true });
    const requestedAfter = lstatSync(executable, { bigint: true });
    if (
      realpathSync(executable) !== canonicalPath ||
      !sameIdentity(statIdentity(requestedBefore), statIdentity(requestedAfter)) ||
      !sameIdentity(statIdentity(descriptorBefore), statIdentity(descriptorAfter)) ||
      !sameIdentity(statIdentity(descriptorAfter), statIdentity(canonicalAfter))
    ) {
      throw new Error("Grok executable changed during verification.");
    }
    assertExpectedCandidate(descriptorAfter, hashed);
    return Object.freeze({
      executable,
      canonicalPath,
      executableSha256: hashed.sha256,
      descriptorIdentity: statIdentity(descriptorAfter),
      requestedIdentity: statIdentity(requestedAfter),
      pathEvidence: Object.freeze({
        locator: process.env.GROK_BINARY ? "GROK_BINARY" : "PATH:grok",
        requestedBasename: path.basename(executable),
        requestedPathIsSymlink: requestedAfter.isSymbolicLink(),
        canonicalBasename: path.basename(canonicalPath),
        canonicalPath: `<REDACTED_INSTALL_ROOT>/${path.basename(canonicalPath)}`,
        stat: Object.freeze({
          type: "regular-file",
          bytes: Number(descriptorAfter.size),
          mode: Number(descriptorAfter.mode & 0o777n)
            .toString(8)
            .padStart(3, "0"),
        }),
      }),
    });
  } finally {
    await file.close();
  }
}

function opaqueIdentity(candidate) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        descriptor: candidate.descriptorIdentity,
        requested: candidate.requestedIdentity,
        canonicalPath: candidate.canonicalPath,
        sha256: candidate.executableSha256,
      }),
    )
    .digest("hex");
}

function publicOriginalIdentity(candidate) {
  return Object.freeze({
    verifier: "pinned_grok_1.0.4",
    executablePath: candidate.executable,
    executableSha256: candidate.executableSha256,
    immutableIdentity: opaqueIdentity(candidate),
    pathEvidence: candidate.pathEvidence,
  });
}

/** Strictly non-executing: resolves, opens, stats, and hashes the candidate. */
export async function verifyPinnedGrokCandidateNonExecuting(options = {}) {
  const signal = optionSignal(options);
  throwIfAborted(signal);
  if (
    process.platform !== grokCandidateRelease.nodePlatform ||
    process.arch !== grokCandidateRelease.nodeArch
  ) {
    throw new Error(
      `Grok verification requires ${grokCandidateRelease.nodePlatform}/${grokCandidateRelease.nodeArch}.`,
    );
  }
  const candidate = await inspectOriginalCandidate(
    resolveGrokBinary(),
    undefined,
    signal,
  );
  throwIfAborted(signal);
  return publicOriginalIdentity(candidate);
}

// Compatibility for the offline orchestrator. This name no longer executes
// version/help; all execution must use a verified staged copy in a sandbox.
export const assertPinnedGrokCandidate =
  verifyPinnedGrokCandidateNonExecuting;

export function assertSameVerifiedIdentity(initial, current) {
  if (
    initial.verifier !== current.verifier ||
    initial.executableSha256 !== current.executableSha256 ||
    initial.immutableIdentity !== current.immutableIdentity
  ) {
    throw new Error("Grok verified candidate identity changed.");
  }
}

async function verifyStagedFile(stagedPath, retainedFile, signal) {
  throwIfAborted(signal);
  const rootStat = lstatSync(path.dirname(stagedPath), { bigint: true });
  if (!rootStat.isDirectory() || (rootStat.mode & 0o777n) !== 0o700n) {
    throw new Error("Grok staged candidate root must be a private 0700 directory.");
  }
  const pathBefore = lstatSync(stagedPath, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error("Grok staged candidate is not a regular non-symlink file.");
  }
  if ((pathBefore.mode & 0o777n) !== 0o500n) {
    throw new Error("Grok staged candidate must have mode 0500.");
  }
  const file =
    retainedFile ??
    (await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW));
  try {
    const descriptorBefore = await file.stat({ bigint: true });
    if (!sameIdentity(statIdentity(pathBefore), statIdentity(descriptorBefore))) {
      throw new Error("Grok staged candidate changed before verification.");
    }
    const hashed = await hashOpenFileBounded(
      file,
      grokCandidateRelease.executableBytes,
      undefined,
      signal,
    );
    throwIfAborted(signal);
    const descriptorAfter = await file.stat({ bigint: true });
    const pathAfter = lstatSync(stagedPath, { bigint: true });
    if (
      !sameIdentity(statIdentity(descriptorBefore), statIdentity(descriptorAfter)) ||
      !sameIdentity(statIdentity(descriptorAfter), statIdentity(pathAfter))
    ) {
      throw new Error("Grok staged candidate changed during verification.");
    }
    assertExpectedCandidate(descriptorAfter, hashed);
    return Object.freeze({
      verifier: "pinned_grok_1.0.4",
      executablePath: stagedPath,
      executableSha256: hashed.sha256,
      immutableIdentity: createHash("sha256")
        .update(
          JSON.stringify({
            staged: statIdentity(descriptorAfter),
            sha256: hashed.sha256,
          }),
        )
        .digest("hex"),
    });
  } finally {
    if (retainedFile === undefined) await file.close();
  }
}

/**
 * Copies the verified candidate into a private immutable-by-policy staging
 * root. Callers mount only executablePath, call reverify after execution, and
 * always call the idempotent cleanup.
 */
export async function stageVerifiedGrokCandidate(
  expectedOriginalIdentity,
  options = {},
) {
  const signal = optionSignal(options);
  throwIfAborted(signal);
  if (expectedOriginalIdentity?.verifier !== "pinned_grok_1.0.4") {
    throw new TypeError("Grok stage requires the preceding pinned verification identity.");
  }
  const base = process.env.GROK_PROBE_TMPDIR ?? os.tmpdir();
  const temporaryRoot = await mkdtemp(
    path.join(base, STAGED_DIRECTORY_PREFIX),
  );
  const stagedPath = path.join(
    temporaryRoot,
    `grok-${grokCandidateRelease.release}-${randomBytes(8).toString("hex")}`,
  );
  let cleanupPromise;
  let retainedFile;
  try {
    throwIfAborted(signal);
    await chmod(temporaryRoot, 0o700);
    throwIfAborted(signal);
    const staged = await open(
      stagedPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o500,
    );
    try {
      const copiedOriginal = await inspectOriginalCandidate(
        resolveGrokBinary(),
        staged,
        signal,
      );
      assertSameVerifiedIdentity(
        expectedOriginalIdentity,
        publicOriginalIdentity(copiedOriginal),
      );
      await staged.sync();
      throwIfAborted(signal);
    } finally {
      await staged.close();
    }
    await chmod(stagedPath, 0o500);
    retainedFile = await open(
      stagedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const identity = await verifyStagedFile(stagedPath, retainedFile, signal);
    throwIfAborted(signal);
    const cleanup = async (cleanupOptions = {}) => {
      const cleanupSignal = optionSignal(cleanupOptions);
      const abortReason = cleanupSignal?.aborted
        ? cleanupSignal.reason
        : undefined;
      cleanupPromise ??= (async () => {
        const [closeResult, removeResult] = await Promise.allSettled([
          retainedFile.close(),
          rm(temporaryRoot, { recursive: true, force: true }),
        ]);
        if (closeResult.status === "rejected") throw closeResult.reason;
        if (removeResult.status === "rejected") throw removeResult.reason;
      })();
      await cleanupPromise;
      if (abortReason !== undefined) throw abortReason;
      throwIfAborted(cleanupSignal);
    };
    return Object.freeze({
      executablePath: stagedPath,
      retainedFileDescriptor: retainedFile.fd,
      expectedBytes: grokCandidateRelease.executableBytes,
      expectedSha256: grokCandidateRelease.executableSha256,
      identity,
      reverify: async (reverifyOptions = {}) => {
        const reverifySignal = optionSignal(reverifyOptions);
        throwIfAborted(reverifySignal);
        if (cleanupPromise !== undefined) {
          throw new Error("Grok staged candidate cleanup has started.");
        }
        const current = await verifyStagedFile(
          stagedPath,
          retainedFile,
          reverifySignal,
        );
        assertSameVerifiedIdentity(identity, current);
        throwIfAborted(reverifySignal);
        return current;
      },
      cleanup,
    });
  } catch (error) {
    await retainedFile?.close().catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
