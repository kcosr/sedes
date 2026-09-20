#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import {
  LengthPrefixedSidecarFrameTransport,
  SidecarOperationRegistry,
  SidecarProtocolPeer,
  registerControlV2Operations,
  registerWorkspaceContextV1Operations,
  registerWorkspaceToolsShellV2Operations,
  registerWorkspaceToolsV2Operations,
  type SidecarByteStream,
  WORKSPACE_CONTEXT_V1_LIMITS,
  WORKSPACE_TOOLS_SHELL_V2_LIMITS,
  WORKSPACE_TOOLS_V2_LIMITS,
} from "../../internal/sidecar-protocol/index.js";
import { CanonicalMutationSerializer } from "../workspace-files/canonical-mutation-serializer.js";
import { WorkspaceContextSidecarHost } from "../sidecar/workspace-context-sidecar-host.js";
import { WorkspaceToolsShellHost } from "../sidecar/workspace-tools-shell-host.js";
import { WorkspaceToolsSidecarHost } from "../sidecar/workspace-tools-sidecar-host.js";
import { TrustedSearchExecutableResolver } from "../workspace-tools/trusted-search-executables.js";
import { PI_SANDBOX_HOME } from "./contracts.js";

interface WorkerArguments {
  readonly expectedDigest: string;
  readonly buildId: string;
  readonly carrierGeneration: number;
}

