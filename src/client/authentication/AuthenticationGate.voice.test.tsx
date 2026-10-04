// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredSedesServer } from "../app/server-endpoint.js";
import { VOICE_IDENTITY } from "../voice/native-voice-test-fixture.js";

const credentials = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
const voice = vi.hoisted(() => ({ getState: vi.fn(), disconnect: vi.fn(), setConnection: vi.fn(), addListener: vi.fn(), listInputDevices: vi.fn() }));
vi.mock("../app/client-platform.js", () => ({ isPackagedClient: () => true, isAndroidClient: () => true }));
vi.mock("../app/client-credentials.js", () => ({ getCredential: credentials.get, setCredential: credentials.set, removeCredential: credentials.remove }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })) } }));
vi.mock("../voice/native-voice-plugin.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../voice/native-voice-plugin.js")>(), hasNativeVoice: () => true, nativeVoice: voice,
}));

import { AuthenticationGate } from "./AuthenticationGate.js";
import { AuthenticationSettings } from "./AuthenticationSettings.js";

afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("Android logout with native voice", () => {
  it("removes the saved credential even when the native voice bridge fails", async () => {
    const client = { id: "10000000-0000-4000-8000-000000000001", name: "Device", kind: "management", createdAt: "2026-09-13T00:00:00Z", expiresAt: "2027-09-13T00:00:00Z" };
    credentials.get.mockResolvedValue("o".repeat(43));
    credentials.remove.mockResolvedValue(undefined);
    voice.addListener.mockResolvedValue({ remove: vi.fn(async () => undefined) });
    voice.setConnection.mockRejectedValue(new Error("Server unavailable"));
    voice.getState.mockRejectedValue(new Error("Voice returned an invalid state."));
    voice.disconnect.mockRejectedValue(new Error("The Sedes connection changed before the voice action arrived."));
    let loggedOut = false;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path.endsWith("/logout")) { loggedOut = true; return Response.json({ ok: true }); }
      if (path.endsWith("/clients")) return Response.json({ clients: [client] });
      return Response.json(loggedOut ? { required: true, authenticated: false } : { required: true, authenticated: true, client, navigationNamespace: VOICE_IDENTITY });
    }));
    render(<AuthenticationGate endpoint={configuredSedesServer("https://device.example")} profileId="profile"><AuthenticationSettings /></AuthenticationGate>);
    await waitFor(() => expect(voice.setConnection).toHaveBeenCalledWith({ profileId: "profile", serverOrigin: "https://device.example", identity: VOICE_IDENTITY }));
    fireEvent.click(await screen.findByRole("button", { name: "Unpair" }));
    fireEvent.click(screen.getByRole("button", { name: "Unpair this browser" }));
    expect(await screen.findByLabelText("Pairing URL or code")).toBeInTheDocument();
    expect(credentials.remove).toHaveBeenCalledExactlyOnceWith("profile", "https://device.example");
    // ClientCredentials.removeCredential disconnects the matching native binding before deleting the secret.
    expect(voice.disconnect).not.toHaveBeenCalled();
  });
});
