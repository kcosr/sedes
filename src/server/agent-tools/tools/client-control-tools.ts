import { Type, type TProperties } from "typebox";
import { clientVoicePatchSchema, type ClientActionResult } from "../../../shared/protocol/client-controls.js";
import type { ClientControlService } from "../../domain/client-control-service.js";
import type { TurnReplySpeechService } from "../../domain/turn-reply-speech-service.js";
import type { ThreadActivityService } from "../../conversations/thread-activity-service.js";
import type { ConversationActorManager } from "../../conversations/conversation-actor-manager.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { DomainError } from "../../domain/errors.js";
import type { AgentToolDefinition, TrustedToolInvocationContext, TrustedClientTurn } from "../contracts/agent-tool-contracts.js";
import type { AgentToolEnvironmentAuthorityReader, EnvironmentAuthorityResourceFact } from "../environment/environment-authority.js";
import { CanonicalAgentToolRequestError } from "../invocation/canonical-agent-tool-request-error.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import { AGENT_TOOL_JSON_SCHEMA_DIALECT, normalizeCanonicalAgentToolSchema } from "../schema/canonical-json-schema.js";

const ids = ["client.list", "client.end_interaction", "client.switch_thread", "client.settings.get", "client.settings.update", "client.replay_turn"] as const;
type Id = typeof ids[number];
const str = (maxLength = 128) => Type.String({ minLength: 1, maxLength });
const object = (properties: TProperties) => Type.Object(properties, { additionalProperties: false, maxProperties: Object.keys(properties).length });
const voice = {
  audioMode: Type.String({ enum: ["off", "manual", "response"], maxLength: 8 }),
  voiceThreadId: Type.Union([str(), Type.Null()]), pinDefaultVoiceThread: Type.Boolean(),
  autoListen: Type.Boolean(), onlyVoiceThread: Type.Boolean(), ignoreOtherDevices: Type.Boolean(), followComposerMode: Type.Boolean(),
};
const runtime = object({ foreground: Type.Boolean(), voiceReady: Type.Boolean(), interactionActive: Type.Boolean() });
const settings = Type.Union([object({ revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), voice: object(voice) }), Type.Null()]);
const state = object({ runtime, settings });
const client = object({ clientId: str(), name: str(256), platform: Type.String({ enum: ["browser", "electron", "android"], maxLength: 8 }),
  paired: Type.Boolean(), online: Type.Boolean(), capabilities: object({ navigate: Type.Boolean(), voice: Type.Boolean(), voiceSettings: Type.Boolean() }), runtime, settings });
const result = object({ client, state, status: Type.String({ enum: ["applied", "accepted", "noop", "failed"], maxLength: 8 }), reason: Type.Optional(str(160)) });
const patch = object({ voice: Type.Object(Object.fromEntries(Object.entries(voice).map(([key, value]) => [key, Type.Optional(value)])),
  { additionalProperties: false, minProperties: 1, maxProperties: 7 }) });

/**
 * The inventory title native shows for a thread: trimmed, at most 512 UTF-16 units without
 * splitting a surrogate pair, and null rather than blank, since native rejects an empty title.
 */
const threadTitle = (thread: EnvironmentAuthorityResourceFact) =>
  (thread.label ?? "").trim().slice(0, 512).replace(/[\uD800-\uDBFF]$/u, "").trimEnd() || null;
/** Stand-ins at least as long as the id and expiry `ClientControlService.request` assigns, so a measured command never undercounts. */
const assignedCommandFields = { id: "00000000-0000-0000-0000-000000000000", expiresAt: Number.MAX_SAFE_INTEGER };

export class ClientControlToolService {
  constructor(readonly clients: ClientControlService,
    readonly actors: Pick<ConversationActorManager, "observeInputRuntime">,
    readonly activity: Pick<ThreadActivityService, "originForTurn">,
    readonly authority: Pick<AgentToolEnvironmentAuthorityReader, "resolveThread">,
    readonly replies: Pick<TurnReplySpeechService, "select">) {}

  capture(scope: RequestScope, threadId: string): TrustedClientTurn {
    const observed = this.actors.observeInputRuntime(scope, threadId);
    if (!observed?.authoritative || observed.runState !== "running" || !observed.sourceTurnId || observed.settled ||
        observed.activeTurnId !== observed.sourceTurnId || observed.sourceTurnStatus !== "in_progress" || !observed.firstInput) {
      throw new DomainError("runtime_unavailable", "Client controls require a current user turn.");
    }
    const origin = this.activity.originForTurn(scope, threadId, observed.sourceTurnId);
    return Object.freeze({ threadId, turnId: observed.sourceTurnId, ownerGeneration: observed.ownerGeneration,
      ...(origin ? { clientId: origin.clientId } : {}) });
  }

