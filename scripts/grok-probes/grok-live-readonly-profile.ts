import type {
  InitializeResponse,
  ListSessionsResponse,
} from "@agentclientprotocol/sdk";
import {
  AcpBinding,
  ACP_AGENT_REQUESTS,
  type AcpBindingDiagnostics,
  type AcpRequestOptions,
} from "../../src/server/provider-protocol/bindings/acp-v1/index.js";
import type {
  FramedMessageTransport,
  ProviderTransportScope,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import {
  admitGrokAcpInitializeProfile,
  GROK_CACHED_TOKEN_AUTH_METHOD_ID,
} from "../../src/server/backends/grok/grok-acp-dialect.js";
import { GROK_ACP_REVIEWED_PROFILE } from "../../src/server/backends/grok/grok-release-guard.js";

export const GROK_LIVE_READONLY_PROFILE =
  `${GROK_ACP_REVIEWED_PROFILE}-live-readonly-probe` as const;

export interface GrokLiveReadonlyResult {
  readonly initialize: InitializeResponse;
  readonly sessions: ListSessionsResponse;
  readonly diagnostics: AcpBindingDiagnostics;
}

/** Probe-only exact-release client. It is not a production backend capability. */
export class GrokLiveReadonlyConnection {
  readonly #binding: AcpBinding;

  constructor(input: {
    readonly transport: FramedMessageTransport;
    readonly expectedScope: ProviderTransportScope;
    readonly connectionGeneration: number;
  }) {
    this.#binding = new AcpBinding({
      transport: input.transport,
      expectedScope: input.expectedScope,
      expectedConnectionGeneration: input.connectionGeneration,
      profiles: [GROK_LIVE_READONLY_PROFILE],
      limits: {
        maximumFrameBytes: 1_048_576,
        maximumPendingRequests: 1,
        requestDeadlineMilliseconds: 15_000,
        reverseRequestDeadlineMilliseconds: 5_000,
      },
    });
  }

  async run(
    input: {
      readonly cwd: string;
    },
    options?: AcpRequestOptions,
  ): Promise<GrokLiveReadonlyResult> {
    const initialize = admitGrokAcpInitializeProfile(
      await this.#binding.initialize(
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "sedes-grok-readonly-probe", version: "1" },
        },
        options,
      ),
    );
    await this.#binding.request(
      ACP_AGENT_REQUESTS.authenticate,
      { methodId: GROK_CACHED_TOKEN_AUTH_METHOD_ID },
      options,
    );
    const sessions = await this.#binding.request(
      ACP_AGENT_REQUESTS.listSessions,
      { cwd: input.cwd },
      options,
    );
    const diagnostics = this.#binding.diagnostics();
    assertQuiescent(diagnostics);
    return Object.freeze({ initialize, sessions, diagnostics });
  }

  diagnostics(): AcpBindingDiagnostics {
    return this.#binding.diagnostics();
  }

  async close(reason = "grok_live_readonly_probe_complete"): Promise<void> {
    await this.#binding.close(reason);
  }
}

function assertQuiescent(diagnostics: AcpBindingDiagnostics): void {
  if (
    !diagnostics.initialized ||
    diagnostics.closed ||
    diagnostics.pendingRequests !== 0 ||
    diagnostics.activeReverseRequests !== 0 ||
    diagnostics.activeNotifications !== 0 ||
    diagnostics.pendingNotifications !== 0 ||
    diagnostics.deniedReverseRequests !== 0 ||
    diagnostics.handlerFailures !== 0 ||
    diagnostics.rejectedLateResponses !== 0 ||
    diagnostics.protocolFailures !== 0
  ) {
    throw new Error("grok_live_readonly_binding_not_quiescent");
  }
}
