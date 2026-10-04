// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientControlConnection } from "./ClientControlConnection.js";
import type { ClientCommand } from "../../shared/protocol/client-controls.js";
import { navigate as navigateRoute } from "../app/router.js";

const command = (patch: Partial<ClientCommand> = {}): ClientCommand => ({ id: "action", action: "switch_thread", sourceThreadId: "source",
  sourceTurnId: "turn", threadId: "target", listen: false, expiresAt: Date.now() + 120000, ...patch });
afterEach(() => { vi.unstubAllGlobals(); });
describe("browser client controls", () => {
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
