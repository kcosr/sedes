// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientControlConnection } from "./ClientControlConnection.js";
import type { ClientCommand } from "../../shared/protocol/client-controls.js";
import { navigate as navigateRoute } from "../app/router.js";

const command = (patch: Partial<ClientCommand> = {}): ClientCommand => ({ id: "action", action: "switch_thread", sourceThreadId: "source",
  sourceTurnId: "turn", threadId: "target", listen: false, expiresAt: Date.now() + 120000, ...patch });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("browser client controls", () => {
  it("resumes the same anonymous session after an outage without replaying pending navigation", async () => {
    vi.useFakeTimers();
    const registrations: Array<Record<string, unknown>> = [];
    let polls = 0;
    const clientId = "11111111-1111-4111-8111-111111111111";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session")) return new Response(JSON.stringify({ csrfToken: "csrf" }));
      if (url.endsWith("/client-registration")) {
        registrations.push(JSON.parse(init!.body as string));
        expect(init!.credentials).toBe("same-origin");
        return new Response(JSON.stringify({ clientId, connectionToken: String(registrations.length).repeat(43), resumeToken: "r".repeat(43) }));
      }
      if (++polls === 1) throw new Error("network unavailable");
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }));
    const navigate = vi.fn(), client = new ClientControlConnection({ baseUrl: null }, navigate);
    const running = client.run();
    await vi.waitFor(() => expect(polls).toBe(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(registrations).toHaveLength(2);
    expect(registrations[0]).not.toHaveProperty("resumeToken");
    expect(registrations[1]).toHaveProperty("resumeToken", "r".repeat(43));
    expect(client.registration?.clientId).toBe(clientId);
    expect(client.registration?.connectionToken).toBe("2".repeat(43));
    client.execute(command({ action: "turn_settled" })); expect(navigate).not.toHaveBeenCalled();
    client.close(); await running;
  });

  it("surfaces a replaced window without reclaiming the paired connection in a retry loop", async () => {
    const replaced = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/session")
      ? new Response(JSON.stringify({ csrfToken: "csrf" })) : new Response("{}", { status: 409 })));
    const client = new ClientControlConnection({ baseUrl: null }, vi.fn(), replaced);
    await client.run();
    expect(replaced).toHaveBeenCalledOnce();
    expect(client.registration).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports unsupported voice and only navigates after its matching turn settles", () => {
    const navigate = vi.fn(); const client = new ClientControlConnection({ baseUrl: null }, navigate);
    expect(client.execute(command({ action: "settings.get" }))).toMatchObject({ status: "applied", state: { settings: null, runtime: { voiceReady: false } } });
    expect(client.execute(command({ action: "end_interaction" }))).toMatchObject({ status: "noop", reason: "no_active_voice_interaction" });
    expect(client.execute(command({ listen: true }))).toMatchObject({ status: "accepted", reason: "navigation_accepted_voice_unsupported" });
    expect(navigate).not.toHaveBeenCalled();
    client.execute(command({ action: "turn_settled", id: "another" }));
    expect(navigate).not.toHaveBeenCalled();
    client.execute(command({ action: "turn_settled" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith("target");
    client.execute(command({ action: "turn_settled" }));
    expect(navigate).toHaveBeenCalledTimes(1);
    client.close();
  });
  it("drops expired, disconnected, manually superseded, and background navigation", () => {
    const navigate = vi.fn(); const client = new ClientControlConnection({ baseUrl: null }, navigate);
    expect(client.execute(command({ expiresAt: 0 }))).toMatchObject({ status: "noop", reason: "expired" });
    client.execute(command()); client.close(); client.execute(command({ action: "turn_settled" }));
    expect(navigate).not.toHaveBeenCalled();
    client.execute(command());
    const previous = window.location.href;
    window.history.replaceState(null, "", "#manual-navigation");
    client.execute(command({ action: "turn_settled" }));
    window.history.replaceState(null, "", previous);
    expect(navigate).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    expect(client.execute(command())).toMatchObject({ status: "noop", reason: "client_in_background" });
    vi.restoreAllMocks(); client.close();
  });
  it("does not revive a deferred switch after navigating away and back or returning from the background", () => {
    const navigate = vi.fn(); const client = new ClientControlConnection({ baseUrl: null }, navigate);
    navigateRoute("/threads/source");
    client.execute(command());
    navigateRoute("/threads/other"); navigateRoute("/threads/source");
    expect(client.execute(command({ action: "turn_settled" }))).toMatchObject({ status: "noop", reason: "superseded" });
    client.execute(command());
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange"));
    expect(client.execute(command({ action: "turn_settled" }))).toMatchObject({ status: "noop", reason: "superseded" });
    expect(navigate).not.toHaveBeenCalled();
    visibility.mockRestore(); client.close(); navigateRoute("/");
  });
});
