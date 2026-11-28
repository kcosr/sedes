import type { ProviderTransportScope } from "../../../provider-protocol/transport/assured-framed-transport.js";
import { EnvironmentEndpointUnreachableError, type ExecutionEnvironmentChannelProvider } from "../../../execution/environment-channel.js";
import type { ResolvedCodexRuntimeConfiguration } from "../codex-runtime-config.js";
import { CodexDaemonSupervisor } from "../codex-daemon-supervisor.js";
import { releaseCodexThreadResidency } from "../codex-thread-residency.js";
import { createExternalCodexTransport } from "./codex-runtime-transport.js";

export interface CodexArchiveTarget { threadId: string; workspace: string }
export type CodexExternalArchiveResult = "busy" | "released" | "offline" | "inconclusive";

/** Connect once to an operator-owned socket with its configured transport
 * assurances. This client never subscribes, resumes, changes or starts a thread. */
export async function inspectExternalCodexThread(
  scope: ProviderTransportScope, channels: ExecutionEnvironmentChannelProvider,
  connection: Extract<ResolvedCodexRuntimeConfiguration["connection"], { ownership: "external" }>,
  target: CodexArchiveTarget, signal: AbortSignal, markObserved: () => void,
): Promise<CodexExternalArchiveResult> {
  signal.throwIfAborted();
  const external = createExternalCodexTransport(scope, channels, connection);
  let refused = false;
  const observer = new CodexDaemonSupervisor({ scope, maximumRestartAttempts: 0, transportFactory: {
    async open(scope, generation, signal) {
      try { return await external.open(scope, generation, signal); }
      catch (error) {
        refused = error instanceof Error && error.cause instanceof EnvironmentEndpointUnreachableError;
        throw error;
      }
    },
  } });
  const abort = () => { void observer.close().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    try { await observer.start(); }
    catch (error) { signal.throwIfAborted(); if (refused) return "offline"; throw error; }
    signal.throwIfAborted();
    const generation = observer.client.currentReadyGeneration();
    if (!generation) return "inconclusive";
    return await releaseCodexThreadResidency(generation, () => observer.client.lifecycleSnapshot(),
      target.threadId, target.workspace, { signal, inspectionOnly: true, markObserved });
  } finally {
    signal.removeEventListener("abort", abort);
    await observer.close();
  }
}
