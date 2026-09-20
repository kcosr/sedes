import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CodexManagedTuiRegistry,
  codexManagedTuiBindingFingerprint,
  type CodexManagedTuiBindingAuthority,
  type CodexManagedTuiProcess,
} from "../../src/server/backends/codex/codex-managed-tui-registry.js";
import {
  availableCodexTuiActionIds,
  CODEX_TUI_FEATURE_REF,
  codexTuiStateV1Schema,
} from "../../src/server/backends/codex/codex-tui-feature.js";
import { compiledProviderFeatureRegistry } from "../../src/server/provider-features/compiled-provider-feature-registry.js";
import { ProviderFeatureRegistryError } from "../../src/server/provider-features/provider-feature-registry.js";
import { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import { CodexManagedTuiController } from "../../src/server/backends/codex/codex-managed-tui-controller.js";
import {
  EnvironmentCodexManagedTuiLauncher,
  codexManagedTuiModelPolicySupported,
  codexTuiLaunchPolicyRepresentable,
  resolveCodexManagedTuiExecutable,
} from "../../src/server/backends/codex/codex-managed-tui-launcher.js";
import type { ResolvedCodexRuntimeConfiguration } from "../../src/server/backends/codex/codex-runtime-config.js";
import type {
  EnvironmentOwnedPtyChannel,
  ExecutionEnvironmentChannelProvider,
} from "../../src/server/execution/environment-channel.js";
import { assertCodexLiveModelSelection } from "../../src/server/backends/codex/codex-live-model-selection.js";

const authority: CodexManagedTuiBindingAuthority = Object.freeze({
  scope: Object.freeze({
    tenantId: "tenant-one",
    principalId: "principal-one",
  }),
  applicationThreadId: "thread-one",
  backendInstanceId: "codex-one",
  connectionProfileId: "profile-one",
  executionEnvironmentId: "local-one",
  backendConversationId: "01900000-0000-7000-8000-000000000001",
  workspaceId: "workspace-one",
  canonicalWorkspacePath: "/workspace/one",
  opaqueBindingDetail: "opaque-one",
  runtimeLeaseId: "runtime-lease-one",
  appServerGeneration: 7,
});

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fakeProcess() {
  const output = new PassThrough();
  const closure = deferred<{
    exitCode: number | null;
    signal: string | null;
  }>();
  const write = vi.fn(async () => undefined);
  const resize = vi.fn(async () => undefined);
  const close = vi.fn(async () => {
    output.end();
    closure.resolve({ exitCode: 0, signal: null });
  });
  return {
    process: {
      output,
      closed: closure.promise,
      write,
      resize,
      close,
    } satisfies CodexManagedTuiProcess,
    output,
    closure,
    write,
    resize,
    close,
  };
}

function readyClient(
  input: {
    readonly request?: (...arguments_: readonly unknown[]) => Promise<unknown>;
    readonly generation?: number;
  } = {},
) {
  const generation = input.generation ?? 7;
  const request = vi.fn(input.request ?? (async () => ({})));
  const client = new CodexSharedClientFacade({
    current: () => ({
      generation,
      request: request as never,
      requestWithReceipt: vi.fn() as never,
    }),
    latestGeneration: () => generation,
    retireGeneration: async () => undefined,
  });
  client.updateLifecycle({ state: "ready", generation });
  return { client, request };
}

function handleAuthority() {
  const { appServerGeneration: _, ...result } = authority;
  return result;
}

function externalConfiguration(
  channel: Extract<
    ResolvedCodexRuntimeConfiguration["connection"],
    { readonly ownership: "external" }
  >["channel"],
): ResolvedCodexRuntimeConfiguration {
  return {
    scope: authority.scope,
    instance: {
      id: authority.backendInstanceId,
      tenantId: authority.scope.tenantId,
      kind: "codex_app_server",
      label: "Codex",
      enabled: true,
      configurationRevision: 1,
      protocolRelease: "0.153.0",
    },
    executionEnvironmentId: authority.executionEnvironmentId,
    connection: { ownership: "external", channel },
  };
}

const ordinaryLauncherEnvironment = Object.freeze({
  HOME: "/ordinary-home",
  PATH: "/usr/bin:/bin",
});

function launcherChannels() {
  const pty = new PassThrough();
  const closed = deferred<{
    reason: "exit";
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>();
  const discard = vi.fn();
  type OpenOwnedPty = NonNullable<
    ExecutionEnvironmentChannelProvider["openOwnedPty"]
  >;
  const openOwnedPty = vi.fn(
    async (..._arguments: Parameters<OpenOwnedPty>) =>
      ({
        identity: {} as never,
        bytes: pty,
        closed: closed.promise,
        write: vi.fn(async () => undefined),
        resize: vi.fn(),
        close: vi.fn(async () => undefined),
      }) satisfies EnvironmentOwnedPtyChannel,
  );
  const prepareManagedProcessEndpoint = vi.fn(
    async (_scope, request, generation) =>
      request.kind === "private_unix_websocket"
        ? {
            kind: "managed_process_endpoint" as const,
            processAddress: `unix://${request.socketPath}`,
            endpointIdentity: "socket-proof",
          }
        : {
            kind: "managed_process_endpoint" as const,
            processAddress: request.address,
            endpointIdentity: `route-proof-${generation}`,
            authentication: {
              identity: {} as never,
              value: "top-secret-capability",
              discard,
            },
          },
  );
  type OpenOwnedProcess =
    ExecutionEnvironmentChannelProvider["openOwnedProcess"];
  const openOwnedProcess = vi.fn(
    async (..._arguments: Parameters<OpenOwnedProcess>) => {
      return codexVersionProbeChannel("codex-cli 0.153.0\n");
    },
  );
  const resolveOwnedProcessExecutable = vi.fn(async (_scope, _input) => ({
    kind: "executable" as const,
    canonicalPath: "/environment/install/codex",
  }));
  const channels = {
    scope: authority.scope,
    executionEnvironmentId: authority.executionEnvironmentId,
    resolveOwnedProcessExecutable,
    prepareOwnedProcess: vi.fn(async (scope, input) => ({
      kind: "owned_process" as const,
      scope,
      executable: {
        kind: "executable" as const,
        canonicalPath: input.executablePath,
      },
      workingDirectory: {
        kind: "directory" as const,
        canonicalPath: input.workingDirectory,
      },
    })),
    openOwnedProcess,
    prepareManagedProcessEndpoint,
    openOwnedPty,
    resolveSecret: vi.fn(async (scope, _reference, generation) => ({
      identity: {} as never,
      value: "top-secret-capability",
      discard,
    })),
  } as unknown as ExecutionEnvironmentChannelProvider;
  return {
    channels,
    openOwnedPty,
    discard,
    prepareOwnedProcess: channels.prepareOwnedProcess,
    openOwnedProcess,
    resolveOwnedProcessExecutable,
    prepareManagedProcessEndpoint,
  };
}

function codexVersionProbeChannel(stdoutText: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.end(stdoutText);
  stderr.end();
  return {
    identity: {} as never,
    stdout,
    stderr,
    closed: Promise.resolve({
      reason: "exit" as const,
      exitCode: 0,
      signal: null,
    }),
    write: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("codex.tui@1 feature contract", () => {
  it("registers only for Codex with first-class start/stop lifecycle actions", () => {
    const capability = compiledProviderFeatureRegistry.capability(
      CODEX_TUI_FEATURE_REF,
      "codex_app_server",
      { revision: 2, availability: "available" },
    );
    expect(capability.presentationSlots).toEqual([]);
    expect(capability.operations).toEqual([
      expect.objectContaining({
        actionId: "start",
        confirmation: "none",
        execution: "durable",
        effects: {
          application: "write",
          modelUsage: "none",
          external: "none",
        },
      }),
      expect.objectContaining({
        actionId: "stop",
        confirmation: "none",
        execution: "durable",
      }),
    ]);
    expect(
      compiledProviderFeatureRegistry
        .refs("pi")
        .some(({ featureId }) => featureId === CODEX_TUI_FEATURE_REF.featureId),
    ).toBe(false);
    expect(() =>
      compiledProviderFeatureRegistry.module(CODEX_TUI_FEATURE_REF, "pi"),
    ).toThrow(ProviderFeatureRegistryError);
  });

  it("uses one null argument shape and rejects impossible lifecycle state", () => {
    for (const actionId of ["start", "stop"] as const) {
      expect(
        compiledProviderFeatureRegistry.validateAction({
          ref: CODEX_TUI_FEATURE_REF,
          backendKind: "codex_app_server",
          actionId,
          arguments: null,
        }).arguments,
      ).toBeNull();
      expect(() =>
        compiledProviderFeatureRegistry.validateAction({
          ref: CODEX_TUI_FEATURE_REF,
          backendKind: "codex_app_server",
          actionId,
          arguments: { kind: "object", entries: [] },
        }),
      ).toThrow(ProviderFeatureRegistryError);
    }
    expect(() =>
      codexTuiStateV1Schema.parse({
        lifecycle: "stopped",
        resourceGeneration: 1,
        streamAvailable: true,
      }),
    ).toThrow();
    expect(() =>
      codexTuiStateV1Schema.parse({
        lifecycle: "failed",
        resourceGeneration: 1,
        streamAvailable: false,
      }),
    ).toThrow();
  });

  it("advertises actions from the exact managed lifecycle", () => {
    expect(
      availableCodexTuiActionIds({
        lifecycle: "stopped",
        resourceGeneration: null,
        streamAvailable: false,
      }),
    ).toEqual(["start"]);
    expect(
      availableCodexTuiActionIds({
        lifecycle: "running",
        resourceGeneration: 3,
        streamAvailable: true,
      }),
    ).toEqual(["stop"]);
    expect(
      availableCodexTuiActionIds({
        lifecycle: "stopping",
        resourceGeneration: 3,
        streamAvailable: false,
      }),
    ).toEqual([]);
  });
});

describe("CodexManagedTuiRegistry", () => {
  it("keeps managed TUI unavailable when a ready remote runtime omits native terminal support", async () => {
    const { client } = readyClient();
    let supported = false;
    const controller = new CodexManagedTuiController({ client, isRuntimeSupported: () => supported });
    const launch = vi.fn();
    controller.configure({ launch });
    const unavailable = controller.presentation(authority.scope, authority.applicationThreadId);
    expect(unavailable.availability).toBe("unavailable");
    expect(unavailable.unavailableReason).toContain("does not provide managed terminal support");
    await expect(controller.perform(authority, "start")).resolves.toMatchObject({ outcome: "rejected" });
    expect(launch).not.toHaveBeenCalled();
    await expect(controller.authorizeAdmission(authority)).rejects.toThrow("not running");
    await expect(controller.attachViewer({ ...authority, resourceGeneration: 1, viewerId: "viewer" }, vi.fn())).rejects.toThrow("does not provide managed terminal support");
    supported = true;
    const available = controller.presentation(authority.scope, authority.applicationThreadId);
    expect(available.availability).toBe("available");
    expect(available.revision).toBeGreaterThan(unavailable.revision);
    supported = false;
    expect(controller.presentation(authority.scope, authority.applicationThreadId).availability).toBe("unavailable");
    await controller.close();
  });

  it("aborts startup at its deadline and closes a process returned late", async () => {
    const registry = new CodexManagedTuiRegistry({
      startupTimeoutMilliseconds: 10,
    });
    const launch = deferred<CodexManagedTuiProcess>();
    const fake = fakeProcess();
    const started = await registry.start(authority, {
      launch: async () => await launch.promise,
    });
    expect(started).toMatchObject({
      lifecycle: "failed",
      streamAvailable: false,
    });
    launch.resolve(fake.process);
    await vi.waitFor(() =>
      expect(fake.close).toHaveBeenCalledWith(
        "codex_tui_launch_deadline_exceeded",
      ),
    );
    await registry.close();
  });

  it("owns one reader and fans output/input/resize across independent viewers", async () => {
    const registry = new CodexManagedTuiRegistry();
    const fake = fakeProcess();
    const launcher = { launch: vi.fn(async () => fake.process) };
    const running = await registry.start(authority, launcher);
    expect(running).toEqual({
      lifecycle: "running",
      resourceGeneration: 1,
      streamAvailable: true,
    });
    expect((await registry.start(authority, launcher)).resourceGeneration).toBe(
      1,
    );
    expect(launcher.launch).toHaveBeenCalledTimes(1);

    const firstOutput: string[] = [];
    const secondOutput: string[] = [];
    const first = registry.attachViewer(authority, 1, {
      viewerId: "viewer-one",
      output: (bytes) => firstOutput.push(Buffer.from(bytes).toString("utf8")),
      stateChanged: () => undefined,
    });
    const second = registry.attachViewer(authority, 1, {
      viewerId: "viewer-two",
      output: (bytes) => secondOutput.push(Buffer.from(bytes).toString("utf8")),
      stateChanged: () => undefined,
    });
    fake.output.write("shared-output");
    await vi.waitFor(() => expect(firstOutput).toEqual(["shared-output"]));
    expect(secondOutput).toEqual(["shared-output"]);

    await first.input(new TextEncoder().encode("hello"));
    await second.resize(120, 40);
    expect(fake.write).toHaveBeenCalledWith(new TextEncoder().encode("hello"));
    expect(fake.resize).toHaveBeenCalledWith(120, 40);
    expect(await second.requestSync()).toEqual({ columns: 120, rows: 40 });
    expect(fake.resize).toHaveBeenNthCalledWith(2, 121, 40);
    expect(fake.resize).toHaveBeenNthCalledWith(3, 120, 40);
    first.detach();
    fake.output.write("second-only");
    await vi.waitFor(() => expect(secondOutput).toContain("second-only"));
    expect(firstOutput).not.toContain("second-only");
    await registry.close();
  });

  it("fences authority by every binding axis and app-server generation", async () => {
    const firstHash = codexManagedTuiBindingFingerprint(authority);
    expect(
      codexManagedTuiBindingFingerprint({
        ...authority,
        backendConversationId: "01900000-0000-7000-8000-000000000002",
      }),
    ).not.toBe(firstHash);

    const registry = new CodexManagedTuiRegistry();
    const fake = fakeProcess();
    await registry.start(authority, { launch: async () => fake.process });
    expect(() =>
      registry.attachViewer(
        { ...authority, workspaceId: "wrong-workspace" },
        1,
        {
          viewerId: "confused-viewer",
          output: () => undefined,
          stateChanged: () => undefined,
        },
      ),
    ).toThrow("codex_tui_binding_conflict");

    await registry.fenceAppServerGeneration(8);
    expect(fake.close).toHaveBeenCalledWith(
      "codex_tui_app_server_generation_changed",
    );
    expect(registry.state(authority)).toMatchObject({
      lifecycle: "exited",
      resourceGeneration: 1,
      streamAvailable: false,
      diagnostic: {
        text: "The Codex connection changed. Start a new TUI to reconnect.",
      },
    });
    await registry.close();
  });

  it("stops explicitly without coupling viewer presence to process lifetime", async () => {
    const registry = new CodexManagedTuiRegistry();
    const lifecycles: string[] = [];
    registry.subscribeState((_authority, state) => {
      lifecycles.push(state.lifecycle);
    });
    const fake = fakeProcess();
    await registry.start(authority, { launch: async () => fake.process });
    const viewer = registry.attachViewer(authority, 1, {
      viewerId: "transient-viewer",
      output: () => undefined,
      stateChanged: () => undefined,
    });
    viewer.detach();
    expect(fake.close).not.toHaveBeenCalled();
    expect(registry.state(authority).lifecycle).toBe("running");
    expect(await registry.stop(authority)).toEqual({
      lifecycle: "stopped",
      resourceGeneration: null,
      streamAvailable: false,
    });
    expect(fake.close).toHaveBeenCalledWith("codex_tui_stopped");
    expect(lifecycles).toContain("stopping");
    expect(lifecycles.at(-1)).toBe("stopped");
    expect(lifecycles).not.toContain("exited");
    await registry.close();
  });

  it("releases only the matching runtime lease and leaves other threads running", async () => {
    const client = new CodexSharedClientFacade({
      current: () => undefined,
      latestGeneration: () => 7,
      retireGeneration: async () => undefined,
    });
    client.updateLifecycle({ state: "ready", generation: 7 });
    const first = fakeProcess();
    const second = fakeProcess();
    const replacement = fakeProcess();
    const controller = new CodexManagedTuiController({ client });
    controller.configure({
      launch: async ({ authority: launched }) =>
        launched.applicationThreadId === "thread-two"
          ? second.process
          : launched.runtimeLeaseId === "runtime-lease-replacement"
            ? replacement.process
            : first.process,
    });
    const secondAuthority = {
      ...authority,
      applicationThreadId: "thread-two",
      backendConversationId: "01900000-0000-7000-8000-000000000002",
      workspaceId: "workspace-two",
      canonicalWorkspacePath: "/workspace/two",
      opaqueBindingDetail: "opaque-two",
      runtimeLeaseId: "runtime-lease-two",
    };
    const withoutGeneration = (value: CodexManagedTuiBindingAuthority) => {
      const { appServerGeneration: _ignored, ...runtimeAuthority } = value;
      return runtimeAuthority;
    };
    await controller.perform(withoutGeneration(authority), "start");
    await controller.perform(withoutGeneration(secondAuthority), "start");
    const viewer = controller.registry.attachScopedViewer(
      authority.scope,
      authority.applicationThreadId,
      1,
      {
        viewerId: "eviction-viewer",
        output: () => undefined,
        stateChanged: () => undefined,
      },
    );
    viewer.detach();
    expect(first.close).not.toHaveBeenCalled();

    await controller.releaseRuntime(withoutGeneration(authority), 7);
    expect(first.close).toHaveBeenCalledWith(
      "codex_tui_thread_runtime_released",
    );
    expect(second.close).not.toHaveBeenCalled();
    expect(
      controller.registry.projection(
        secondAuthority.scope,
        secondAuthority.applicationThreadId,
      ).state.lifecycle,
    ).toBe("running");

    const replacementAuthority = {
      ...authority,
      runtimeLeaseId: "runtime-lease-replacement",
    };
    await controller.perform(withoutGeneration(replacementAuthority), "start");
    await controller.releaseRuntime(withoutGeneration(authority), 7);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(
      controller.registry.projection(
        replacementAuthority.scope,
        replacementAuthority.applicationThreadId,
      ).state.lifecycle,
    ).toBe("running");
    await controller.close();
  });

  it("advances projection revision for every lifecycle transition", async () => {
    const registry = new CodexManagedTuiRegistry();
    const initial = registry.projection(
      authority.scope,
      authority.applicationThreadId,
    );
    const fake = fakeProcess();
    await registry.start(authority, { launch: async () => fake.process });
    const running = registry.projection(
      authority.scope,
      authority.applicationThreadId,
    );
    await registry.stop(authority);
    const stopped = registry.projection(
      authority.scope,
      authority.applicationThreadId,
    );
    expect(initial.revision).toBeLessThan(running.revision);
    expect(running.revision).toBeLessThan(stopped.revision);
    expect(stopped.state.lifecycle).toBe("stopped");
    await registry.close();
  });

  it("publishes an asynchronous process exit with its stable generation", async () => {
    const registry = new CodexManagedTuiRegistry();
    const fake = fakeProcess();
    const states: unknown[] = [];
    registry.subscribeState((_authority, state) => states.push(state));
    await registry.start(authority, { launch: async () => fake.process });

    fake.output.end();
    fake.closure.resolve({ exitCode: 23, signal: null });

    await vi.waitFor(() =>
      expect(registry.state(authority)).toEqual({
        lifecycle: "exited",
        resourceGeneration: 1,
        streamAvailable: false,
        exitStatus: { kind: "code", code: 23 },
      }),
    );
    expect(states).toContainEqual(
      expect.objectContaining({
        lifecycle: "exited",
        resourceGeneration: 1,
      }),
    );
    await registry.close();
  });

  it("reports unsupported runtime before first-turn resumability", () => {
    const client = new CodexSharedClientFacade({
      current: () => undefined,
      latestGeneration: () => 2,
      retireGeneration: async () => undefined,
    });
    client.updateLifecycle({ state: "ready", generation: 2 });
    const unsupported = new CodexManagedTuiController({
      client,
      isResumable: () => false,
    });
    unsupported.unavailable("Managed TUI is unsupported for owned stdio.");
    expect(
      unsupported.presentation(authority.scope, authority.applicationThreadId),
    ).toMatchObject({
      availability: "unavailable",
      unavailableReason: "Managed TUI is unsupported for owned stdio.",
    });

    const external = new CodexManagedTuiController({
      client,
      isResumable: () => false,
    });
    external.configure({ launch: async () => fakeProcess().process });
    expect(
      external.presentation(authority.scope, authority.applicationThreadId),
    ).toMatchObject({
      availability: "unavailable",
      unavailableReason:
        "Send the first message before starting the managed TUI.",
    });
  });

  it("fails closed for execution variables that cannot be carried through managed TUI", async () => {
    const { client } = readyClient();
    const launcher = { launch: vi.fn(async () => fakeProcess().process) };
    const controller = new CodexManagedTuiController({ client, supportsThreadEnvironment: () => false });
    controller.configure(launcher);
    expect(controller.presentation(authority.scope, authority.applicationThreadId)).toMatchObject({ availability: "unavailable", unavailableReason: expect.stringContaining("environment variables") });
    await expect(controller.perform(handleAuthority(), "start")).resolves.toMatchObject({ outcome: "rejected", safeMessage: expect.stringContaining("environment variables") });
    expect(launcher.launch).not.toHaveBeenCalled();
    await controller.close();
  });

  it("projects unrepresentable policy as unavailable and revalidates Start", async () => {
    let representable = false;
    const { client } = readyClient();
    const launcher = { launch: vi.fn(async () => fakeProcess().process) };
    const controller = new CodexManagedTuiController({
      client,
      isPolicyRepresentable: () => representable,
    });
    controller.configure(launcher);
    expect(
      controller.presentation(authority.scope, authority.applicationThreadId),
    ).toMatchObject({
      availability: "unavailable",
      unavailableReason:
        "The current execution policy cannot be represented by the managed TUI.",
    });
    await expect(
      controller.perform(handleAuthority(), "start"),
    ).resolves.toEqual({
      outcome: "rejected",
      safeMessage:
        "The current execution policy cannot be represented by the managed TUI.",
    });
    expect(launcher.launch).not.toHaveBeenCalled();
    representable = true;
    await expect(
      controller.perform(handleAuthority(), "start"),
    ).resolves.toMatchObject({
      outcome: "accepted",
      projectedState: { lifecycle: "running" },
    });
    await controller.close();
  });

  it("keeps accepted settings durable while failing a stale TUI on sync rejection", async () => {
    const client = new CodexSharedClientFacade({
      current: () => ({
        generation: 7,
        request: async () => {
          throw new Error("experimental method rejected");
        },
        requestWithReceipt: async () => {
          throw new Error("unused");
        },
      }),
      latestGeneration: () => 7,
      retireGeneration: async () => undefined,
    });
    client.updateLifecycle({ state: "ready", generation: 7 });
    const controller = new CodexManagedTuiController({ client });
    const fake = fakeProcess();
    controller.configure({ launch: async () => fake.process });
    const started = await controller.perform(
      {
        ...authority,
        scope: authority.scope,
      },
      "start",
    );
    expect(started.outcome).toBe("accepted");
    await expect(
      controller.syncSettings(authority.scope, authority.applicationThreadId, {
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        serviceTier: "standard",
        sandboxMode: "read-only",
        networkAccess: "disabled",
        approvalPolicy: "never",
        approvalReviewer: "user",
      }),
    ).resolves.toBeUndefined();
    expect(
      controller.presentation(authority.scope, authority.applicationThreadId)
        .state,
    ).toMatchObject({
      lifecycle: "failed",
      streamAvailable: false,
      diagnostic: {
        text: expect.stringContaining("kept the new settings"),
      },
    });
    expect(fake.close).toHaveBeenCalledWith("codex_tui_failed");
    await controller.close();
  });

  it("maps stopped admission to the closed terminal-unavailable contract", async () => {
    const { client } = readyClient();
    const controller = new CodexManagedTuiController({ client });
    controller.configure({ launch: async () => fakeProcess().process });

    await expect(
      controller.authorizeAdmission({
        scope: authority.scope,
        applicationThreadId: authority.applicationThreadId,
      }),
    ).rejects.toMatchObject({
      code: "terminal_unavailable",
      retryable: true,
    });
    await controller.close();
  });

  it("rejects Start before resumability and fences a running TUI on app-server replacement", async () => {
    let resumable = false;
    const { client } = readyClient();
    const fake = fakeProcess();
    const launcher = { launch: vi.fn(async () => fake.process) };
    const controller = new CodexManagedTuiController({
      client,
      isResumable: () => resumable,
    });
    controller.configure(launcher);

    await expect(
      controller.perform(handleAuthority(), "start"),
    ).resolves.toEqual({
      outcome: "rejected",
      safeMessage: "Send the first message before starting the managed TUI.",
    });
    expect(launcher.launch).not.toHaveBeenCalled();

    resumable = true;
    await controller.perform(handleAuthority(), "start");
    client.updateLifecycle({ state: "ready", generation: 8 });
    await controller.consumeLifecycle();

    expect(fake.close).toHaveBeenCalledWith(
      "codex_tui_app_server_generation_changed",
    );
    expect(
      controller.presentation(authority.scope, authority.applicationThreadId),
    ).toMatchObject({
      state: {
        lifecycle: "exited",
        resourceGeneration: 1,
        streamAvailable: false,
      },
    });
    await controller.close();
  });

  it("synchronizes the full desired settings tuple only for a running generation", async () => {
    const { client, request } = readyClient();
    const controller = new CodexManagedTuiController({ client });
    controller.configure({ launch: async () => fakeProcess().process });
    await controller.perform(handleAuthority(), "start");

    await controller.syncSettings(
      authority.scope,
      authority.applicationThreadId,
      {
        sandboxMode: "workspace-write",
        networkAccess: "enabled",
        approvalPolicy: "on-request",
        approvalReviewer: "auto_review",
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        serviceTier: "fast",
      },
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: "thread/settings/update",
    });
    expect(request.mock.calls[0]?.[1]).toEqual({
      threadId: authority.backendConversationId,
      cwd: authority.canonicalWorkspacePath,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      model: "gpt-5.6-luna",
      serviceTier: "priority",
      effort: "high",
    });
    expect(
      controller.presentation(authority.scope, authority.applicationThreadId),
    ).toMatchObject({ state: { lifecycle: "running" } });
    await controller.close();
  });

  it("fails and closes a running TUI when committed settings cannot converge", async () => {
    const { client } = readyClient({
      request: async () => {
        throw new Error("remote rejected update");
      },
    });
    const fake = fakeProcess();
    const controller = new CodexManagedTuiController({ client });
    controller.configure({ launch: async () => fake.process });
    await controller.perform(handleAuthority(), "start");

    await controller.syncSettings(
      authority.scope,
      authority.applicationThreadId,
      {
        sandboxMode: "read-only",
        networkAccess: "disabled",
        approvalPolicy: "never",
        approvalReviewer: "user",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        serviceTier: "standard",
      },
    );

    expect(fake.close).toHaveBeenCalledWith("codex_tui_failed");
    expect(
      controller.presentation(authority.scope, authority.applicationThreadId),
    ).toMatchObject({
      state: {
        lifecycle: "failed",
        resourceGeneration: 1,
        streamAvailable: false,
        diagnostic: {
          text: expect.stringContaining("kept the new settings"),
        },
      },
    });
    await controller.close();
  });
});

describe("EnvironmentCodexManagedTuiLauncher", () => {
  const settings = Object.freeze({
    sandboxMode: "workspace-write" as const,
    networkAccess: "enabled" as const,
    approvalPolicy: "on-request" as const,
    approvalReviewer: "auto_review" as const,
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    serviceTier: "fast" as const,
  });

  it("supports only unrestricted catalog model policy", () => {
    expect(codexManagedTuiModelPolicySupported({ type: "catalog" })).toBe(true);
    expect(
      codexManagedTuiModelPolicySupported({
        type: "allowlist",
        allowed: [{ modelIds: ["gpt-5.6-luna"] }],
      }),
    ).toBe(false);
    expect(
      codexManagedTuiModelPolicySupported({
        type: "denylist",
        denied: [{ reasoningEfforts: ["xhigh"] }],
      }),
    ).toBe(false);
  });

  it("uses target-environment PATH resolution with an optional explicit override", async () => {
    const fixture = launcherChannels();
    const scope = {
      ...authority.scope,
      backendInstanceId: authority.backendInstanceId,
      executionEnvironmentId: authority.executionEnvironmentId,
    };

    await expect(
      resolveCodexManagedTuiExecutable(fixture.channels, scope),
    ).resolves.toEqual({
      kind: "executable",
      canonicalPath: "/environment/install/codex",
    });
    await resolveCodexManagedTuiExecutable(
      fixture.channels,
      scope,
      "/configured/codex",
    );

    expect(fixture.resolveOwnedProcessExecutable).toHaveBeenNthCalledWith(
      1,
      scope,
      { commandName: "codex" },
    );
    expect(fixture.resolveOwnedProcessExecutable).toHaveBeenNthCalledWith(
      2,
      scope,
      { commandName: "codex", configuredPath: "/configured/codex" },
    );
  });

  it("launches UDS resume with the exact authority, workspace, and settings", async () => {
    const fixture = launcherChannels();
    const launcher = new EnvironmentCodexManagedTuiLauncher({
      channels: fixture.channels,
      configuredExecutablePath: "/environment/install/codex",
      onRuntimeVersionAssessment: vi.fn(),
      configuration: externalConfiguration({
        type: "unix_websocket",
        socketPath: "/run/private/codex.sock",
      }),
      environment: ordinaryLauncherEnvironment,
      settings: () => settings,
      validateModelSelection: async () => undefined,
    });
    await launcher.launch({
      authority,
      resourceGeneration: 11,
      signal: new AbortController().signal,
    });

    expect(fixture.prepareOwnedProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: authority.scope.tenantId,
        principalId: authority.scope.principalId,
        backendInstanceId: authority.backendInstanceId,
        executionEnvironmentId: authority.executionEnvironmentId,
      }),
      {
        executablePath: "/environment/install/codex",
        workingDirectory: authority.canonicalWorkspacePath,
      },
    );
    const [, launchInput] = fixture.openOwnedPty.mock.calls[0]!;
    expect(launchInput.arguments).toEqual([
      "resume",
      authority.backendConversationId,
      "--remote",
      "unix:///run/private/codex.sock",
      "--strict-config",
      "-C",
      authority.canonicalWorkspacePath,
      "-s",
      "workspace-write",
      "-a",
      "on-request",
      "-m",
      "gpt-5.6-luna",
      "-c",
      'approvals_reviewer="auto_review"',
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'service_tier="priority"',
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      "tui.auto_recap=false",
      "-c",
      'tui.keymap.composer.submit="enter"',
      "-c",
      "tui.vim_mode_default=false",
      "-c",
      'tui.alternate_screen="always"',
      "-c",
      "tui.raw_output_mode=false",
      "-c",
      "tui.disable_paste_burst=false",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c",
      "sandbox_workspace_write.exclude_slash_tmp=true",
    ]);
    expect(launchInput.environment).toMatchObject({
      HOME: "/ordinary-home",
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
    expect(launchInput.environment).not.toHaveProperty("CODEX_HOME");
    expect(launchInput.environment).not.toHaveProperty("CODEX_SQLITE_HOME");
    expect(launchInput.environment).not.toHaveProperty("NO_COLOR");
    expect(fixture.prepareManagedProcessEndpoint).toHaveBeenCalledWith(
      expect.anything(),
      {
        kind: "private_unix_websocket",
        socketPath: "/run/private/codex.sock",
      },
      authority.appServerGeneration,
      expect.any(AbortSignal),
    );
  });

  it("passes authenticated TCP capability only through the environment and discards it", async () => {
    const fixture = launcherChannels();
    const launcher = new EnvironmentCodexManagedTuiLauncher({
      channels: fixture.channels,
      configuredExecutablePath: "/environment/install/codex",
      onRuntimeVersionAssessment: vi.fn(),
      configuration: externalConfiguration({
        type: "tcp_websocket",
        url: "wss://codex.internal.example:443",
        authentication: {
          type: "capability_token",
          secret: { source: "protected_file", path: "/run/secret/token" },
        },
      }),
      environment: ordinaryLauncherEnvironment,
      settings: () => ({ ...settings, serviceTier: "standard" }),
      validateModelSelection: async () => undefined,
    });
    await launcher.launch({
      authority,
      resourceGeneration: 12,
      signal: new AbortController().signal,
    });

    expect(fixture.prepareManagedProcessEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: authority.scope.principalId }),
      expect.objectContaining({
        kind: "assured_tcp_websocket",
        address: "wss://codex.internal.example:443",
        authentication: {
          source: "protected_file",
          path: "/run/secret/token",
        },
      }),
      authority.appServerGeneration,
      expect.any(AbortSignal),
    );
    const [, launchInput] = fixture.openOwnedPty.mock.calls[0]!;
    expect(launchInput.arguments).toContain("--remote-auth-token-env");
    expect(launchInput.arguments).toContain('service_tier="default"');
    expect(launchInput.arguments).not.toContain("top-secret-capability");
    expect(launchInput.environment).toMatchObject({
      SEDES_CODEX_TUI_REMOTE_TOKEN: "top-secret-capability",
    });
    expect(fixture.discard).toHaveBeenCalledTimes(1);
  });

  it("rechecks runtime admission after endpoint resolution and discards credentials without spawning", async () => {
    const fixture = launcherChannels();
    const prepare = fixture.prepareManagedProcessEndpoint.getMockImplementation()!;
    let frozen = false;
    fixture.prepareManagedProcessEndpoint.mockImplementation(async (...input) => {
      const endpoint = await prepare(...input);
      frozen = true;
      return endpoint;
    });
    const launcher = new EnvironmentCodexManagedTuiLauncher({
      channels: fixture.channels,
      configuration: externalConfiguration({ type: "tcp_websocket", url: "wss://codex.internal.example:443",
        authentication: { type: "capability_token", secret: { source: "protected_file", path: "/run/secret/token" } } }),
      environment: ordinaryLauncherEnvironment,
      settings: () => settings,
      validateModelSelection: async () => {},
      onRuntimeVersionAssessment: vi.fn(),
      assertLaunchAdmission: () => { if (frozen) throw new Error("runtime_admission_frozen"); },
    });
    await expect(launcher.launch({ authority, resourceGeneration: 1, signal: new AbortController().signal }))
      .rejects.toThrow("runtime_admission_frozen");
    expect(fixture.openOwnedPty).not.toHaveBeenCalled();
    expect(fixture.discard).toHaveBeenCalledOnce();
  });

  it("fails closed before spawn for mismatched authority and unrepresentable policy", async () => {
    const fixture = launcherChannels();
    const launcher = new EnvironmentCodexManagedTuiLauncher({
      channels: fixture.channels,
      configuredExecutablePath: "/environment/install/codex",
      onRuntimeVersionAssessment: vi.fn(),
      configuration: externalConfiguration({
        type: "tcp_websocket",
        url: "ws://127.0.0.1:9999",
        authentication: {
          type: "capability_token",
          secret: { source: "environment", variable: "CODEX_TOKEN" },
        },
      }),
      environment: ordinaryLauncherEnvironment,
      settings: () => ({
        ...settings,
        sandboxMode: "read-only",
        networkAccess: "enabled",
      }),
      validateModelSelection: async () => undefined,
    });
    await expect(
      launcher.launch({
        authority: {
          ...authority,
          scope: { ...authority.scope, principalId: "wrong" },
        },
        resourceGeneration: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("codex_tui_environment_launcher_scope_mismatch");
    await expect(
      launcher.launch({
        authority,
        resourceGeneration: 2,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("codex_tui_execution_policy_unrepresentable");
    expect(fixture.openOwnedPty).not.toHaveBeenCalled();
    expect(fixture.discard).toHaveBeenCalledTimes(1);
    expect(
      codexTuiLaunchPolicyRepresentable({
        ...settings,
        sandboxMode: "danger-full-access",
        networkAccess: "disabled",
      }),
    ).toBe(false);
  });

  it("fails closed before endpoint preparation when the live model tuple is unavailable", async () => {
    const fixture = launcherChannels();
    const validateModelSelection = vi.fn(async () => {
      throw new Error("codex_tui_live_model_selection_unavailable");
    });
    const launcher = new EnvironmentCodexManagedTuiLauncher({
      channels: fixture.channels,
      configuredExecutablePath: "/environment/install/codex",
      onRuntimeVersionAssessment: vi.fn(),
      configuration: externalConfiguration({
        type: "unix_websocket",
        socketPath: "/run/private/codex.sock",
      }),
      environment: ordinaryLauncherEnvironment,
      settings: () => settings,
      validateModelSelection,
    });

    await expect(
      launcher.launch({
        authority,
        resourceGeneration: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("codex_tui_live_model_selection_unavailable");
    expect(validateModelSelection).toHaveBeenCalledWith({
      authority,
      settings,
      signal: expect.any(AbortSignal),
    });
    expect(fixture.prepareOwnedProcess).toHaveBeenCalledOnce();
    expect(fixture.openOwnedProcess).toHaveBeenCalledOnce();
    expect(fixture.prepareManagedProcessEndpoint).not.toHaveBeenCalled();
    expect(fixture.openOwnedPty).not.toHaveBeenCalled();
  });

  it("requires explicit environment executable and endpoint capabilities", () => {
    const fixture = launcherChannels();
    const channels = {
      ...fixture.channels,
      openOwnedPty: undefined,
      prepareManagedProcessEndpoint: undefined,
    } as unknown as ExecutionEnvironmentChannelProvider;
    expect(
      () =>
        new EnvironmentCodexManagedTuiLauncher({
          channels,
          configuredExecutablePath: "/environment/install/codex",
          onRuntimeVersionAssessment: vi.fn(),
          configuration: externalConfiguration({
            type: "unix_websocket",
            socketPath: "/run/private/codex.sock",
          }),
          environment: ordinaryLauncherEnvironment,
          settings: () => settings,
          validateModelSelection: async () => undefined,
        }),
    ).toThrow("codex_tui_environment_launcher_configuration_invalid");
  });

  it("propagates the startup deadline through preparation and never spawns late", async () => {
    const fixture = launcherChannels();
    let observedAbort = false;
    fixture.openOwnedProcess.mockImplementationOnce(
      async (_scope, _input, signal) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const launcher = new EnvironmentCodexManagedTuiLauncher({
      channels: fixture.channels,
      configuredExecutablePath: "/environment/install/codex",
      onRuntimeVersionAssessment: vi.fn(),
      configuration: externalConfiguration({
        type: "unix_websocket",
        socketPath: "/run/private/codex.sock",
      }),
      environment: ordinaryLauncherEnvironment,
      settings: () => settings,
      validateModelSelection: async () => undefined,
    });
    const registry = new CodexManagedTuiRegistry({
      startupTimeoutMilliseconds: 10,
    });
    await expect(registry.start(authority, launcher)).resolves.toMatchObject({
      lifecycle: "failed",
    });
    expect(observedAbort).toBe(true);
    expect(fixture.prepareManagedProcessEndpoint).not.toHaveBeenCalled();
    expect(fixture.openOwnedPty).not.toHaveBeenCalled();
    await registry.close();
  });

  it("revalidates the operator command release and endpoint on every Start", async () => {
    const fixture = launcherChannels();
    const launcher = new EnvironmentCodexManagedTuiLauncher({
      channels: fixture.channels,
      configuredExecutablePath: "/environment/install/codex",
      onRuntimeVersionAssessment: vi.fn(),
      configuration: externalConfiguration({
        type: "unix_websocket",
        socketPath: "/run/private/codex.sock",
      }),
      environment: ordinaryLauncherEnvironment,
      settings: () => settings,
      validateModelSelection: async () => undefined,
    });
    for (const resourceGeneration of [1, 2]) {
      await launcher.launch({
        authority,
        resourceGeneration,
        signal: new AbortController().signal,
      });
    }
    expect(fixture.prepareOwnedProcess).toHaveBeenCalledTimes(2);
    expect(fixture.openOwnedProcess).toHaveBeenCalledTimes(2);
    expect(fixture.prepareManagedProcessEndpoint).toHaveBeenCalledTimes(2);

    fixture.openOwnedProcess.mockResolvedValueOnce(
      codexVersionProbeChannel("codex-cli 0.145.0\n"),
    );
    await expect(
      launcher.launch({
        authority,
        resourceGeneration: 3,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("codex_executable_version_unsupported");
    expect(fixture.openOwnedPty).toHaveBeenCalledTimes(2);

    fixture.openOwnedProcess.mockResolvedValueOnce(
      codexVersionProbeChannel("not-codex 0.151.0\n"),
    );
    await expect(
      launcher.launch({
        authority,
        resourceGeneration: 4,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("codex_executable_version_malformed");
    expect(fixture.openOwnedPty).toHaveBeenCalledTimes(2);
  });
});

describe("assertCodexLiveModelSelection", () => {
  const model = (id: string, efforts: readonly string[]) => ({
    id,
    model: id,
    upgrade: null,
    availabilityNux: null,
    displayName: id,
    description: "Test model",
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: efforts[0] ?? "",
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  });

  it("reads uncached pages and admits only the exact live model-effort tuple", async () => {
    const requestWithReceipt = vi
      .fn()
      .mockResolvedValueOnce({
        generation: 7,
        inboundSequence: 1,
        result: { data: [model("other", ["low"])], nextCursor: "page-2" },
      })
      .mockResolvedValueOnce({
        generation: 7,
        inboundSequence: 2,
        result: {
          data: [model("gpt-5.6-luna", ["low", "high"])],
          nextCursor: null,
        },
      });
    const client = new CodexSharedClientFacade({
      current: () => ({
        generation: 7,
        request: vi.fn() as never,
        requestWithReceipt: requestWithReceipt as never,
      }),
      latestGeneration: () => 7,
      retireGeneration: async () => undefined,
    });
    client.updateLifecycle({ state: "ready", generation: 7 });

    await expect(
      assertCodexLiveModelSelection({
        client,
        expectedGeneration: 7,
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
    expect(requestWithReceipt).toHaveBeenCalledTimes(2);
    expect(requestWithReceipt.mock.calls[1]?.[1]).toMatchObject({
      cursor: "page-2",
      includeHidden: false,
    });
  });

  it("rejects a response from a stale daemon generation", async () => {
    const client = new CodexSharedClientFacade({
      current: () => ({
        generation: 7,
        request: vi.fn() as never,
        requestWithReceipt: vi.fn(async () => ({
          generation: 6,
          inboundSequence: 1,
          result: {
            data: [model("gpt-5.6-luna", ["high"])],
            nextCursor: null,
          },
        })) as never,
      }),
      latestGeneration: () => 7,
      retireGeneration: async () => undefined,
    });
    client.updateLifecycle({ state: "ready", generation: 7 });
    await expect(
      assertCodexLiveModelSelection({
        client,
        expectedGeneration: 7,
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("codex_tui_live_model_catalog_generation_changed");
  });
});
