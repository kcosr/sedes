import { z } from "zod";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { BackendError, type AgentBackendInstance, type AgentConnectionProfile, type BackendHealth, type ConversationBackendDriver,
  type AttachConversationInput, type DiscoverConversationsInput, type ReadConversationInput, type ReleaseConversationResidencyInput } from "../contracts.js";
import { assertOpenCodeWorkspace, openCodeConversationError, requireOpenCodeBinding, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { OpenCodeNativeApi } from "./opencode-native-api.js";
import { OpenCodeConversationHandle, openCodeUnsupported, waitOpenCode } from "./opencode-conversation-handle.js";
import { serializeOpenCodeBindingDetail } from "./opencode-binding-detail.js";
import { OPENCODE_HISTORY_LIMITS, OpenCodeHistoryError, openCodeHistoryFingerprint } from "./opencode-history-reader.js";
import { mapOpenCodeConversationError } from "./opencode-conversation-error.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import type { OpenCodeRuntimeLease } from "./opencode-runtime.js";
import { acquireOpenCodeInputObserver } from "./opencode-input-observer.js";
import { createOpenCodeConversation } from "./opencode-conversation-creation.js";

const cursorSchema = z.strictObject({ v: z.literal(1), scope: z.string().length(43), native: z.string().min(1).max(16_384) });

/** Scope validation always precedes runtime acquisition or provider effects. */
export class OpenCodeConversationBackendDriver implements ConversationBackendDriver {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  constructor(readonly input: OpenCodeDriverContext) {
    this.instance = input.instance; this.connection = input.connection;
  }
  async health(): Promise<BackendHealth> {
    try { const runtime = await this.input.runtime(); await runtime.start(); return await runtime.health(); }
    catch { return { available: false, checkedAt: new Date().toISOString() }; }
  }
  async catalog(input: Parameters<ConversationBackendDriver["catalog"]>[0]) {
    try {
      assertOpenCodeWorkspace(this.input, input);
      const catalog = (await this.input.catalog.read({ connection: this.connection, workspace: input.workspace })).catalog;
      try {
        const skills = await this.input.skills.read({ connection: this.connection, workspace: input.workspace });
        return { ...catalog, skills: skills.skills, notices: [...catalog.notices, ...skills.notices] };
      } catch {
        return { ...catalog, notices: [...catalog.notices, boundDisplayText("The OpenCode skill catalog is unavailable.")] };
      }
    } catch (error) { throw mapOpenCodeConversationError(error); }
  }
  async create(input: Parameters<ConversationBackendDriver["create"]>[0]) { return createOpenCodeConversation(this.input, input); }
  async resolveBranchCheckpoint(..._input: Parameters<ConversationBackendDriver["resolveBranchCheckpoint"]>): Promise<never> { throw openCodeUnsupported(); }
  async branchConversation(..._input: Parameters<ConversationBackendDriver["branchConversation"]>): Promise<never> { throw openCodeUnsupported(); }
  async reconcileSubmission(input: Parameters<ConversationBackendDriver["reconcileSubmission"]>[0]) {
    if (!input.binding || !input.opaqueBindingDetail || input.reconciliationToken !== input.applicationOperationId) throw openCodeUnsupported();
    const attach = { scope: input.scope, workspace: input.workspace, binding: input.binding, opaqueBindingDetail: input.opaqueBindingDetail };
    requireOpenCodeBinding(this.input, attach);
    const kind = input.steerTarget ? "steer" : "submit";
    const receipt = this.input.repository.readOperation(input.scope, input.binding.applicationThreadId, input.applicationOperationId, kind);
    if (!receipt) return { status: "unresolved" as const, diagnostic: boundDisplayText("No private OpenCode dispatch proof exists for this input.") };
    if (receipt.disposition === "not_applied") return { status: "not_accepted" as const, retryable: false, diagnostic: boundDisplayText("The input was not dispatched to OpenCode.") };
    const runtime = await this.#runtime(); await runtime.start();
    const lease = runtime.acquire(); const lifetime = new AbortController();
    let observation: ReturnType<typeof acquireOpenCodeInputObserver> | undefined;
    try {
      observation = acquireOpenCodeInputObserver(this.input, attach, runtime, lease, lifetime.signal);
      return await observation.observer.reconcile(input.applicationOperationId, kind, AbortSignal.timeout(60_000));
    } catch (error) { throw mapOpenCodeConversationError(error); }
    finally { lifetime.abort(); observation?.release(); lease.release(); }
  }

  async discover(input: DiscoverConversationsInput) {
    try { return await this.#discover(input); }
    catch (error) { throw mapOpenCodeConversationError(error); }
  }

  async #discover(input: DiscoverConversationsInput) {
    assertOpenCodeWorkspace(this.input, input); input.signal.throwIfAborted();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) throw openCodeUnsupported();
    const scope = openCodeHistoryFingerprint([this.input.scope, this.instance.id, this.connection.id,
      this.input.nativeNamespaceKey, input.workspace.canonicalPath]);
    let cursor: string | undefined;
    if (input.cursor !== undefined) {
      try {
        if (input.cursor.length > 24_000 || !/^[A-Za-z0-9_-]+$/u.test(input.cursor)) throw new Error();
        const parsed = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
        if (parsed.scope !== scope) throw new Error();
        cursor = parsed.native;
      } catch { throw openCodeConversationError("opencode_discovery_cursor_invalid", "The OpenCode discovery cursor is invalid.", "invalid_state"); }
    }
    const runtime = await waitOpenCode(this.#runtime(), input.signal);
    await waitOpenCode(runtime.start(), input.signal); input.signal.throwIfAborted();
    const lease = runtime.acquire();
    try {
      const api = new OpenCodeNativeApi(lease.client);
      const page = await api.listSessions({ ...(cursor ? { cursor } : { directory: input.workspace.canonicalPath }), limit: input.limit, signal: input.signal });
      if (page.data.some(session => session.location.directory !== input.workspace.canonicalPath)) throw openCodeConversationError(
        "opencode_discovery_location_invalid", "OpenCode returned a conversation outside the selected workspace.", "incompatible_protocol");
      await runtime.assertCurrent(input.signal); input.signal.throwIfAborted();
      return { conversations: page.data.map(session => ({
        backendConversationId: session.id, canonicalWorkspacePath: input.workspace.canonicalPath,
        title: boundDisplayText(session.title).text, updatedAt: new Date(session.time.updated).toISOString(),
        opaqueBindingDetail: serializeOpenCodeBindingDetail({ version: 1, sessionId: session.id,
          tenantId: input.scope.tenantId, principalId: input.scope.principalId, backendInstanceId: this.instance.id,
          connectionProfileId: this.connection.id, executionEnvironmentId: this.connection.executionEnvironmentId,
          canonicalWorkspacePath: input.workspace.canonicalPath, nativeNamespaceKey: this.input.nativeNamespaceKey }),
        ...(session.parentID ? { nativeAncestry: { method: "provider_native" as const, parentBackendConversationId: session.parentID } } : {}),
      })), ...(page.cursor.next ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, scope, native: page.cursor.next })).toString("base64url") } : {}) };
    } finally { lease.release(); }
  }

  async attach(input: AttachConversationInput): Promise<OpenCodeConversationHandle> {
    try { return await this.#attach(input); }
    catch (error) { throw mapOpenCodeConversationError(error); }
  }

  async #attach(input: AttachConversationInput): Promise<OpenCodeConversationHandle> {
    requireOpenCodeBinding(this.input, input);
    const runtime = await this.#runtime(); await runtime.start();
    const lease = runtime.acquire();
    let handle: OpenCodeConversationHandle | undefined;
    try {
      const session = await new OpenCodeNativeApi(lease.client).getSession(input.binding.backendConversationId);
      if (session.location.directory !== input.workspace.canonicalPath) throw openCodeConversationError(
        "opencode_session_location_changed", "The OpenCode conversation moved to another workspace.", "invalid_state");
      await runtime.assertCurrent();
      handle = new OpenCodeConversationHandle(this.input, input, runtime, lease);
      input.onControlReady?.(handle.control);
      await this.input.tools.admit(this.input, input, runtime);
      return handle;
    } catch (error) {
      if (handle) await handle.close(); else lease.release();
      throw error;
    }
  }

  async read(input: ReadConversationInput) {
    const handle = await this.attach(input);
    try {
      const result = await handle.establishProjection({ signal: handle.control.lifetime });
      return { snapshot: result.snapshot, usage: await handle.usage() };
    } catch (error) { throw mapOpenCodeConversationError(error); }
    finally { await handle.close(); }
  }

  async releaseConversationResidency(input: ReleaseConversationResidencyInput): Promise<"released" | "busy" | "undelivered"> {
    requireOpenCodeBinding(this.input, input);
    let lease: OpenCodeRuntimeLease | undefined;
    const cancellation = new AbortController();
    try {
      const runtime = await this.#runtime(); await runtime.start();
      lease = runtime.acquire();
      const api = new OpenCodeNativeApi(lease.client);
      const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(OPENCODE_HISTORY_LIMITS.milliseconds)]);
      const sessionID = input.binding.backendConversationId;
      // Only the selected session lookup can prove absence. A failed inventory
      // or history lookup remains uncertainty about work, and cannot release it.
      const session = await api.getSession(sessionID, signal).catch(async error => {
        if (error instanceof OpenCodeRuntimeError && error.code === "opencode_native_not_found") {
          await runtime.assertCurrent(signal); throw mapOpenCodeConversationError(error);
        }
        throw error;
      });
      await runtime.assertCurrent(signal);
      if (session.location.directory !== input.workspace.canonicalPath) throw openCodeConversationError(
        "opencode_session_location_changed", "The OpenCode conversation moved to another workspace.", "invalid_state");
      const [unfinished, activity, pending, interactions] = await Promise.all([
        hasUnfinishedNativePeriod(api, sessionID, signal), api.getActivity(sessionID, input.workspace.canonicalPath, signal),
        api.getPending(sessionID, signal), api.getInteractions(sessionID, signal),
      ]);
      await runtime.assertCurrent(signal); signal.throwIfAborted();
      if (unfinished || activity.active || activity.activeChildren.length ||
          activity.shells.some(shell => shell.status === "running") || pending.length || interactions.permissions.length || interactions.forms.length) return "busy";
      // This releases client residency only; neither ownership mode retires the daemon here.
      this.input.executionEnvironment.release(input.binding.applicationThreadId);
      this.input.tools.release(input.binding.applicationThreadId);
      return "released";
    } catch (error) {
      // Normal retirement reports terminal provider absence and proceeds; strict
      // policy refresh propagates it. Neither consumer mistakes it for busy work.
      if (error instanceof BackendError && (error.category === "not_found" || error.backendCode === "opencode_session_location_changed")) throw error;
      return "busy";
    } finally { cancellation.abort(); lease?.release(); }
  }

  async #runtime() {
    const runtime = await this.input.runtime();
    if (runtime.nativeNamespaceKey !== this.input.nativeNamespaceKey) throw openCodeConversationError(
      "opencode_runtime_namespace_mismatch", "The OpenCode runtime does not match the bound native store.", "permission_denied");
    return runtime;
  }
}

