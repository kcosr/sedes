import type { InitializeResponse, NewSessionRequest, PromptRequest, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpBinding, ACP_AGENT_REQUESTS, ACP_AGENT_NOTIFICATIONS, ACP_CLIENT_NOTIFICATIONS, ACP_CLIENT_REQUESTS,
  defineAcpInlineReverseNotificationHandler, defineAcpReverseRequestHandler,
} from "../../provider-protocol/bindings/acp-v1/index.js";
import type { FramedMessageTransport, ProviderTransportScope } from "../../provider-protocol/transport/assured-framed-transport.js";
import { admitAntigravityInitialize } from "./release-profile.js";

/** The shared binding owns ACP syntax; this peer owns Antigravity negotiation. */
export class AntigravityAcpConnection {
  private constructor(readonly binding: AcpBinding, readonly initialize: InitializeResponse) {}
  static async open(input: {
    readonly transport: FramedMessageTransport;
    readonly scope: ProviderTransportScope;
    readonly generation: number;
    readonly initializationTimeoutMs: number;
    readonly signal?: AbortSignal;
    readonly authorizeSession: (id: string) => boolean;
    readonly update: (notification: SessionNotification) => void;
    readonly permission: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>;
  }): Promise<AntigravityAcpConnection> {
    const binding = new AcpBinding({ transport: input.transport, expectedScope: input.scope,
      expectedConnectionGeneration: input.generation,
      reverseHandlers: [
        defineAcpInlineReverseNotificationHandler({ descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
          authorize: value => input.authorizeSession(value.sessionId), handle: input.update }),
        defineAcpReverseRequestHandler({ descriptor: ACP_CLIENT_REQUESTS.requestPermission,
          dispatchDeadlineMilliseconds: null,
          authorize: value => input.authorizeSession(value.sessionId), handle: (request, context) => input.permission(request, context.signal) }),
      ] });
    try {
      const initialize = await binding.initialize({ protocolVersion: 1,
        clientInfo: { name: "sedes", title: "Sedes", version: "1" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, { deadlineMilliseconds: input.initializationTimeoutMs, ...(input.signal ? { cancellationSignal: input.signal } : {}) });
      admitAntigravityInitialize(initialize);
      // Native agy owns authentication and refresh. Never import or persist tokens.
      if (initialize.authMethods?.some(method => method.id === "oauth-personal")) {
        await binding.request(ACP_AGENT_REQUESTS.authenticate, { methodId: "oauth-personal" },
          { deadlineMilliseconds: input.initializationTimeoutMs, ...(input.signal ? { cancellationSignal: input.signal } : {}) });
      }
      return new AntigravityAcpConnection(binding, initialize);
    } catch (error) { await binding.close("antigravity_initialize_failed"); throw error; }
  }
  async create(cwd: string, mcpServers: NewSessionRequest["mcpServers"] = []) { return this.binding.request(ACP_AGENT_REQUESTS.newSession, { cwd, mcpServers }); }
  async load(sessionId: string, cwd: string, mcpServers: NewSessionRequest["mcpServers"] = []) {
    const settlement = await this.binding.requestWithSettlement(ACP_AGENT_REQUESTS.loadSession, { sessionId, cwd, mcpServers },
      { notificationCutover: { kind: "ordering_key", orderingKey: sessionId } });
    return settlement.commitNotificationCutover(() => { if (settlement.kind === "remote_error") throw settlement.error; return settlement.response; });
  }
  async list(cwd: string, cursor?: string) { return this.binding.request(ACP_AGENT_REQUESTS.listSessions, { cwd, ...(cursor ? { cursor } : {}) }); }
  async prompt(sessionId: string, prompt: PromptRequest["prompt"], settle: (result: unknown) => void) {
    // All consumed updates reduce inline. Durable native evidence owns turn
    // settlement; parallel native steering must not reserve one exclusive cutover.
    const response = await this.binding.request(ACP_AGENT_REQUESTS.prompt, { sessionId, prompt }, { deadlineMilliseconds: null });
    settle(response); return response;
  }
  async cancel(sessionId: string) { await this.binding.notify(ACP_AGENT_NOTIFICATIONS.cancelSession, { sessionId }); }
  async setConfig(sessionId: string, configId: string, value: string) {
    return this.binding.request(ACP_AGENT_REQUESTS.setSessionConfigOption, { sessionId, configId, value });
  }
  async setMode(sessionId: string, modeId: string) { return this.binding.request(ACP_AGENT_REQUESTS.setSessionMode, { sessionId, modeId }); }
  async close() { await this.binding.close("antigravity_close"); }
}
