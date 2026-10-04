// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeVoiceState } from "../voice/native-voice-plugin.js";
import { disconnectedVoiceSnapshot, fakeVoicePlugin, VOICE_CONNECTION, VOICE_IDENTITY, VOICE_ORIGIN_ID, voiceSnapshot } from "../voice/native-voice-test-fixture.js";

const voice = vi.hoisted(() => ({ available: true, identity: undefined as string | undefined, fake: undefined as unknown as ReturnType<typeof fakeVoicePlugin>, disconnect: vi.fn(async () => undefined) }));
const platform = vi.hoisted(() => ({ native: false, name: "web" }));
const preferences = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
const graph = vi.hoisted(() => ({ clients: [] as Array<{ readOrigin: () => unknown }>, stores: 0, disposed: 0 }));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => platform.native, getPlatform: () => platform.name, isPluginAvailable: () => true }, registerPlugin: () => ({}) }));
vi.mock("@capacitor/preferences", () => ({ Preferences: preferences }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })) } }));
vi.mock("../voice/native-voice-plugin.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../voice/native-voice-plugin.js")>(),
  hasNativeVoice: () => voice.available,
  disconnectNativeVoice: voice.disconnect,
  nativeVoice: new Proxy({}, { get: (_target, key) => Reflect.get(voice.fake.plugin, key) }),
}));
// The real gate authenticates, then hands its admitted identity to VoiceProvider; only that hand-off matters here.
vi.mock("../authentication/AuthenticationGate.js", async () => {
  const { VoiceProvider } = await import("../voice/VoiceProvider.js");
  return { AuthenticationGate: ({ children }: { children: React.ReactNode }) =>
    <VoiceProvider profileId={VOICE_CONNECTION.profileId} serverOrigin={VOICE_CONNECTION.serverOrigin} identity={voice.identity}>{children}</VoiceProvider> };
});
vi.mock("../api/ApiClient.js", () => ({ ApiClient: class {
  constructor(_endpoint: unknown, _credential: unknown, readonly readOrigin: () => unknown) { graph.clients.push(this); }
} }));
vi.mock("../api/EventStreamTransport.js", () => ({ BrowserEventStreamTransport: class { reconnectAll() {} markAllNativeSuspended() {} closeAll() {} } }));
vi.mock("../stores/ThreadStoreRegistry.js", () => ({ ThreadStoreRegistry: class { setExperimentalUsageEnabled() {} dispose() {} } }));
vi.mock("../stores/ApplicationClientStore.js", () => ({
  ApplicationClientStore: class {
    readonly snapshot = { experimentalUsageEnabled: false };
    constructor() { graph.stores += 1; }
    subscribe = () => () => undefined;
    getSnapshot = () => this.snapshot;
    initialize = async () => undefined;
    resume = async () => undefined;
    dispose = () => { graph.disposed += 1; };
  },
  useApplicationStore: (store: { getSnapshot: () => unknown }) => store.getSnapshot(),
}));
vi.mock("../workspace-panels/panel-state.js", () => ({ PanelLayoutStore: class {} }));
vi.mock("../workspace-panels/registry.js", () => ({ workspacePanelTenants: {} }));
vi.mock("../components/ApplicationShell.js", () => ({ ApplicationShell: () => <main>Application ready</main> }));
vi.mock("../operations/OperationOverlay.js", () => ({ OperationOverlayHost: () => null }));
vi.mock("../operations/ThreadArchiveOperationHost.js", () => ({ ThreadArchiveOperationHost: () => null }));

import { App } from "./App.js";