  async execute(id: Id, raw: unknown, context: TrustedToolInvocationContext): Promise<unknown> {
    const turn = context.clientTurn;
    if (!turn || context.subject.kind !== "thread_agent" || context.subject.sourceThreadId !== turn.threadId) {
      throw new DomainError("runtime_unavailable", "The current client context is unavailable.");
    }
    const scope = { tenantId: context.tenantId, principalId: context.principalId };
    const current = this.capture(scope, turn.threadId);
    if (current.turnId !== turn.turnId || current.ownerGeneration !== turn.ownerGeneration) {
      throw new DomainError("runtime_unavailable", "The originating turn changed.");
    }
    const input = raw as { clientId?: string; threadId?: string; turnId?: string; listen?: boolean; expectedRevision?: number; patch?: { voice: unknown } };
    if (id === "client.list") return { defaultClientId: turn.clientId ?? null, clients: this.clients.list(scope) };
    const target = this.clients.target(scope, input.clientId ?? turn.clientId);
    const source = { sourceThreadId: turn.threadId, sourceTurnId: turn.turnId };
    if (id === "client.replay_turn") {
      const threadId = input.threadId ?? turn.threadId, turnId = input.turnId!;
      const thread = this.#admittedThread(scope, threadId, context);
      // Capture proved the source turn is still in progress; it has no reply to replay yet.
      if (threadId === turn.threadId && turnId === turn.turnId) throw new CanonicalAgentToolRequestError("invalid_input", "The turn has not ended.");
      const command = { action: "replay_turn" as const, ...source, threadId, threadTitle: threadTitle(thread), turnId };
      const assistantResult = this.replies.select(scope, threadId, turnId, { ...command, ...assignedCommandFields });
      if (!assistantResult) throw new CanonicalAgentToolRequestError("not_found", "Sedes stored no reply for that turn.");
      return settled(await this.clients.request(target, { ...command, assistantResult }, context.abortSignal));
    }
    const action = id.slice("client.".length) as "settings.get" | "settings.update" | "switch_thread" | "end_interaction";
    const voicePatch = input.patch ? clientVoicePatchSchema.parse(input.patch.voice) : undefined;
    const threadId = input.threadId ?? voicePatch?.voiceThreadId;
    const thread = threadId ? this.#admittedThread(scope, threadId, context) : undefined;
    return settled(await this.clients.request(target, {
      action, ...source,
      ...(input.threadId ? { threadId: input.threadId, listen: input.listen ?? false } : {}),
      ...(thread ? { threadTitle: threadTitle(thread) } : {}),
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      ...(voicePatch ? { patch: voicePatch } : {}),
    }, context.abortSignal));
  }

  #admittedThread(scope: RequestScope, threadId: string, context: TrustedToolInvocationContext): EnvironmentAuthorityResourceFact {
    const thread = this.authority.resolveThread(scope, threadId);
    if (!thread || !context.environmentAuthority.admittedEnvironmentIds.includes(thread.environmentId)) {
      throw new DomainError("not_found", "The requested thread is unavailable.");
    }
    return thread;
  }
}

/** A failed client result is an error that keeps the client's reason; every other status is the tool's output. */
function settled<T extends ClientActionResult>(result: T): T {
  if (result.status !== "failed") return result;
  throw new CanonicalAgentToolRequestError(result.reason === "settings_revision_conflict" ? "conflict" : "unavailable",
    `The client rejected the request: ${result.reason ?? "client_action_failed"}.`);
}

export function createClientControlToolDefinitions(service?: ClientControlToolService): AgentToolDefinition[] {
  return ids.map(id => {
    const manifest = CANONICAL_AGENT_TOOL_MANIFEST[id];
    const fields: TProperties = id === "client.list" ? {} : { clientId: Type.Optional(str()) };
    if (id === "client.switch_thread") Object.assign(fields, { threadId: str(), listen: Type.Optional(Type.Boolean()) });
    if (id === "client.settings.update") Object.assign(fields, { expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), patch });
    if (id === "client.replay_turn") Object.assign(fields, { threadId: Type.Optional(str()), turnId: str(160) });
    const schema = (value: unknown) => normalizeCanonicalAgentToolSchema({ ...value as object, $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT });
    const name = `sedes_${id.replaceAll(".", "_")}`;
    return {
      ...manifest, inputSchema: schema(object(fields)),
      outputSchema: schema(id === "client.list" ? object({ defaultClientId: Type.Union([str(), Type.Null()]), clients: Type.Array(client, { maxItems: 128 }) }) : result),
      requiredCapabilities: [],
      execution: { form: "inline", adapterWaitCeilingMilliseconds: { pi_sdk: 30_000, mcp: 30_000, http: 30_000, cli: 30_000 },
        supportsCancellation: true, idempotency: "not_applicable", progress: "none", maximumInputBytes: 4096, maximumOutputBytes: 131072,
        concurrencyClass: "client_control", uncertainExternalOutcome: id !== "client.list" && id !== "client.settings.get" },
      exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
      adapters: { pi: { name, label: manifest.catalog.label, promptSnippet: manifest.description },
        mcp: { name }, http: { invocation: "inline" }, cli: { command: id } },
      async execute(input, context) {
        if (!service) throw new DomainError("runtime_unavailable", "Client controls are unavailable.");
        return service.execute(id, input, context);
      },
    };
  });
}
