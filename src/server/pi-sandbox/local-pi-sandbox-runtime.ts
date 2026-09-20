import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  SidecarOperationRegistry,
  type SidecarByteStream,
} from "../../internal/sidecar-protocol/index.js";
import { SIDECAR_MINIMUM_NODE_VERSION } from "../../internal/sidecar-protocol/sidecar-runtime-version.js";
import type {
  EnvironmentOwnedProcessChannel,
  ExecutionEnvironmentChannelProvider,
} from "../execution/environment-channel.js";
import {
  SIDECAR_ARTIFACT_ID,
  SIDECAR_ARTIFACT_MODES,
  type SidecarArtifactRegistration,
} from "../sidecar/sidecar-artifact.js";
import type { SidecarArtifactInstallation } from "../sidecar/sidecar-provisioner.js";
import { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import {
  buildPiBubblewrapArguments,
  defaultPiSandboxSystemMounts,
} from "./bubblewrap-policy.js";
import type {
  PiSandboxAllocation,
  PiSandboxWorkerArtifact,
  PiSandboxWorkspaceLease,
} from "./contracts.js";
import { PI_SANDBOX_HOME, PI_SANDBOX_WORKSPACE } from "./contracts.js";
import {
  PiSandboxWorkspaceContextReader,
  PiSandboxWorkspaceToolExecutor,
  type PiSandboxWorkerOperationRuntime,
} from "./pi-sandbox-workspace-executor.js";

const WORKER_CLEANUP = Object.freeze({
  gracefulCloseMilliseconds: 1_000,
  terminateMilliseconds: 2_000,
  killMilliseconds: 2_000,
});

export interface LocalPiSandboxRuntimeOptions {
  readonly environmentLabel: string;
  readonly channels: ExecutionEnvironmentChannelProvider;
  readonly bubblewrapExecutablePath: string;
  readonly workerNodePath: string;
  readonly workerArtifact: PiSandboxWorkerArtifact;
  readonly systemMounts?: readonly string[];
  readonly onWorkerDiagnostic?: (diagnostic: string) => void;
}

/** Owns exactly one Bubblewrap worker generation per leased thread allocation. */
export class LocalPiSandboxRuntime {
  readonly #entries = new Map<string, WorkerEntry | Promise<WorkerEntry>>();
  readonly #environmentLabel: string;
  readonly #channels: ExecutionEnvironmentChannelProvider;
  readonly #bubblewrapExecutablePath: string;
  readonly #workerNodePath: string;
  readonly #workerArtifact: PiSandboxWorkerArtifact;
  readonly #systemMounts: readonly string[];
  readonly #onWorkerDiagnostic: (diagnostic: string) => void;
  #generation = 0;
  #closed = false;

  constructor(options: LocalPiSandboxRuntimeOptions) {
    if (!options.environmentLabel)
      throw new Error("pi_sandbox_environment_label_invalid");
    this.#environmentLabel = options.environmentLabel;
    this.#channels = options.channels;
    this.#bubblewrapExecutablePath = options.bubblewrapExecutablePath;
    this.#workerNodePath = options.workerNodePath;
    this.#workerArtifact = options.workerArtifact;
    this.#systemMounts = options.systemMounts ?? defaultPiSandboxSystemMounts();
    this.#onWorkerDiagnostic = options.onWorkerDiagnostic ?? (() => undefined);
  }

  async acquire(
    allocation: PiSandboxAllocation,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PiSandboxWorkspaceLease> {
    if (this.#closed) throw new Error("pi_sandbox_runtime_closed");
    this.#assertAllocationScope(allocation);
    signal.throwIfAborted();
    let pending = this.#entries.get(allocation.allocationId);
    if (!pending) {
      pending = this.#start(allocation, signal);
      this.#entries.set(allocation.allocationId, pending);
    }
    let entry: WorkerEntry;
    try {
      entry = await pending;
    } catch (error) {
      if (this.#entries.get(allocation.allocationId) === pending) {
        this.#entries.delete(allocation.allocationId);
      }
      throw error;
    }
    entry.assertAllocation(allocation);
    entry.retainThread();
    if (this.#entries.get(allocation.allocationId) === pending) {
      this.#entries.set(allocation.allocationId, entry);
    }
    let released = false;
    return Object.freeze({
      allocationId: allocation.allocationId,
      semanticHome: PI_SANDBOX_HOME,
      semanticCwd: PI_SANDBOX_HOME,
      workspaceAccess: allocation.workspaceAccess,
      serviceCwd: allocation.serviceCwd,
      hostHomePath: allocation.hostHomePath,
      hostWorkspacePath: allocation.hostWorkspacePath,
      executor: entry.executor,
      contextReader: entry.contextReader,
      environmentLabel: this.#environmentLabel,
      release: async () => {
        if (released) return;
        released = true;
        await entry.releaseThread();
        if (
          entry.isUnused &&
          this.#entries.get(allocation.allocationId) === entry
        ) {
          this.#entries.delete(allocation.allocationId);
        }
      },
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const values = [...this.#entries.values()];
    this.#entries.clear();
    const entries = await Promise.all(
      values.map((value) => Promise.resolve(value).catch(() => undefined)),
    );
    await Promise.all(entries.map((entry) => entry?.forceClose()));
  }

  async #start(allocation: PiSandboxAllocation, signal: AbortSignal) {
    await validateAllocationPaths(allocation);
    const [artifact, nodePath, systemMounts, rg, fd] = await Promise.all([
      validateArtifact(this.#workerArtifact),
      canonicalExecutable(this.#workerNodePath, "pi_sandbox_node_invalid"),
      existingMounts(this.#systemMounts),
      sandboxSearchExecutable("rg"),
      sandboxSearchExecutable("fd"),
    ]);
    const generation = ++this.#generation;
    const sessionNonce = randomBytes(32).toString("base64url");
    const prepared = await this.#channels.prepareOwnedProcess(
      allocation.scope,
      {
        executablePath: this.#bubblewrapExecutablePath,
        workingDirectory: allocation.hostHomePath,
      },
    );
    const arguments_ = [
      ...buildPiBubblewrapArguments({
        hostHomePath: allocation.hostHomePath,
        hostWorkspacePath: allocation.hostWorkspacePath,
        workspaceAccess: allocation.workspaceAccess,
        workerArtifactPath: artifact.path,
        workerNodePath: nodePath,
        searchExecutablePaths: {
          rg: rg.path,
          fd: fd.path,
        },
        networkMode: allocation.networkMode,
        systemMounts,
      }),
      "--expected-digest",
      this.#workerArtifact.sha256,
      "--build-id",
      this.#workerArtifact.buildId,
      "--carrier-generation",
      String(generation),
    ];
    const channel = await this.#channels.openOwnedProcess(
      allocation.scope,
      {
        prepared,
        arguments: arguments_,
        environment: {},
        cleanup: WORKER_CLEANUP,
      },
      signal,
    );
    const workerDiagnostics: string[] = [];
    drainStderr(channel, (diagnostic) => {
      if (workerDiagnostics.length < 8) workerDiagnostics.push(diagnostic);
      this.#onWorkerDiagnostic(diagnostic);
    });
    const stream = ownedProcessByteStream(channel);
    try {
      await channel.writeStdin(
        Buffer.from(
          `${JSON.stringify({
            sessionNonce,
            searchSha256: { rg: rg.sha256, fd: fd.sha256 },
          })}\n`,
          "utf8",
        ),
        { signal },
      );
      const session = await SidecarClientSession.start({ transportKind: "pi_sandbox_stdio",
        stream,
        carrierGeneration: generation,
        sessionNonce,
        artifact: sidecarArtifactShape(
          this.#workerArtifact,
          artifact.path,
          artifact.bytes,
        ),
        installation: inertInstallation(),
        signal,
        authorizedCapabilities: [
          { capabilityId: "workspace_tools", majorVersion: 2 },
          { capabilityId: "workspace_context", majorVersion: 1 },
        ],
        authorizedRuntimeCapabilities: [],
        sedesOperations: new SidecarOperationRegistry(),
      });
      return new WorkerEntry(allocation, generation, channel, session);
    } catch (error) {
      await channel
        .close("pi_sandbox_worker_handshake_failed")
        .catch(() => undefined);
      throw new Error(
        workerDiagnostics.length > 0
          ? `pi_sandbox_worker_handshake_failed:${workerDiagnostics.join("")}`
          : "pi_sandbox_worker_handshake_failed",
        { cause: error },
      );
    }
  }

  #assertAllocationScope(allocation: PiSandboxAllocation): void {
    if (
      allocation.scope.tenantId !== this.#channels.scope.tenantId ||
      allocation.scope.principalId !== this.#channels.scope.principalId ||
      allocation.scope.executionEnvironmentId !==
        this.#channels.executionEnvironmentId ||
      !allocation.applicationThreadId ||
      !allocation.sourceWorkspaceId
    ) {
      throw new Error("pi_sandbox_allocation_scope_invalid");
    }
  }
}

class WorkerEntry implements PiSandboxWorkerOperationRuntime {
  readonly executor = new PiSandboxWorkspaceToolExecutor(this);
  readonly contextReader = new PiSandboxWorkspaceContextReader(this);
  #threadLeases = 0;
  #operationLeases = 0;
  #closePromise: Promise<void> | undefined;

  constructor(
    readonly allocation: PiSandboxAllocation,
    readonly generation: number,
    readonly channel: EnvironmentOwnedProcessChannel,
    readonly session: SidecarClientSession,
  ) {}

  get isUnused(): boolean {
    return this.#threadLeases === 0 && this.#operationLeases === 0;
  }

  assertAllocation(candidate: PiSandboxAllocation): void {
    if (
      candidate.applicationThreadId !== this.allocation.applicationThreadId ||
      candidate.sourceWorkspaceId !== this.allocation.sourceWorkspaceId ||
      candidate.hostHomePath !== this.allocation.hostHomePath ||
      candidate.hostWorkspacePath !== this.allocation.hostWorkspacePath ||
      candidate.serviceCwd !== this.allocation.serviceCwd ||
      candidate.networkMode !== this.allocation.networkMode ||
      candidate.workspaceAccess !== this.allocation.workspaceAccess
    ) {
      throw new Error("pi_sandbox_allocation_identity_changed");
    }
  }

  retainThread(): void {
    if (this.#closePromise) throw new Error("pi_sandbox_worker_closed");
    this.#threadLeases += 1;
  }

  async releaseThread(): Promise<void> {
    if (this.#threadLeases <= 0)
      throw new Error("pi_sandbox_thread_lease_invalid");
    this.#threadLeases -= 1;
    await this.#closeIfUnused();
  }

  async acquireOperation(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#closePromise || this.#threadLeases === 0) {
      throw new Error("pi_sandbox_worker_unavailable");
    }
    this.#operationLeases += 1;
    let released = false;
    return {
      session: this.session,
      carrierGeneration: this.generation,
      release: () => {
        if (released) return;
        released = true;
        this.#operationLeases -= 1;
        void this.#closeIfUnused();
      },
    };
  }

  forceClose(): Promise<void> {
    return (this.#closePromise ??= this.#close("pi_sandbox_runtime_closed"));
  }

  async #closeIfUnused(): Promise<void> {
    if (!this.isUnused) return;
    await (this.#closePromise ??= this.#close("pi_sandbox_thread_released"));
  }

  async #close(reason: string): Promise<void> {
    await this.session.close(reason).catch(() => undefined);
    await this.channel.close(reason);
  }
}

async function validateAllocationPaths(
  allocation: PiSandboxAllocation,
): Promise<void> {
  const [home, workspace, service] = await Promise.all([
    canonicalDirectory(allocation.hostHomePath),
    canonicalDirectory(allocation.hostWorkspacePath),
    canonicalDirectory(allocation.serviceCwd),
  ]);
  if (
    home !== allocation.hostHomePath ||
    workspace !== allocation.hostWorkspacePath ||
    service !== allocation.serviceCwd ||
    (allocation.workspaceAccess === "writable_clone"
      ? !pathIsWithin(home, workspace)
      : pathIsWithin(home, workspace) || pathIsWithin(workspace, home))
  ) {
    throw new Error("pi_sandbox_allocation_paths_invalid");
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function canonicalDirectory(value: string): Promise<string> {
  const canonical = await realpath(value).catch(() => "");
  return canonical && (await stat(canonical)).isDirectory() ? canonical : "";
}

async function canonicalExecutable(
  value: string,
  code: string,
): Promise<string> {
  const canonical = await realpath(value).catch(() => "");
  const metadata = canonical
    ? await stat(canonical).catch(() => undefined)
    : undefined;
  if (!canonical || !metadata?.isFile()) throw new Error(code);
  await access(canonical, fsConstants.X_OK).catch((cause) => {
    throw new Error(code, { cause });
  });
  return canonical;
}

async function validateArtifact(
  artifact: PiSandboxWorkerArtifact,
): Promise<{ readonly path: string; readonly bytes: number }> {
  if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
    throw new Error("pi_sandbox_worker_artifact_invalid");
  }
  const canonical = await realpath(artifact.executablePath).catch(() => "");
  const metadata = canonical
    ? await stat(canonical).catch(() => undefined)
    : undefined;
  if (!canonical || !metadata?.isFile()) {
    throw new Error("pi_sandbox_worker_artifact_invalid");
  }
  const digest = createHash("sha256")
    .update(await readFile(canonical))
    .digest("hex");
  if (digest !== artifact.sha256)
    throw new Error("pi_sandbox_worker_digest_mismatch");
  return { path: canonical, bytes: metadata.size };
}

async function existingMounts(
  configured: readonly string[],
): Promise<readonly string[]> {
  const result: string[] = [];
  for (const mount of configured) {
    const metadata = await lstat(mount).catch(() => undefined);
    if (metadata) result.push(mount);
  }
  if (result.length === 0)
    throw new Error("pi_sandbox_system_mounts_unavailable");
  return Object.freeze(result);
}

/**
 * These exact files are mounted read-only into the sandbox; unlike direct
 * host execution, writable parent directories cannot change them afterward.
 */
async function sandboxSearchExecutable(
  kind: "rg" | "fd",
): Promise<{ readonly path: string; readonly sha256: string }> {
  const candidates = [
    path.join(homedir(), ".pi", "agent", "bin", kind),
    path.join("/usr/bin", kind),
  ];
  for (const candidate of candidates) {
    const lexical = await lstat(candidate).catch(() => undefined);
    if (!lexical?.isFile() || lexical.isSymbolicLink()) continue;
    const canonical = await realpath(candidate).catch(() => "");
    if (canonical !== candidate) continue;
    const metadata = await stat(canonical).catch(() => undefined);
    if (
      !metadata?.isFile() ||
      metadata.size <= 0 ||
      (metadata.mode & 0o022) !== 0 ||
      (metadata.mode & 0o111) === 0 ||
      (metadata.uid !== 0 && metadata.uid !== process.getuid?.())
    ) {
      continue;
    }
    return {
      path: canonical,
      sha256: createHash("sha256")
        .update(await readFile(canonical))
        .digest("hex"),
    };
  }
  throw new Error(`pi_sandbox_search_${kind}_unavailable`);
}

function sidecarArtifactShape(
  artifact: PiSandboxWorkerArtifact,
  executablePath: string,
  artifactBytes: number,
): SidecarArtifactRegistration {
  return {
    artifactId: SIDECAR_ARTIFACT_ID,
    modes: SIDECAR_ARTIFACT_MODES,
    executableDirectory: path.dirname(executablePath),
    executablePath,
    artifactSha256: artifact.sha256,
    artifactBytes,
    buildId: artifact.buildId,
    minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION,
    nativeAssets: [],
  };
}

function inertInstallation(): SidecarArtifactInstallation {
  return {
    accountHome: PI_SANDBOX_HOME,
    nodeExecutable: "/runtime/node",
    stateRoot: `${PI_SANDBOX_HOME}/.local/state`,
    environment: {},
    executableDirectory: "/run/sedes",
    executablePath: "/run/sedes/sedes",
  };
}

function ownedProcessByteStream(
  channel: EnvironmentOwnedProcessChannel,
): SidecarByteStream {
  return {
    bytes: channel.stdout,
    closed: channel.closed.then((closure) => ({
      reason: closure.reason,
      ...(closure.cause ? { cause: closure.cause } : {}),
    })),
    write: (bytes, options) => channel.writeStdin(bytes, options),
    close: (reason) => channel.close(reason),
  };
}

function drainStderr(
  channel: EnvironmentOwnedProcessChannel,
  onDiagnostic: (diagnostic: string) => void,
): void {
  void (async () => {
    let bytes = 0;
    for await (const chunk of channel.stderr) {
      bytes += chunk.byteLength;
      onDiagnostic(
        Buffer.from(chunk)
          .toString("utf8")
          .replace(/[\r\n\u0000-\u001f\u007f]/gu, "_")
          .slice(0, 512),
      );
      if (bytes > 64 * 1024) {
        await channel
          .close("pi_sandbox_worker_stderr_limit")
          .catch(() => undefined);
        return;
      }
    }
  })().catch(() => undefined);
}
