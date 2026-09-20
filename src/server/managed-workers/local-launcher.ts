import type { SidecarByteStream } from "../../internal/sidecar-protocol/contracts.js";
import type {
  EnvironmentChannelScope,
  EnvironmentOwnedProcessCleanupPolicy,
  ExecutionEnvironmentChannelProvider,
} from "../execution/environment-channel.js";
import {
  assertManagedWorkerArtifact,
  managedWorkerLaunchArguments,
  readVerifiedManagedWorkerArtifact,
  type ManagedWorkerArtifactRegistration,
  type ManagedWorkerLaunchIdentity,
} from "./artifact.js";

const DEFAULT_CLEANUP: EnvironmentOwnedProcessCleanupPolicy = Object.freeze({
  gracefulCloseMilliseconds: 12_000,
  terminateMilliseconds: 2_000,
  killMilliseconds: 2_000,
});

/** Launches a registered artifact locally; callers cannot supply argv or env. */
export async function launchLocalManagedWorker(input: {
  readonly channels: ExecutionEnvironmentChannelProvider;
  readonly scope: EnvironmentChannelScope;
  readonly artifact: ManagedWorkerArtifactRegistration;
  readonly workingDirectory: string;
  readonly identity: ManagedWorkerLaunchIdentity;
  readonly signal: AbortSignal;
  readonly cleanup?: EnvironmentOwnedProcessCleanupPolicy;
}): Promise<SidecarByteStream> {
  assertManagedWorkerArtifact(input.artifact);
  await readVerifiedManagedWorkerArtifact(input.artifact);
  const prepared = await input.channels.prepareOwnedProcess(input.scope, {
    // The deterministic ESM bundle intentionally has no platform-dependent
    // shebang. Both launchers therefore use an admitted Node executable.
    executablePath: process.execPath,
    workingDirectory: input.workingDirectory,
  });
  const arguments_ = [
    input.artifact.executablePath,
    "--expected-digest",
    input.artifact.artifactSha256,
    "--expected-build",
    input.artifact.buildId,
    ...managedWorkerLaunchArguments(input.artifact.kind, input.identity),
  ];
  const channel = await input.channels.openOwnedProcess(
    input.scope,
    {
      prepared,
      arguments: arguments_,
      environment: sanitizedLocalWorkerEnvironment(
        process.env,
        input.artifact.kind.inheritedEnvironmentNames ?? [],
      ),
      cleanup: input.cleanup ?? DEFAULT_CLEANUP,
    },
    input.signal,
  );
  drainBoundedStderr(channel.stderr, () =>
    channel.close("managed_worker_stderr_overflow"),
  );
  const stream: SidecarByteStream = {
    bytes: channel.stdout,
    closed: channel.closed.then((closure) => ({
      reason: closure.reason,
      exitCode: closure.exitCode,
      signal: closure.signal,
      ...(closure.cause ? { cause: closure.cause } : {}),
    })),
    write: (bytes: Uint8Array, options?: { readonly signal?: AbortSignal }) =>
      channel.writeStdin(bytes, options),
    close: (reason: string) => channel.close(reason),
  };
  return Object.freeze(stream);
}

export function sanitizedLocalWorkerEnvironment(
  source: NodeJS.ProcessEnv,
  inheritedNames: readonly string[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const name of [
    "HOME",
    "PATH",
    "LANG",
    "TMPDIR",
    "USER",
    "LOGNAME",
  ] as const) {
    const value = source[name];
    if (
      value !== undefined &&
      value.length <= 4096 &&
      !/[\u0000\r\n]/u.test(value)
    ) {
      result[name] = value;
    }
  }
  for (const [name, value] of Object.entries(source)) {
    if (
      name.startsWith("LC_") &&
      value !== undefined &&
      value.length <= 128 &&
      /^[A-Za-z0-9_@.+-]*$/u.test(value)
    )
      result[name] = value;
  }
  for (const name of inheritedNames) {
    if (name === "ELECTRON_RUN_AS_NODE") continue;
    const value = source[name];
    if (value === undefined) continue;
    // Explicitly registered values can select provider authority. Silently
    // omitting one could address a different default account or native store.
    if (value.length > 4096 || /[\u0000\r\n]/u.test(value)) {
      throw new Error("managed_worker_inherited_environment_invalid");
    }
    result[name] = value;
  }
  if (source.ELECTRON_RUN_AS_NODE === "1") {
    result.ELECTRON_RUN_AS_NODE = "1";
  }
  return result;
}

function drainBoundedStderr(
  stderr: AsyncIterable<Uint8Array>,
  overflow: () => Promise<void>,
): void {
  void (async () => {
    let bytes = 0;
    for await (const chunk of stderr) {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) {
        await overflow();
        return;
      }
    }
  })().catch(() => undefined);
}