const originKeys = () => Object.keys(localStorage).filter(key => key.startsWith("sedes-client-origin:"));
beforeEach(() => {
  voice.fake = fakeVoicePlugin(); voice.available = true; voice.identity = VOICE_IDENTITY;
  graph.clients.length = 0; graph.stores = 0; graph.disposed = 0;
  platform.native = false; platform.name = "web";
  voice.disconnect.mockClear(); preferences.get.mockReset(); preferences.set.mockReset();
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("application client origin", () => {
  it("renders before native voice connects and keeps one API client and store graph while the origin arrives, drops, and returns", async () => {
    let connect!: (state: NativeVoiceState) => void;
    voice.fake.plugin.setConnection.mockImplementationOnce(() => new Promise(resolve => { connect = resolve; }));
    render(<App />);
    expect(await screen.findByText("Application ready")).toBeInTheDocument();
    await waitFor(() => expect(voice.fake.plugin.setConnection).toHaveBeenCalledTimes(1));
    expect(graph.clients).toHaveLength(1);
    const client = graph.clients[0]!;
    expect(client.readOrigin()).toBeUndefined();
    await act(async () => { connect(voiceSnapshot()); });
    expect(client.readOrigin()).toEqual({ clientId: VOICE_ORIGIN_ID, connectionToken: "a".repeat(43) });
    act(() => voice.fake.emit("stateChanged", disconnectedVoiceSnapshot(2)));
    expect(client.readOrigin()).toBeUndefined();
    const reconnected = "44612c41-0bbb-455f-a5af-725bfc7ae768";
    voice.fake.plugin.setConnection.mockResolvedValueOnce(voiceSnapshot({ connectionGeneration: 3, originClientId: reconnected }));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => expect(client.readOrigin()).toEqual({ clientId: reconnected, connectionToken: "a".repeat(43) }));
    expect(graph.clients).toHaveLength(1);
    expect(graph.stores).toBe(1);
    expect(graph.disposed).toBe(0);
    expect(screen.getByText("Application ready")).toBeInTheDocument();
  });
  it("connects native voice once through the StrictMode effect replay", async () => {
    render(<StrictMode><App /></StrictMode>);
    await screen.findByText("Application ready");
    await waitFor(() => expect(graph.clients.at(-1)!.readOrigin()).toEqual({ clientId: VOICE_ORIGIN_ID, connectionToken: "a".repeat(43) }));
    expect(voice.fake.plugin.setConnection).toHaveBeenCalledTimes(1);
  });
  it("sends no WebView-generated origin on Android before the identity is known", async () => {
    voice.identity = undefined;
    render(<App />);
    await screen.findByText("Application ready");
    expect(graph.clients[0]!.readOrigin()).toBeUndefined();
    expect(voice.fake.plugin.setConnection).not.toHaveBeenCalled();
    expect(originKeys()).toEqual([]);
  });
  it("uses the server registration for a browser connection without a stored advisory origin", async () => {
    voice.available = false;
    const registration = { clientId: VOICE_ORIGIN_ID, connectionToken: "a".repeat(43) };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/application/session")) return new Response(JSON.stringify({ csrfToken: "csrf-test" }));
      if (path.endsWith("/api/client-registration")) return new Response(JSON.stringify(registration));
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }));
    render(<App />);
    await screen.findByText("Application ready");
    await waitFor(() => expect(graph.clients[0]!.readOrigin()).toEqual({ clientId: registration.clientId, connectionToken: registration.connectionToken }));
    expect(originKeys()).toEqual([]);
    expect(voice.fake.plugin.setConnection).not.toHaveBeenCalled();
  });
  it("stops the departing profile's native voice only after the server switch is saved", async () => {
    platform.native = true; platform.name = "android";
    preferences.get.mockResolvedValue({ value: null });
    preferences.set.mockRejectedValueOnce(new Error("Device storage is full."));
    render(<App />);
    await screen.findByRole("heading", { name: "Connect to Sedes" });
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "Home" } });
    fireEvent.change(screen.getByLabelText("Sedes server URL"), { target: { value: "http://192.168.1.20:4783" } });
    fireEvent.click(screen.getByRole("button", { name: "Add & connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Device storage is full.");
    expect(voice.disconnect).not.toHaveBeenCalled();
    preferences.set.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Add & connect" }));
    await screen.findByText("Application ready");
    expect(voice.disconnect).toHaveBeenCalledOnce();
    expect(voice.disconnect.mock.invocationCallOrder[0]).toBeGreaterThan(preferences.set.mock.invocationCallOrder.at(-1)!);
  });
});
