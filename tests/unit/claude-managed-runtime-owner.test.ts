import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  LengthPrefixedSidecarFrameTransport,
  SidecarOperationRegistry,
  SidecarProtocolPeer,
  registerControlV2Operations,
  type SidecarByteStream,
  type SidecarByteStreamClosure,
} from "../../src/internal/sidecar-protocol/index.js";
import type { EnvironmentChannelScope, ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import type { ManagedWorkerArtifactRegistration } from "../../src/server/managed-workers/artifact.js";
import { ClaudeManagedRuntimeOwner, type ClaudeManagedRuntimeOwnerOptions } from "../../src/server/backends/claude/claude-managed-runtime-owner.js";
import { CLAUDE_RUNTIME_WORKER_CLEANUP_PROVEN_FAILURE_EXIT_CODE } from "../../src/server/backends/claude/worker/claude-outer-process-supervisor.js";
import {
  CLAUDE_RUNTIME_CAPABILITY_ID,
  CLAUDE_RUNTIME_MAJOR_VERSION,
  claudeRuntimeHostOperations,
  registerClaudeRuntimeV1WorkerOperations,
  type ClaudeRuntimeV1WorkerHandlers,
} from "../../src/server/backends/claude/worker/claude-runtime-v1.js";

const scope = Object.freeze({
  tenantId: "tenant-1",
  principalId: "principal-1",
  backendInstanceId: "claude-1",
  executionEnvironmentId: "local",
});

describe("ClaudeManagedRuntimeOwner", () => {
  it("releases the shared worker only after the last query lease closes and can restart it", async () => {
    const f = runtimeHarness();
    const owner = f.owner();
    const options = {
      executablePath: "/usr/bin/claude", initializationTimeoutMs: 30_000,
      sessionId: "00000000-0000-4000-8000-000000000001", cwd: "/workspace",
      launch: "new" as const, environment: {}, onMessage: () => {},
    };
    const first = owner.createSession(options);
    const last = owner.createSession({ ...options, sessionId: "00000000-0000-4000-8000-000000000002" });
    await owner.listSessions({}, {});
    expect(f.open).toHaveBeenCalledTimes(1);
    await first.close();
    await owner.listSessions({}, {});
    expect(f.open).toHaveBeenCalledTimes(1);
    await last.close();
    await owner.listSessions({}, {});
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.backgroundErrors).toEqual([]);
    await owner.close();
  });

  it("does not launch until a semantic operation starts", async () => {
    const open = vi.fn();
    const owner = new ClaudeManagedRuntimeOwner({
      scope,
      environmentKind: "local",
      artifact: Promise.resolve({} as ManagedWorkerArtifactRegistration),
      channels: channels(open),
      workingDirectory: "/workspace",
      executablePath: "/usr/bin/claude",
      configDirectory: "/home/test/.claude",
      initializationTimeoutMs: 30_000,
    });
    const session = owner.createSession({
      executablePath: "/usr/bin/claude",
      initializationTimeoutMs: 30_000,
      sessionId: "00000000-0000-4000-8000-000000000001",
      cwd: "/workspace",
      launch: "new",
      environment: {},
      onMessage: () => undefined,
    });
    expect(open).not.toHaveBeenCalled();
    await owner.close();
    await expect(session.start()).rejects.toThrow("claude_managed_runtime_closed");
    expect(open).not.toHaveBeenCalled();
    await expect(owner.close()).resolves.toBeUndefined();
  });

  it("rejects remote execution before opening a channel", () => {
    const open = vi.fn();
    expect(() => new ClaudeManagedRuntimeOwner({
      scope,
      environmentKind: "ssh" as "local",
      artifact: {} as ManagedWorkerArtifactRegistration,
      channels: channels(open),
      workingDirectory: "/workspace",
      executablePath: "/usr/bin/claude",
      configDirectory: "/home/test/.claude",
      initializationTimeoutMs: 30_000,
    })).toThrow("claude_remote_execution_unsupported");
    expect(open).not.toHaveBeenCalled();
  });

  it("fails closed without the static managed-worker channel capability", () => {
    expect(() => new ClaudeManagedRuntimeOwner({
      scope,
      environmentKind: "local",
      artifact: Promise.resolve({} as ManagedWorkerArtifactRegistration),
      channels: channels(undefined),
      workingDirectory: "/workspace",
      executablePath: "/usr/bin/claude",
      configDirectory: "/home/test/.claude",
      initializationTimeoutMs: 30_000,
    })).toThrow("claude_managed_runtime_configuration_invalid");
  });

  it("rejects environment authority outside the exact query triple", () => {
    const owner = new ClaudeManagedRuntimeOwner({
      scope,
      environmentKind: "local",
      artifact: Promise.resolve({} as ManagedWorkerArtifactRegistration),
      channels: channels(vi.fn()),
      workingDirectory: "/workspace",
      executablePath: "/usr/bin/claude",
      configDirectory: "/home/test/.claude",
      initializationTimeoutMs: 30_000,
    });
    expect(() => owner.createSession({
      executablePath: "/usr/bin/claude",
      initializationTimeoutMs: 30_000,
      sessionId: "00000000-0000-4000-8000-000000000001",
      cwd: "/workspace",
      launch: "new",
      environment: { ANTHROPIC_API_KEY: "secret" },
      onMessage: () => undefined,
    })).toThrow("claude_managed_runtime_environment_invalid");
  });

  it("replaces a failed generation when the outer status proves cleanup", async () => {
    const harness = runtimeHarness();
    const owner = harness.owner();
    await expect(listSessions(owner)).resolves.toEqual([]);
    harness.generations[0]!.finish({
      reason: "exit",
      exitCode: CLAUDE_RUNTIME_WORKER_CLEANUP_PROVEN_FAILURE_EXIT_CODE,
      signal: null,
    });
    await waitUntil(() => harness.backgroundErrors.length === 1);
    await expect(listSessions(owner)).resolves.toEqual([]);
    expect(harness.open).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it.each([true, false])("fences mixed default selectors only after launch and releases after cleanup (default first: %s)", async defaultFirst => {
    const harness = runtimeHarness();
    const first = harness.owner({ configDirectory: defaultFirst ? undefined : "/explicit", scope: { ...scope, ...harness.ownerScope, backendInstanceId: "first" } });
    const second = harness.owner({ configDirectory: defaultFirst ? "/explicit" : undefined, scope: { ...scope, ...harness.ownerScope, backendInstanceId: "second" } });
    try {
      await expect(listSessions(first)).resolves.toEqual([]);
      await expect(listSessions(first)).resolves.toEqual([]);
      await expect(listSessions(second)).rejects.toThrow("claude_default_config_directory_conflict");
      expect(harness.open).toHaveBeenCalledTimes(1);
      await first.close();
      await expect(listSessions(second)).resolves.toEqual([]);
      expect(harness.open).toHaveBeenCalledTimes(2);
    } finally { await first.close(); await second.close(); }
  });

  it("allows separate explicit selectors and independent tenant/principal/environment scopes", async () => {
    const shared = { ...scope, executionEnvironmentId: randomUUID() };
    const firstHarness = runtimeHarness(shared);
    const explicit = firstHarness.owner();
    const secondExplicit = firstHarness.owner({ configDirectory: "/another-explicit" });
    const scopes = [
      { ...shared, tenantId: "another-tenant" },
      { ...shared, principalId: "another-principal" },
      { ...shared, executionEnvironmentId: randomUUID() },
    ];
    const defaults = scopes.map(value => runtimeHarness(value).owner({ configDirectory: undefined }));
    try {
      for (const owner of [explicit, secondExplicit, ...defaults]) await expect(listSessions(owner)).resolves.toEqual([]);
    } finally { await Promise.all([explicit, secondExplicit, ...defaults].map(owner => owner.close())); }
  });

  it("releases the default selector on proven generation loss and on failed prelaunch admission", async () => {
    const harness = runtimeHarness();
    const first = harness.owner({ configDirectory: undefined });
    const second = harness.owner();
    try {
      harness.open.mockRejectedValueOnce(new Error("launch_refused"));
      await expect(listSessions(first)).rejects.toThrow("launch_refused");
      await expect(listSessions(second)).resolves.toEqual([]);
      await second.close();
      await expect(listSessions(first)).resolves.toEqual([]);
      harness.generations[1]!.finish({ reason: "exit", exitCode: CLAUDE_RUNTIME_WORKER_CLEANUP_PROVEN_FAILURE_EXIT_CODE, signal: null });
      await waitUntil(() => harness.backgroundErrors.length === 1);
      await expect(listSessions(first)).resolves.toEqual([]);
    } finally { await first.close(); await second.close(); }
  });

  it("retains a default reservation when worker cleanup cannot be proven", async () => {
    const harness = runtimeHarness();
    const first = harness.owner({ configDirectory: undefined });
    const second = harness.owner();
    await listSessions(first);
    harness.generations[0]!.finish({ reason: "exit", exitCode: 255, signal: null });
    await waitUntil(() => harness.backgroundErrors.length === 1);
    await expect(first.close()).rejects.toThrow("managed_worker_local_cleanup_unproven");
    await expect(listSessions(second)).rejects.toThrow("claude_default_config_directory_conflict");
    expect(harness.open).toHaveBeenCalledTimes(1);
    await second.close();
  });

  it("permanently poisons replacement after an unproven carrier closure", async () => {
    const harness = runtimeHarness();
    const owner = harness.owner();
    await expect(listSessions(owner)).resolves.toEqual([]);
    harness.generations[0]!.finish({
      reason: "exit",
      exitCode: 255,
      signal: null,
    });
    await waitUntil(() => harness.backgroundErrors.length === 1);
    await expect(listSessions(owner)).rejects.toThrow(
      "claude_managed_runtime_cleanup_unproven",
    );
    expect(harness.open).toHaveBeenCalledTimes(1);
    await expect(owner.close()).rejects.toThrow(
      "managed_worker_local_cleanup_unproven",
    );
  });
});

function channels(
  open: ReturnType<typeof vi.fn> | undefined,
  ownerScope: EnvironmentChannelScope = scope,
): ExecutionEnvironmentChannelProvider {
  return {
    scope: { tenantId: ownerScope.tenantId, principalId: ownerScope.principalId },
    executionEnvironmentId: ownerScope.executionEnvironmentId,
    reportRuntimeAvailability: vi.fn().mockResolvedValue(undefined),
    ...(open ? { openInstallationManagedWorker: open } : {}),
  } as unknown as ExecutionEnvironmentChannelProvider;
}

function listSessions(owner: ClaudeManagedRuntimeOwner) {
  return owner.listSessions(
    { dir: "/workspace", limit: 20, offset: 0 },
    {},
  );
}

function runtimeHarness(ownerScope: EnvironmentChannelScope = { ...scope, executionEnvironmentId: randomUUID() }) {
  const artifact = {
    buildId: "owner-lifecycle-test",
    artifactSha256: "a".repeat(64),
  } as ManagedWorkerArtifactRegistration;
  const generations: Array<{
    finish: (closure: SidecarByteStreamClosure) => void;
  }> = [];
  const backgroundErrors: unknown[] = [];
  const open = vi.fn(async (
    _scope: unknown,
    launch: { readonly identity: { readonly carrierGeneration: number; readonly sessionNonce: string } },
  ) => {
    const generation = memoryWorkerGeneration(
      launch.identity.carrierGeneration,
      launch.identity.sessionNonce,
      artifact,
    );
    generations.push(generation);
    return generation.stream;
  });
  return {
    generations,
    ownerScope,
    backgroundErrors,
    open,
    owner: (overrides: Partial<ClaudeManagedRuntimeOwnerOptions> = {}) => new ClaudeManagedRuntimeOwner({
      scope: ownerScope,
      environmentKind: "local",
      artifact,
      channels: channels(open, ownerScope),
      workingDirectory: "/workspace",
      executablePath: "/usr/bin/claude",
      configDirectory: "/home/test/.claude",
      initializationTimeoutMs: 30_000,
      onBackgroundError: (error) => backgroundErrors.push(error),
      ...overrides,
    }),
  };
}

function memoryWorkerGeneration(
  carrierGeneration: number,
  sessionNonce: string,
  artifact: ManagedWorkerArtifactRegistration,
) {
  const ownerToWorker = new PassThrough();
  const workerToOwner = new PassThrough();
  let finished = false;
  let resolveOwner!: (closure: SidecarByteStreamClosure) => void;
  let resolveWorker!: (closure: SidecarByteStreamClosure) => void;
  const ownerClosed = new Promise<SidecarByteStreamClosure>((resolve) => {
    resolveOwner = resolve;
  });
  const workerClosed = new Promise<SidecarByteStreamClosure>((resolve) => {
    resolveWorker = resolve;
  });
  const finish = (closure: SidecarByteStreamClosure) => {
    if (finished) return;
    finished = true;
    ownerToWorker.end();
    workerToOwner.end();
    resolveOwner(closure);
    resolveWorker(closure);
  };
  const stream: SidecarByteStream = Object.freeze({
    bytes: workerToOwner,
    closed: ownerClosed,
    write: async (bytes: Uint8Array) => {
      if (finished) throw new Error("memory_worker_closed");
      ownerToWorker.write(bytes);
    },
    close: async (reason: string) => finish({
      reason,
      exitCode: 0,
      signal: null,
    }),
  });
  const workerStream: SidecarByteStream = Object.freeze({
    bytes: ownerToWorker,
    closed: workerClosed,
    write: async (bytes: Uint8Array) => {
      if (finished) throw new Error("memory_worker_closed");
      workerToOwner.write(bytes);
    },
    close: async (reason: string) => finish({
      reason,
      exitCode: 0,
      signal: null,
    }),
  });
  const registry = new SidecarOperationRegistry();
  registerClaudeRuntimeV1WorkerOperations(registry, lifecycleHandlers());
  registerControlV2Operations(registry, {
    buildId: artifact.buildId,
    artifactSha256: artifact.artifactSha256,
    enabledSidecarCapabilities: [{
      capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
      majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
    }],
    enabledSedesCapabilities: [{
      capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
      majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
      operations: claudeRuntimeHostOperations.map(({ operation }) => operation),
    }],
  });
  const peer = new SidecarProtocolPeer({
    role: "sidecar",
    transport: new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "memory_worker", carrierGeneration },
      stream: workerStream,
    }),
    sessionNonce,
    registry,
  });
  peer.start();
  return { stream, finish };
}

function lifecycleHandlers(): ClaudeRuntimeV1WorkerHandlers {
  const unused = () => {
    throw new Error("owner_lifecycle_unexpected_operation");
  };
  return {
    initialize: (request) => ({
      initialized: true,
      configDirectory: request.configDirectory ?? "/home/worker/.claude",
    }),
    listSessions: () => ({ sessions: [] }),
    probe: unused,
    getSessionInfo: unused,
    getSessionMessages: unused,
    hasSessionTranscript: unused,
    renameSession: unused,
    openQuery: unused,
    sendQuery: unused,
    interruptQuery: unused,
    cancelQueryInput: unused,
    setQueryModel: unused,
    setQueryEffort: unused,
    setQueryPermissionMode: unused,
    closeQuery: unused,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test_wait_timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
