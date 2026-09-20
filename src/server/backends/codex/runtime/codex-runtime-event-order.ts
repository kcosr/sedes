import {
  CODEX_NOTIFICATION_THREAD_ROUTE_REGISTRY,
  type CodexClientRequestMethod,
} from "../../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import {
  codexRuntimeRequestKey, isCodexRuntimeRead,
  type CodexRuntimeEvent, type CodexRuntimePendingRequest,
} from "./codex-runtime-protocol.js";
import type { CodexRuntimeCommand } from "./codex-runtime-wire.js";

// Catalog responses install no transcript state. They follow runtime-wide
// barriers without waiting for unrelated thread output.
const catalogMethods = new Set<CodexClientRequestMethod>([
  "model/list", "experimentalFeature/list", "skills/list", "permissionProfile/list",
]);
const catalogAffinity = Symbol("codex_catalog");
type EventAffinity = string | typeof catalogAffinity | undefined;
// These reviewed methods affect one existing native thread. Creation/fork and
// unclassified methods retain the runtime-wide fence rather than guessing an
// affinity from an arbitrary field in a provider payload.
const threadMethods = new Set<CodexClientRequestMethod>([
  "thread/read", "thread/resume", "thread/turns/list", "thread/items/list",
  "thread/name/set", "thread/settings/update", "thread/goal/get",
  "thread/goal/set", "thread/goal/clear",
  "thread/unsubscribe", "thread/compact/start",
  "turn/start", "turn/steer", "turn/interrupt",
]);

/** Native threads are independent ordering domains within one Codex runtime.
 * A global event joins every preceding thread tail, and later thread events
 * follow it. Affinity is transport scheduling only, never authorization. */
export class CodexRuntimeEventOrder {
  readonly #threads = new Map<string, Promise<void>>();
  #global: Promise<void> | undefined;
  readonly #operations = new Map<string, string>();
  readonly #requests = new Map<string, string>();

  get idle(): boolean { return this.#global === undefined && this.#threads.size === 0; }

  fence(threadId?: EventAffinity): Promise<void> {
    return Promise.all(threadId === undefined
      ? [this.#global, ...this.#threads.values()]
      : threadId === catalogAffinity ? [this.#global]
      : [this.#global, this.#threads.get(threadId)]).then(() => undefined);
  }

  enqueue(event: CodexRuntimeEvent, send: () => Promise<void>): Promise<void> {
    const threadId = this.#eventThread(event);
    const tail = this.fence(threadId).then(send).finally(() => {
      if (threadId === undefined) {
        if (this.#global === tail) this.#global = undefined;
      } else if (this.#threads.get(threadId) === tail) this.#threads.delete(threadId);
    });
    if (threadId === undefined) this.#global = tail;
    else this.#threads.set(threadId, tail);
    return tail;
  }

  commandAffinity(command: CodexRuntimeCommand): EventAffinity {
    switch (command.action) {
      case "submit": return catalogMethods.has(command.input.method) ? catalogAffinity
        : threadMethods.has(command.input.method) ? stringMember(command.input.params, "threadId") : undefined;
      case "reattach_thread": return command.threadId;
      case "outcome": return this.#operations.get(command.operationId);
      case "respond": return this.#requests.get(codexRuntimeRequestKey(command.input.generation, command.input.requestId));
      default: return undefined;
    }
  }

  /** Called immediately before host submission; cancel only this reservation
   * if host admission rejects. Duplicate submissions keep the original route. */
  reserveSubmission(command: Extract<CodexRuntimeCommand, { action: "submit" }>): () => void {
    const threadId = this.commandAffinity(command);
    if (typeof threadId !== "string" || isCodexRuntimeRead(command.input.method) ||
      this.#operations.has(command.input.operationId) || this.#operations.size >= 128) return () => {};
    this.#operations.set(command.input.operationId, threadId);
    return () => { this.#operations.delete(command.input.operationId); };
  }

  acknowledge(operationId: string): void { this.#operations.delete(operationId); }

  rememberRequest(request: CodexRuntimePendingRequest): string | undefined {
    let threadId: string | undefined;
    switch (request.method) {
      case "applyPatchApproval":
      case "execCommandApproval": threadId = stringMember(request.params, "conversationId"); break;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "item/tool/requestUserInput":
      case "mcpServer/elicitation/request": threadId = stringMember(request.params, "threadId"); break;
    }
    if (threadId !== undefined) {
      const key = codexRuntimeRequestKey(request.generation, request.id);
      if (this.#requests.size < 128 || this.#requests.has(key)) this.#requests.set(key, threadId);
    }
    return threadId;
  }

  clearAffinities(): void { this.#operations.clear(); this.#requests.clear(); }

  #eventThread(event: CodexRuntimeEvent): string | undefined {
    switch (event.type) {
      case "notification": {
        if (event.notification.kind === "undecodable_notification") return event.notification.nativeThreadId;
        const route = CODEX_NOTIFICATION_THREAD_ROUTE_REGISTRY[event.notification.method];
        if (route?.path === "threadId") return stringMember(event.notification.params, "threadId");
        if (route?.path === "thread.id") return stringMember(member(event.notification.params, "thread"), "id");
        return undefined;
      }
      case "outcome": return this.#operations.get(event.outcome.operationId);
      case "server_request": return this.rememberRequest(event.request);
      case "server_request_settled": {
        const key = codexRuntimeRequestKey(event.generation, event.requestId);
        const threadId = this.#requests.get(key);
        this.#requests.delete(key);
        return threadId;
      }
      default: return undefined;
    }
  }
}

function member(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}
function stringMember(value: unknown, key: string): string | undefined {
  const candidate = member(value, key);
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 512 ? candidate : undefined;
}
