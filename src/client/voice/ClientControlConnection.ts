import {
  clientPollResultSchema, registeredClientSchema, type RegisteredClient,
  type ClientCommand, type ClientActionResult, type ClientState,
} from "../../shared/protocol/client-controls.js";
import { authenticatedFetch } from "../authentication/auth-transport.js";
import type { SedesServerEndpoint } from "../app/server-endpoint.js";
import { subscribeRoute } from "../app/router.js";

/** One browser application connection. Reconnection drops pending actions and gets a fresh generation. */
export class ClientControlConnection {
  registration: RegisteredClient | undefined;
  #resumeToken: string | undefined;
  readonly #abort = new AbortController();
  readonly #deferred = new Map<string, { command: ClientCommand; location: string }>();
  readonly #unsubscribeRoute: () => void;
  readonly #visibilityChanged = () => { if (document.visibilityState === "hidden") this.#deferred.clear(); };
  constructor(readonly endpoint: SedesServerEndpoint, readonly navigate: (threadId: string) => void, readonly replaced: () => void = () => {}) {
    this.#unsubscribeRoute = subscribeRoute(() => this.#deferred.clear());
    document.addEventListener("visibilitychange", this.#visibilityChanged);
  }
  state(): ClientState {
    return { runtime: { foreground: document.visibilityState !== "hidden", voiceReady: false, interactionActive: false }, settings: null };
  }
  close() {
    this.#abort.abort(); this.registration = undefined; this.#deferred.clear(); this.#unsubscribeRoute();
    document.removeEventListener("visibilitychange", this.#visibilityChanged);
  }
  async run() {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      try {
        const session = await authenticatedFetch(this.endpoint, "/api/application/session", { signal });
        if (!session.ok) throw new Error("session_unavailable");
        const { csrfToken } = await session.json();
        if (typeof csrfToken !== "string") throw new Error("session_invalid");
        const request = async (path: string, body: unknown) => {
          const response = await authenticatedFetch(this.endpoint, path, {
            method: "POST", signal, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken,
              ...(this.registration ? { "X-Sedes-Client": this.registration.connectionToken } : {}) }, body: JSON.stringify(body),
          });
          if (response.status === 409) { this.close(); this.replaced(); throw new Error("client_connection_replaced"); }
          if (path === "/api/client-registration" && response.status === 404) this.#resumeToken = undefined;
          if (!response.ok) throw new Error("client_connection_unavailable");
          return response.json();
        };
        this.registration = registeredClientSchema.parse(await request("/api/client-registration", {
          platform: window.location.protocol === "capacitor-electron:" ? "electron" : "browser",
          ...(this.#resumeToken ? { resumeToken: this.#resumeToken } : {}),
          capabilities: { navigate: true, voice: false, voiceSettings: false }, state: this.state(),
        }));
        this.#resumeToken = this.registration.resumeToken;
        let acknowledgements: Array<{ id: string; result: ClientActionResult }> = [];
        while (!signal.aborted) {
          const result = clientPollResultSchema.parse(await request("/api/client-controls/poll", { state: this.state(), acknowledgements }));
          acknowledgements = result.commands.map(command => ({ id: command.id, result: this.execute(command) }));
        }
      } catch {
        this.registration = undefined; this.#deferred.clear();
        if (!signal.aborted) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 5_000); signal.addEventListener("abort", done, { once: true });
        });
      }
    }
  }
  execute(command: ClientCommand): ClientActionResult {
    const result = (status: ClientActionResult["status"], reason?: string): ClientActionResult => ({ status, ...(reason ? { reason } : {}), state: this.state() });
    for (const [id, pending] of this.#deferred) if (pending.command.expiresAt <= Date.now()) this.#deferred.delete(id);
    if (command.expiresAt <= Date.now()) return result("noop", "expired");
    if (command.action === "settings.get") return result("applied");
    if (command.action === "settings.update") return result("noop", "voice_settings_unsupported");
    if (command.action === "end_interaction") return result("noop", "no_active_voice_interaction");
    if (command.action === "switch_thread") {
      if (!this.state().runtime.foreground) return result("noop", "client_in_background");
      for (const [id, pending] of this.#deferred) {
        if (pending.command.sourceThreadId === command.sourceThreadId && pending.command.sourceTurnId === command.sourceTurnId) this.#deferred.delete(id);
      }
      if (this.#deferred.size >= 32) return result("failed", "client_busy");
      this.#deferred.set(command.id, { command, location: window.location.href });
      return result("accepted", command.listen ? "navigation_accepted_voice_unsupported" : "after_turn_completion");
    }
    const pending = this.#deferred.get(command.id);
    this.#deferred.delete(command.id);
    if (!pending || !this.state().runtime.foreground || pending.location !== window.location.href) return result("noop", "superseded");
    if (pending.command.threadId) this.navigate(pending.command.threadId);
    return result("applied", pending.command.listen ? "voice_unsupported" : undefined);
  }
}