void runPiSandboxWorker(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${boundedDiagnostic(error instanceof Error ? error.message : "pi_sandbox_worker_failed")}\n`,
  );
  process.exitCode = 1;
});

export async function runPiSandboxWorker(
  arguments_: readonly string[],
): Promise<void> {
  const input = parseArguments(arguments_);
  const bootstrap = await readBootstrap();
  const sessionNonce = bootstrap.sessionNonce;
  if (process.platform !== "linux")
    throw new Error("pi_sandbox_linux_required");
  if (
    process.cwd() !== PI_SANDBOX_HOME ||
    process.env.HOME !== PI_SANDBOX_HOME
  ) {
    throw new Error("pi_sandbox_worker_environment_invalid");
  }
  const executablePath = process.argv[1];
  if (!executablePath) throw new Error("pi_sandbox_worker_path_unavailable");
  const digest = createHash("sha256")
    .update(await readFile(executablePath))
    .digest("hex");
  if (digest !== input.expectedDigest) {
    throw new Error("pi_sandbox_worker_digest_mismatch");
  }
  for (const kind of ["rg", "fd"] as const) {
    const searchDigest = createHash("sha256")
      .update(await readFile(`/runtime/${kind}`))
      .digest("hex");
    if (searchDigest !== bootstrap.searchSha256[kind]) {
      throw new Error("pi_sandbox_search_digest_mismatch");
    }
  }

  const transport = new LengthPrefixedSidecarFrameTransport({
    assurance: {
      kind: "owned_bubblewrap_stdio",
      carrierGeneration: input.carrierGeneration,
    },
    stream: stdioByteStream(),
  });
  const registry = new SidecarOperationRegistry();
  let peer!: SidecarProtocolPeer;
  const mutations = new CanonicalMutationSerializer();
  const search = new TrustedSearchExecutableResolver({
    homeDirectory: PI_SANDBOX_HOME,
    environmentPath: "/runtime",
    inspectPath: async (candidate) => {
      if (candidate !== "/runtime/rg" && candidate !== "/runtime/fd") {
        throw new Error("pi_sandbox_search_path_invalid");
      }
      const canonicalPath = await realpath(candidate);
      const metadata = await lstat(canonicalPath);
      if (
        canonicalPath !== candidate ||
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o022) !== 0 ||
        (metadata.mode & 0o111) === 0 ||
        metadata.size <= 0
      ) {
        throw new Error("pi_sandbox_search_executable_invalid");
      }
      return {
        canonicalPath,
        device: metadata.dev,
        inode: metadata.ino,
        size: metadata.size,
        modifiedMilliseconds: metadata.mtimeMs,
        mode: metadata.mode,
      };
    },
  });
  const workspaceTools = new WorkspaceToolsSidecarHost({
    sessionNonce,
    mutations,
    search,
  });
  const workspaceContext = new WorkspaceContextSidecarHost();
  const shell = new WorkspaceToolsShellHost({
    acknowledgeOperation: (operationId) => {
      workspaceTools.acknowledgeOperation(operationId);
    },
    resolveWorkspace: (handle) => workspaceTools.resolveWorkspace(handle),
    openStream: ({ streamId, initialCreditBytes }) =>
      peer.openOutgoingStream({
        streamId,
        capabilityId: "workspace_tools",
        majorVersion: 2,
        initialCreditBytes,
      }),
    admitOperation: (handle, operationId, payload, operation) =>
      workspaceTools.admitOperation(handle, operationId, payload, operation),
    onCleanupFailure: () => {
      void peer
        .close("pi_sandbox_shell_cleanup_unproven")
        .catch(() => undefined);
    },
  });
  registerWorkspaceToolsV2Operations(registry, workspaceTools.handlers);
  registerWorkspaceToolsShellV2Operations(registry, shell.handlers);
  registerWorkspaceContextV1Operations(registry, workspaceContext.handlers);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () =>
    (shutdownPromise ??= (async () => {
      await shell.close();
      workspaceTools.close();
      workspaceContext.close();
    })());
  registerControlV2Operations(registry, {
    buildId: input.buildId,
    artifactSha256: digest,
    enabledSidecarCapabilities: [
      { capabilityId: "workspace_tools", majorVersion: 2 },
      { capabilityId: "workspace_context", majorVersion: 1 },
    ],
    enabledSedesCapabilities: [],
    capabilityEvidence: [
      {
        capabilityId: "workspace_tools",
        majorVersion: 2,
        limits: WORKSPACE_TOOLS_V2_LIMITS,
        streamLimits: WORKSPACE_TOOLS_SHELL_V2_LIMITS.streamLimits,
        processLimits: WORKSPACE_TOOLS_SHELL_V2_LIMITS.processLimits,
      },
      {
        capabilityId: "workspace_context",
        majorVersion: 1,
        limits: WORKSPACE_CONTEXT_V1_LIMITS,
      },
    ],
    onGoAway: () => shutdown(),
  });
  peer = new SidecarProtocolPeer({
    role: "sidecar",
    transport,
    sessionNonce,
    registry,
  });
  const stop = () => {
    void shutdown()
      .then(() => peer.close("pi_sandbox_worker_signal"))
      .catch(() => peer.close("pi_sandbox_worker_cleanup_failed"))
      .catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    peer.start();
    await transport.closed;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await shutdown();
    await peer.close("pi_sandbox_worker_exit").catch(() => undefined);
  }
}

function parseArguments(arguments_: readonly string[]): WorkerArguments {
  if (
    arguments_.length !== 6 ||
    arguments_[0] !== "--expected-digest" ||
    arguments_[2] !== "--build-id" ||
    arguments_[4] !== "--carrier-generation"
  ) {
    throw new Error("pi_sandbox_worker_arguments_invalid");
  }
  const expectedDigest = arguments_[1]!;
  const buildId = arguments_[3]!;
  const generationText = arguments_[5]!;
  const carrierGeneration = Number(generationText);
  if (
    !/^[0-9a-f]{64}$/u.test(expectedDigest) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(buildId) ||
    !/^[1-9][0-9]*$/u.test(generationText) ||
    !Number.isSafeInteger(carrierGeneration)
  ) {
    throw new Error("pi_sandbox_worker_arguments_invalid");
  }
  return { expectedDigest, buildId, carrierGeneration };
}

async function readBootstrap(): Promise<{
  readonly sessionNonce: string;
  readonly searchSha256: Readonly<{ rg: string; fd: string }>;
}> {
  return await new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", fail);
      process.stdin.removeListener("error", fail);
    };
    const fail = () => {
      cleanup();
      reject(new Error("pi_sandbox_worker_bootstrap_invalid"));
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.byteLength > 512) fail();
        return;
      }
      if (newline > 511) return fail();
      cleanup();
      process.stdin.pause();
      const remainder = buffered.subarray(newline + 1);
      if (remainder.byteLength > 0) process.stdin.unshift(remainder);
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
      } catch {
        return fail();
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Object.keys(parsed).sort().join("\0") !==
          "searchSha256\0sessionNonce" ||
        !("sessionNonce" in parsed) ||
        typeof parsed.sessionNonce !== "string" ||
        !/^[A-Za-z0-9_-]{32,160}$/u.test(parsed.sessionNonce) ||
        !("searchSha256" in parsed) ||
        typeof parsed.searchSha256 !== "object" ||
        parsed.searchSha256 === null ||
        Object.keys(parsed.searchSha256).sort().join("\0") !== "fd\0rg" ||
        !("rg" in parsed.searchSha256) ||
        !("fd" in parsed.searchSha256) ||
        typeof parsed.searchSha256.rg !== "string" ||
        typeof parsed.searchSha256.fd !== "string" ||
        !/^[0-9a-f]{64}$/u.test(parsed.searchSha256.rg) ||
        !/^[0-9a-f]{64}$/u.test(parsed.searchSha256.fd)
      ) {
        return fail();
      }
      resolve({
        sessionNonce: parsed.sessionNonce,
        searchSha256: {
          rg: parsed.searchSha256.rg,
          fd: parsed.searchSha256.fd,
        },
      });
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", fail);
    process.stdin.once("error", fail);
    process.stdin.resume();
  });
}

function stdioByteStream(): SidecarByteStream {
  let settled = false;
  let settle!: (closure: {
    readonly reason: string;
    readonly cause?: Error;
  }) => void;
  const closed = new Promise<{
    readonly reason: string;
    readonly cause?: Error;
  }>((resolve) => {
    settle = resolve;
  });
  const finish = (reason: string, cause?: Error) => {
    if (settled) return;
    settled = true;
    settle({ reason, ...(cause ? { cause } : {}) });
  };
  process.stdin.once("end", () => finish("stdin_eof"));
  process.stdin.once("close", () => finish("stdin_closed"));
  process.stdin.once("error", (error) => finish("stdin_error", error));
  process.stdout.once("error", (error) => finish("stdout_error", error));
  return {
    bytes: (async function* () {
      for await (const chunk of process.stdin) yield new Uint8Array(chunk);
    })(),
    closed,
    write: async (bytes, options) => {
      options?.signal?.throwIfAborted();
      if (settled || !process.stdout.writable)
        throw new Error("worker_stdout_closed");
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(Buffer.from(bytes), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    },
    close: async (reason) => {
      finish(reason);
      process.stdin.pause();
      await new Promise<void>((resolve) => process.stdout.end(resolve));
    },
  };
}

function boundedDiagnostic(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/gu, "_").slice(0, 240);
}