/** Read only the unfinished suffix, with the same finite native-history bounds. */
export async function hasUnfinishedNativePeriod(api: OpenCodeNativeApi, sessionID: string, signal: AbortSignal): Promise<boolean> {
  let cursor: string | undefined, bytes = 0, records = 0;
  const seen = new Set<string>(), cursors = new Set<string>();
  while (true) {
    signal.throwIfAborted();
    const page = await api.getHistoryPage(sessionID, { ...(cursor ? { cursor } : { order: "desc" }), limit: 50, signal });
    bytes += page.decodedBytes; records += page.data.length;
    if (bytes > OPENCODE_HISTORY_LIMITS.decodedBytes) throw new OpenCodeHistoryError("bytes");
    if (records > OPENCODE_HISTORY_LIMITS.records) throw new OpenCodeHistoryError("records");
    for (const message of page.data) {
      if (seen.has(message.id)) throw new OpenCodeHistoryError("invalidated");
      seen.add(message.id);
      if (message.type === "idle") return false;
      if (["user", "assistant", "synthetic", "compaction"].includes(message.type) || message.type === "shell" && message.status === "running") return true;
    }
    if (!page.data.length) return false;
    if (!page.cursor.next || cursors.has(page.cursor.next)) throw new OpenCodeHistoryError("invalidated");
    cursor = page.cursor.next; cursors.add(cursor);
  }
}
