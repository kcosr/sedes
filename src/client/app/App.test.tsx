// @vitest-environment jsdom

import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authenticationMode = vi.hoisted(() => ({ required: true }));
const platform = vi.hoisted(() => ({ native: false, name: "web" }));
const preferences = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
const capacitorApp = vi.hoisted(() => ({ addListener: vi.fn() }));
const outputImageActions = vi.hoisted(() => ({
  presentActions: vi.fn(),
  beginTransfer: vi.fn(),
  appendTransfer: vi.fn(),
  completeTransfer: vi.fn(),
  abortTransfer: vi.fn(),
}));
const connectionRuntimeNative = vi.hoisted(() => ({
  startLocal: vi.fn(),
  connectSsh: vi.fn(),
  disconnect: vi.fn(),
  getStatus: vi.fn(),
  addListener: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => platform.name,
  },
  registerPlugin: (name: string) =>
    name === "ElectronConnectionRuntime"
      ? connectionRuntimeNative
      : outputImageActions,
}));
vi.mock("@capacitor/preferences", () => ({ Preferences: preferences }));
vi.mock("@capacitor/app", () => ({ App: capacitorApp }));

vi.mock("../authentication/auth-transport.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../authentication/auth-transport.js")>();
  return { ...original, authenticatedFetch: (endpoint: import("./server-endpoint.js").SedesServerEndpoint, path: string, init?: RequestInit, credential?: string | null) =>
    path === "/api/auth/status" ? Promise.resolve(Response.json({ required: authenticationMode.required, authenticated: false })) : original.authenticatedFetch(endpoint, path, init, credential) };
});

// Authentication and fetch SSE have dedicated integration suites; these tests
// isolate connection switching and application lifecycle ownership.
vi.mock("../authentication/AuthenticationGate.js", () => ({
  AuthenticationGate: ({ children }: { children: import("react").ReactNode }) => children,
}));
vi.mock("./client-credentials.js", () => ({
  getCredential: vi.fn().mockResolvedValue(null),
  removeCredential: vi.fn().mockResolvedValue(undefined),
  removeProfileCredentials: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../api/FetchEventSource.js", () => ({
  FetchEventSource: class {
    constructor(endpoint: { baseUrl: string }, path: string) {
      return new EventSource(new URL(path, endpoint.baseUrl).toString(), { withCredentials: false });
    }
  },
}));

import { App } from "./App.js";
import { navigate } from "./router.js";
import {
  getSidebarViewPreferences,
  setSidebarInventoryScope,
} from "./sidebar-view-store.js";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/index.js";
import { SEDES_VERSION } from "../../shared/version.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static applicationSnapshot: unknown;
  static automaticApplicationSnapshots = Number.POSITIVE_INFINITY;
  readonly listeners = new Map<string, EventListener>();
  onerror?: () => void;
  closed = false;
  readyState = 0;

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListener): void {
    this.listeners.set(name, listener);
    if (
      name === "application" &&
      FakeEventSource.automaticApplicationSnapshots > 0
    ) {
      FakeEventSource.automaticApplicationSnapshots -= 1;
      queueMicrotask(() => {
        if (this.closed) return;
        this.emitApplicationSnapshot();
      });
    }
  }

  emitApplicationSnapshot(): void {
    this.listeners.get("application")?.(
      new MessageEvent("application", {
        data: JSON.stringify({
          eventId: applicationEventId,
          applicationGeneration: "application-1",
          event: {
            type: "snapshot",
            generation: "application-1",
            snapshot: FakeEventSource.applicationSnapshot,
          },
        }),
      }),
    );
  }

  close(): void {
    this.closed = true;
  }
}

const applicationSession = {
  clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
  version: SEDES_VERSION,
  csrfToken: "a".repeat(32),
  providerPulseEnabled: true,
};
// Kept as a local test-fixture alias while endpoint-focused cases below are
// migrated from the former inventory-bearing bootstrap response.
const applicationBootstrap = applicationSession;
const applicationEventId = "10000000-0000-4000-8000-000000000001.0";
const applicationSnapshot = {
  advisories: [],
  environments: [
    {
      id: "10000000-0000-4000-8000-000000000002",
      kind: "local" as const,
      label: { text: "Local" },
      available: true,
      directoryBrowsing: "available" as const,
    },
  ],
  workspaces: [],
  executionTargets: [],
  defaultNewThreadTargetId: null,
  threads: [],
  groups: [],
  forkOrigins: [],
  lineagePlacements: [],
  lineageFamilies: [],
  counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
  tasks: [],
};

beforeEach(() => {
  authenticationMode.required = true;
  platform.native = false;
  platform.name = "web";
  preferences.get.mockReset();
  preferences.set.mockReset();
  preferences.remove.mockReset();
  connectionRuntimeNative.startLocal.mockReset();
  connectionRuntimeNative.connectSsh.mockReset();
  connectionRuntimeNative.disconnect.mockReset();
  connectionRuntimeNative.disconnect.mockResolvedValue(undefined);
  connectionRuntimeNative.getStatus.mockReset();
  connectionRuntimeNative.getStatus.mockResolvedValue({
    local: { status: "disconnected" },
    ssh: { status: "disconnected" },
  });
  connectionRuntimeNative.addListener.mockReset();
  connectionRuntimeNative.addListener.mockResolvedValue({ remove: vi.fn() });
  capacitorApp.addListener.mockReset();
  capacitorApp.addListener.mockResolvedValue({ remove: vi.fn() });
  FakeEventSource.instances = [];
  FakeEventSource.applicationSnapshot = applicationSnapshot;
  FakeEventSource.automaticApplicationSnapshots = Number.POSITIVE_INFINITY;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  window.localStorage.clear();
  delete document.documentElement.dataset.sidebarCollapsed;
  stubMediaQueries(false);
  window.history.replaceState(null, "", "/");
  navigate("/", { replace: true });
});

function stubMediaQueries(mobileLayout: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 819px)" ? mobileLayout : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function androidPreferencesDocument() {
  const id = "10000000-0000-4000-8000-000000000099";
  return JSON.stringify({
    version: 1,
    profiles: [{ id, name: "Home", baseUrl: "http://192.168.1.20:4783" }],
    selectedProfileId: id,
  });
}

function electronPreferencesDocument(
  selected: "local" | "direct" | "ssh" | null,
  autoConnectAtStartup = true,
): string {
  const directId = "10000000-0000-4000-8000-000000000010";
  const sshId = "10000000-0000-4000-8000-000000000011";
  return JSON.stringify({
    version: 2,
    profiles: [
      {
        id: directId,
        name: "Direct server",
        kind: "direct",
        baseUrl: "http://direct.example:4784",
      },
      {
        id: sshId,
        name: "Remote SSH",
        kind: "ssh",
        sshHost: "remote-dev",
        remotePort: 4784,
      },
    ],
    selectedProfileId:
      selected === "local"
        ? "00000000-0000-4000-8000-000000000001"
        : selected === "direct"
          ? directId
          : selected === "ssh"
            ? sshId
            : null,
    autoConnectAtStartup,
  });
}

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("application endpoint startup", () => {
  it("keeps browser startup same-origin through the StrictMode lifecycle", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(applicationBootstrap),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/application/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(preferences.get).not.toHaveBeenCalled();
    expect(connectionRuntimeNative.addListener).not.toHaveBeenCalled();
    expect(connectionRuntimeNative.startLocal).not.toHaveBeenCalled();
    expect(connectionRuntimeNative.connectSsh).not.toHaveBeenCalled();
    expect(connectionRuntimeNative.disconnect).not.toHaveBeenCalled();
    expect(FakeEventSource.instances.some(({ closed }) => !closed)).toBe(true);
  });

  it("preserves EventSource cursors across short and sustained background intervals", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationBootstrap)),
    );

    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    FakeEventSource.instances.forEach((source) => {
      source.readyState = 1;
    });
    const initialCount = FakeEventSource.instances.length;

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(initialCount);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(initialCount);
    expect(FakeEventSource.instances.every(({ closed }) => !closed)).toBe(true);
  });

  it("does not construct API or SSE traffic while native is disconnected", async () => {
    platform.native = true;
    platform.name = "android";
    preferences.get.mockResolvedValue({ value: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(
      await screen.findByRole("heading", { name: "Connect to Sedes" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(preferences.get).toHaveBeenCalled());
    expect(preferences.get).toHaveBeenCalledWith({ key: "sedes.connections.v1" });
    expect(preferences.get).not.toHaveBeenCalledWith({
      key: "sedes.electron.connections.v1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(connectionRuntimeNative.addListener).not.toHaveBeenCalled();
    expect(connectionRuntimeNative.startLocal).not.toHaveBeenCalled();
    expect(connectionRuntimeNative.connectSsh).not.toHaveBeenCalled();
    expect(connectionRuntimeNative.disconnect).not.toHaveBeenCalled();
  });

  it("adds an Android connection and persists its selected profile separately from credentials", async () => {
    platform.native = true;
    platform.name = "android";
    preferences.get.mockResolvedValue({ value: null });
    preferences.set.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(applicationBootstrap)));
    render(<App />);
    await screen.findByRole("heading", { name: "Connect to Sedes" });
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "Home" } });
    fireEvent.change(screen.getByLabelText("Sedes server URL"), { target: { value: "http://192.168.1.20:4783" } });
    fireEvent.click(screen.getByRole("button", { name: "Add & connect" }));
    await screen.findByRole("heading", { name: "What should the agent work on?" });
    const saved = preferences.set.mock.calls[0]![0];
    expect(saved.key).toBe("sedes.connections.v1");
    const document = JSON.parse(saved.value);
    expect(document).toEqual({
      version: 1,
      profiles: [{ id: expect.any(String), name: "Home", baseUrl: "http://192.168.1.20:4783" }],
      selectedProfileId: document.profiles[0].id,
    });
  });

  it("shows the Electron chooser on first launch without API or SSE traffic", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({ value: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(
      await screen.findByRole("heading", { name: "Choose a Sedes connection" }),
    ).toBeInTheDocument();
    expect(preferences.get).toHaveBeenCalledWith({
      key: "sedes.electron.connections.v1",
    });
    expect(preferences.get).not.toHaveBeenCalledWith({
      key: "sedes.connections.v1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(connectionRuntimeNative.connectSsh).not.toHaveBeenCalled();
  });

  it("starts Local only after first-run selection and persists it after bootstrap", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({ value: null });
    connectionRuntimeNative.startLocal.mockImplementation(
      async ({ connectionId }: { readonly connectionId: string }) => ({
        connectionId,
        authenticationRequired: true, baseUrl: "http://127.0.0.1:49150",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationBootstrap)),
    );

    render(<App />);
    const localCard = (
      await screen.findByRole("heading", { name: "Local" })
    ).closest("li")!;
    expect(connectionRuntimeNative.startLocal).not.toHaveBeenCalled();
    fireEvent.click(within(localCard).getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(connectionRuntimeNative.startLocal).toHaveBeenCalledOnce();
    expect(preferences.set).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.stringContaining(
          '"selectedProfileId":"00000000-0000-4000-8000-000000000001"',
        ),
      }),
    );
  });

  it("auto-connects a selected Local profile once under StrictMode", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("local"),
    });
    connectionRuntimeNative.startLocal.mockImplementation(
      async ({ connectionId }: { readonly connectionId: string }) => ({
        connectionId,
        authenticationRequired: true, baseUrl: "http://127.0.0.1:49150",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationBootstrap)),
    );

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(connectionRuntimeNative.startLocal).toHaveBeenCalledOnce();
  });

  it("adopts the exact managed Local process after a renderer reload", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("local"),
    });
    connectionRuntimeNative.getStatus.mockResolvedValue({
      local: {
        status: "connected",
        connectionId: "20000000-0000-4000-8000-000000000005",
        authenticationRequired: true, baseUrl: "http://127.0.0.1:49155",
      },
      ssh: { status: "disconnected" },
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      Response.json(applicationBootstrap),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(connectionRuntimeNative.startLocal).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:49155/api/application/session",
      expect.any(Object),
    );
  });

  it("retains Local through confirmation and stops its exact process only after replacement succeeds", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("local"),
    });
    let localConnectionId = "";
    connectionRuntimeNative.startLocal.mockImplementation(
      async ({ connectionId }: { readonly connectionId: string }) => {
        localConnectionId = connectionId;
        return { connectionId, authenticationRequired: true, baseUrl: "http://127.0.0.1:49150" };
      },
    );
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      Response.json(applicationBootstrap),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("heading", {
      name: "What should the agent work on?",
    });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("button", { name: "Connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch connection" }));
    const localCard = (
      await screen.findByRole("heading", { name: "Local" })
    ).closest("li")!;
    expect(localCard).toHaveTextContent("Currently running");
    expect(connectionRuntimeNative.disconnect).not.toHaveBeenCalled();

    const directCard = screen
      .getByRole("heading", { name: "Direct server" })
      .closest("li")!;
    fireEvent.click(
      within(directCard).getByRole("button", { name: "Connect" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Switch away from Local?" }),
    ).toBeVisible();
    expect(connectionRuntimeNative.disconnect).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Connect to Direct server",
      }),
    );

    await waitFor(() =>
      expect(connectionRuntimeNative.disconnect).toHaveBeenCalledWith({
        connectionId: localConnectionId,
      }),
    );
    expect(preferences.set.mock.invocationCallOrder[1]).toBeLessThan(
      connectionRuntimeNative.disconnect.mock.invocationCallOrder[0]!,
    );
    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://direct.example:4784/api/application/session",
      expect.any(Object),
    );
  });

  it("restores the exact Local process when a confirmed replacement fails", async () => {
    platform.native = true;
    platform.name = "electron";
    let storedPreference = electronPreferencesDocument("local");
    preferences.get.mockImplementation(async () => ({
      value: storedPreference,
    }));
    preferences.set.mockImplementation(
      async ({ value }: { readonly value: string }) => {
        storedPreference = value;
      },
    );
    let localConnectionId = "";
    connectionRuntimeNative.startLocal.mockImplementation(
      async ({ connectionId }: { readonly connectionId: string }) => {
        localConnectionId = connectionId;
        return { connectionId, authenticationRequired: true, baseUrl: "http://127.0.0.1:49150" };
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("http://direct.example:4784")
          ? Response.json(
              {
                error: {
                  code: "runtime_unavailable",
                  message: "Remote server is unavailable.",
                  retryable: true,
                },
              },
              { status: 503 },
            )
          : Response.json(applicationBootstrap),
      ),
    );
    render(<App />);
    await screen.findByRole("heading", {
      name: "What should the agent work on?",
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("button", { name: "Connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch connection" }));
    const directCard = (
      await screen.findByRole("heading", { name: "Direct server" })
    ).closest("li")!;
    fireEvent.click(
      within(directCard).getByRole("button", { name: "Connect" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Connect to Direct server",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Local is still running",
    );
    expect(
      screen.getByRole("heading", { name: "What should the agent work on?" }),
    ).toBeInTheDocument();
    expect(connectionRuntimeNative.disconnect).not.toHaveBeenCalledWith({
      connectionId: localConnectionId,
    });
    expect(JSON.parse(storedPreference)).toMatchObject({
      selectedProfileId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("preserves Local when the replacement server requires authentication but its vault read fails", async () => {
    const { getCredential } = await import("./client-credentials.js");
    platform.native = true; platform.name = "electron";
    let storedPreference = electronPreferencesDocument("local");
    preferences.get.mockImplementation(async () => ({ value: storedPreference }));
    preferences.set.mockImplementation(async ({ value }: { value: string }) => { storedPreference = value; });
    let localConnectionId = "";
    connectionRuntimeNative.startLocal.mockImplementation(async ({ connectionId }: { connectionId: string }) => {
      localConnectionId = connectionId; return { connectionId, authenticationRequired: true, baseUrl: "http://127.0.0.1:49150" };
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(applicationBootstrap)));
    render(<App />);
    await screen.findByRole("heading", { name: "What should the agent work on?" });
    vi.mocked(getCredential).mockRejectedValue(new Error("Credential vault is locked"));
    try {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.click(within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("button", { name: "Connection" }));
      fireEvent.click(screen.getByRole("button", { name: "Switch connection" }));
      const card = (await screen.findByRole("heading", { name: "Direct server" })).closest("li")!;
      fireEvent.click(within(card).getByRole("button", { name: "Connect" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Connect to Direct server" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Credential vault is locked");
      expect(screen.getByRole("heading", { name: "What should the agent work on?" })).toBeInTheDocument();
      expect(connectionRuntimeNative.disconnect).not.toHaveBeenCalledWith({ connectionId: localConnectionId });
      expect(JSON.parse(storedPreference).selectedProfileId).toBe("00000000-0000-4000-8000-000000000001");
    } finally { vi.mocked(getCredential).mockResolvedValue(null); }
  });

  it("cancels an exact SSH candidate and restores Local without stopping it", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("local"),
    });
    let localConnectionId = "";
    connectionRuntimeNative.startLocal.mockImplementation(
      async ({ connectionId }: { readonly connectionId: string }) => {
        localConnectionId = connectionId;
        return { connectionId, authenticationRequired: true, baseUrl: "http://127.0.0.1:49150" };
      },
    );
    let sshConnectionId = "";
    let rejectSsh!: (error: Error) => void;
    connectionRuntimeNative.connectSsh.mockImplementation(
      ({ connectionId }: { readonly connectionId: string }) => {
        sshConnectionId = connectionId;
        return new Promise((_resolve, reject) => {
          rejectSsh = reject;
        });
      },
    );
    connectionRuntimeNative.disconnect.mockImplementation(
      async ({ connectionId }: { readonly connectionId: string }) => {
        if (connectionId === sshConnectionId) {
          rejectSsh(new Error("SSH candidate cancelled."));
        }
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationBootstrap)),
    );
    render(<App />);
    await screen.findByRole("heading", {
      name: "What should the agent work on?",
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("button", { name: "Connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch connection" }));
    const sshCard = (
      await screen.findByRole("heading", { name: "Remote SSH" })
    ).closest("li")!;
    fireEvent.click(within(sshCard).getByRole("button", { name: "Connect" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Connect to Remote SSH",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(connectionRuntimeNative.disconnect).toHaveBeenCalledWith({
      connectionId: sshConnectionId,
    });
    expect(connectionRuntimeNative.disconnect).not.toHaveBeenCalledWith({
      connectionId: localConnectionId,
    });
  });

  it("fails closed and compensates Local selection when exact Local stop fails", async () => {
    platform.native = true;
    platform.name = "electron";
    let storedPreference = electronPreferencesDocument("local");
    preferences.get.mockImplementation(async () => ({
      value: storedPreference,
    }));
    preferences.set.mockImplementation(
      async ({ value }: { readonly value: string }) => {
        storedPreference = value;
      },
    );
    let localConnectionId = "";
    connectionRuntimeNative.startLocal.mockImplementation(
      async ({ connectionId }: { readonly connectionId: string }) => {
        localConnectionId = connectionId;
        return { connectionId, authenticationRequired: true, baseUrl: "http://127.0.0.1:49150" };
      },
    );
    connectionRuntimeNative.disconnect
      .mockRejectedValueOnce(new Error("Local process did not exit."))
      .mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationBootstrap)),
    );
    render(<App />);
    await screen.findByRole("heading", {
      name: "What should the agent work on?",
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("button", { name: "Connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch connection" }));
    const directCard = (
      await screen.findByRole("heading", { name: "Direct server" })
    ).closest("li")!;
    fireEvent.click(
      within(directCard).getByRole("button", { name: "Connect" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Connect to Direct server",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not stop Local",
    );
    expect(connectionRuntimeNative.disconnect).toHaveBeenCalledWith({
      connectionId: localConnectionId,
    });
    await waitFor(() =>
      expect(JSON.parse(storedPreference)).toMatchObject({
        selectedProfileId: "00000000-0000-4000-8000-000000000001",
      }),
    );
  });

  it("shows the explicitly disabled authentication policy for Local in connection settings", async () => {
    authenticationMode.required = false;
    platform.native = true; platform.name = "electron";
    preferences.get.mockResolvedValue({ value: electronPreferencesDocument("local") });
    connectionRuntimeNative.startLocal.mockImplementation(async ({ connectionId }: { connectionId: string }) => ({ connectionId, baseUrl: "http://127.0.0.1:49150", authenticationRequired: false }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(applicationBootstrap)));
    render(<App />);
    await screen.findByRole("heading", { name: "What should the agent work on?" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Settings pages" })).getByRole("button", { name: "Connection" }));
    expect(screen.getByText("Authentication disabled")).toBeInTheDocument();
  });

  it("opens an auth-disabled Electron server without waiting for the credential vault", async () => {
    const { getCredential } = await import("./client-credentials.js");
    authenticationMode.required = false;
    platform.native = true; platform.name = "electron";
    preferences.get.mockResolvedValue({ value: electronPreferencesDocument("direct") });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(applicationBootstrap)));
    vi.mocked(getCredential).mockClear();
    vi.mocked(getCredential).mockReturnValue(new Promise(() => undefined));
    try {
      render(<App />);
      await screen.findByRole("heading", { name: "What should the agent work on?" });
      expect(getCredential).not.toHaveBeenCalled();
    } finally { vi.mocked(getCredential).mockResolvedValue(null); }
  });

  it("auto-connects the last successful direct Electron profile only once", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("direct"),
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(applicationBootstrap),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/application/session"),
      ),
    ).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://direct.example:4784/api/application/session",
      expect.objectContaining({ credentials: "omit" }),
    );
    expect(connectionRuntimeNative.connectSsh).not.toHaveBeenCalled();
    expect(preferences.set).toHaveBeenCalledTimes(1);
  });

  it("opens the chooser at startup when auto-connect is off and preserves that choice after manual connection", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("direct", false),
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(applicationBootstrap),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const directCard = (
      await screen.findByRole("heading", { name: "Direct server" })
    ).closest("li")!;
    expect(
      screen.getByRole("checkbox", {
        name: "Connect automatically at startup",
      }),
    ).not.toBeChecked();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(connectionRuntimeNative.startLocal).not.toHaveBeenCalled();
    expect(connectionRuntimeNative.connectSsh).not.toHaveBeenCalled();
    expect(preferences.set).not.toHaveBeenCalled();

    fireEvent.click(
      within(directCard).getByRole("button", { name: "Connect" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(JSON.parse(preferences.set.mock.calls[0]![0].value)).toMatchObject({
      selectedProfileId: "10000000-0000-4000-8000-000000000010",
      autoConnectAtStartup: false,
    });
  });

  it("waits for Electron bootstrap before selecting an SSH profile", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("ssh"),
    });
    connectionRuntimeNative.connectSsh.mockResolvedValue({
      connectionId: "20000000-0000-4000-8000-000000000001",
      baseUrl: "http://127.0.0.1:49152",
    });
    let resolveBootstrap!: (response: Response) => void;
    const bootstrapPending = new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => bootstrapPending)
      .mockImplementation(async () => Response.json(applicationBootstrap));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() =>
      expect(connectionRuntimeNative.connectSsh).toHaveBeenCalledTimes(1),
    );
    expect(connectionRuntimeNative.connectSsh).toHaveBeenCalledWith({
      profileId: "10000000-0000-4000-8000-000000000011",
      connectionId: expect.any(String),
      hostAlias: "remote-dev",
      remotePort: 4784,
    });
    expect(preferences.set).not.toHaveBeenCalled();

    resolveBootstrap(Response.json(applicationBootstrap));
    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(preferences.set).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/api/application/session",
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it("returns an incompatible Electron profile to the chooser and stops SSH", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("ssh"),
    });
    connectionRuntimeNative.connectSsh.mockResolvedValue({
      connectionId: "20000000-0000-4000-8000-000000000001",
      baseUrl: "http://127.0.0.1:49152",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { ...applicationBootstrap, clientProtocolVersion: 999_999 },
          { status: 200 },
        ),
      ),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Choose a Sedes connection" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /protocol|invalid/u,
    );
    expect(preferences.set).not.toHaveBeenCalled();
    expect(connectionRuntimeNative.disconnect).toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("leaves a lost SSH connection and ignores stale or explicit loss events", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("ssh"),
    });
    connectionRuntimeNative.connectSsh.mockResolvedValue({
      connectionId: "20000000-0000-4000-8000-000000000001",
      baseUrl: "http://127.0.0.1:49152",
    });
    let stateChange!: (state: unknown) => void;
    connectionRuntimeNative.addListener.mockImplementation(
      async (_event: string, listener: (state: unknown) => void) => {
        stateChange = listener;
        return { remove: vi.fn() };
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationBootstrap)),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();

    act(() => {
      stateChange({
        kind: "ssh",
        status: "disconnected",
        connectionId: "20000000-0000-4000-8000-000000000099",
        error: { code: "ssh_tunnel_lost", message: "Stale loss." },
      });
      stateChange({
        kind: "ssh",
        status: "disconnected",
        connectionId: "20000000-0000-4000-8000-000000000001",
      });
    });
    expect(
      screen.getByRole("heading", { name: "What should the agent work on?" }),
    ).toBeInTheDocument();

    act(() => {
      stateChange({
        kind: "ssh",
        status: "disconnected",
        connectionId: "20000000-0000-4000-8000-000000000001",
        error: {
          code: "ssh_tunnel_lost",
          message: "The managed SSH connection closed unexpectedly.",
        },
      });
    });
    expect(
      await screen.findByRole("heading", { name: "Choose a Sedes connection" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The managed SSH connection closed unexpectedly.",
    );
    await waitFor(() =>
      expect(FakeEventSource.instances.every(({ closed }) => closed)).toBe(
        true,
      ),
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Connect" })[0]).toBeEnabled();
  });

  it("clears candidate progress when its exact native resource is lost", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("ssh"),
    });
    connectionRuntimeNative.connectSsh.mockResolvedValue({
      connectionId: "20000000-0000-4000-8000-000000000021",
      baseUrl: "http://127.0.0.1:49152",
    });
    let stateChange!: (state: unknown) => void;
    connectionRuntimeNative.addListener.mockImplementation(
      async (_event: string, listener: (state: unknown) => void) => {
        stateChange = listener;
        return { remove: vi.fn() };
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(<App />);
    await screen.findByRole("button", { name: "Cancel" });

    act(() => {
      stateChange({
        kind: "ssh",
        connectionId: "20000000-0000-4000-8000-000000000021",
        status: "disconnected",
        error: { code: "ssh_tunnel_lost", message: "Candidate closed." },
      });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Candidate closed.",
    );
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Connect" })[0]).toBeEnabled();
  });

  it("cancels an in-flight SSH auto-connect without installing stale results", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("ssh"),
    });
    let resolveTunnel!: (value: unknown) => void;
    connectionRuntimeNative.connectSsh.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTunnel = resolve;
        }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(connectionRuntimeNative.disconnect).toHaveBeenCalled(),
    );
    resolveTunnel({
      connectionId: "20000000-0000-4000-8000-000000000001",
      baseUrl: "http://127.0.0.1:49152",
    });
    await act(async () => Promise.resolve());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(preferences.set).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Choose a Sedes connection" }),
    ).toBeInTheDocument();
  });

  it("restores the last selection when cancellation lands during its write", async () => {
    platform.native = true;
    platform.name = "electron";
    let storedPreference = electronPreferencesDocument(null);
    preferences.get.mockImplementation(async () => ({
      value: storedPreference,
    }));
    let releaseSelectionWrite!: () => void;
    preferences.set.mockImplementationOnce(
      ({ value }: { readonly value: string }) => {
        storedPreference = value;
        return new Promise<void>((resolve) => {
          releaseSelectionWrite = resolve;
        });
      },
    );
    preferences.set.mockImplementation(
      async ({ value }: { readonly value: string }) => {
        storedPreference = value;
      },
    );
    connectionRuntimeNative.connectSsh.mockResolvedValue({
      connectionId: "20000000-0000-4000-8000-000000000001",
      baseUrl: "http://127.0.0.1:49152",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationBootstrap)),
    );

    render(<App />);
    const remoteProfile = (
      await screen.findByRole("heading", { name: "Remote SSH" })
    ).closest("li")!;
    fireEvent.click(
      within(remoteProfile).getByRole("button", { name: "Connect" }),
    );
    await waitFor(() => expect(preferences.set).toHaveBeenCalledOnce());
    expect(JSON.parse(storedPreference)).toMatchObject({
      selectedProfileId: "10000000-0000-4000-8000-000000000011",
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    releaseSelectionWrite();

    await waitFor(() => expect(preferences.set).toHaveBeenCalledTimes(2));
    expect(JSON.parse(storedPreference)).toMatchObject({
      selectedProfileId: null,
    });
    expect(
      screen.getByRole("heading", { name: "Choose a Sedes connection" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "What should the agent work on?" }),
    ).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(connectionRuntimeNative.disconnect).toHaveBeenCalled();
  });

  it("keeps a newly saved failed profile unselected and exits its editor", async () => {
    platform.native = true;
    platform.name = "electron";
    let storedPreference: string | null = null;
    preferences.get.mockImplementation(async () => ({
      value: storedPreference,
    }));
    preferences.set.mockImplementation(
      async ({ value }: { readonly value: string }) => {
        storedPreference = value;
      },
    );
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "10000000-0000-4000-8000-000000000012",
    );
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "runtime_unavailable",
            message: "New server is unavailable.",
            retryable: true,
          },
        },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "Choose a Sedes connection" });
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    await screen.findByRole("heading", { name: "Connect to Sedes" });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "New server" },
    });
    fireEvent.change(screen.getByLabelText("Sedes server URL"), {
      target: { value: "http://new.example:4784" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));

    expect(
      await screen.findByRole("heading", { name: "New server" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "New server is unavailable.",
    );
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(JSON.parse(storedPreference!)).toMatchObject({
      profiles: [
        {
          name: "New server",
          kind: "direct",
          baseUrl: "http://new.example:4784",
        },
      ],
      selectedProfileId: null,
    });

    cleanup();
    await Promise.resolve();
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Choose a Sedes connection" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("locks the chooser until a failed SSH runtime is unmounted and disconnected", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("ssh"),
    });
    connectionRuntimeNative.connectSsh.mockResolvedValue({
      connectionId: "20000000-0000-4000-8000-000000000001",
      baseUrl: "http://127.0.0.1:49152",
    });
    let resolveDisconnect!: () => void;
    connectionRuntimeNative.disconnect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDisconnect = resolve;
        }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(applicationBootstrap))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "temporarily_unavailable",
              message: "Temporary bootstrap failure.",
              retryable: true,
            },
          },
          { status: 503 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Couldn’t open Sedes" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose another connection" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Choose a Sedes connection" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading saved connections…",
    );
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    await waitFor(() =>
      expect(connectionRuntimeNative.disconnect).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(FakeEventSource.instances.every(({ closed }) => closed)).toBe(
        true,
      ),
    );
    resolveDisconnect();
    expect(
      await screen.findAllByRole("button", { name: "Connect" }),
    ).toHaveLength(3);
  });

  it("re-establishes Android streams from their replay cursor without refetching inventory", async () => {
    platform.native = true;
    platform.name = "android";
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    preferences.get.mockResolvedValue({
      value: androidPreferencesDocument(),
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      Response.json(applicationBootstrap),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.20:4783/api/application/session",
      expect.objectContaining({ credentials: "omit" }),
    );
    const appStateCall = capacitorApp.addListener.mock.calls.find(
      ([event]) => event === "appStateChange",
    );
    expect(appStateCall).toBeDefined();
    const inventoryFetchCount = () =>
      fetchMock.mock.calls.filter(
        ([url]) => !String(url).endsWith("/api/application/notifications"),
      ).length;
    const notificationFetchCount = () =>
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/application/notifications"),
      ).length;
    const startupFetchCount = inventoryFetchCount();
    const startupNotificationCount = notificationFetchCount();
    FakeEventSource.instances.forEach((source) => {
      source.readyState = 1;
    });
    const streamCount = FakeEventSource.instances.length;
    const suspendedStreams = [...FakeEventSource.instances];
    appStateCall?.[1]({ isActive: false });
    expect(suspendedStreams.every(({ closed }) => closed)).toBe(true);
    visibility = "hidden";
    appStateCall?.[1]({ isActive: true });
    expect(FakeEventSource.instances).toHaveLength(streamCount);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(streamCount),
    );
    await waitFor(() =>
      expect(inventoryFetchCount()).toBe(startupFetchCount + 1),
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/api/application/session"),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/api/application/snapshot"),
      ),
    ).toBe(false);
    expect(
      FakeEventSource.instances.some(
        ({ url }) =>
          url ===
          `http://192.168.1.20:4783/api/application/events?replayCursor=${encodeURIComponent(applicationEventId)}`,
      ),
    ).toBe(true);
    await waitFor(() =>
      expect(notificationFetchCount()).toBe(startupNotificationCount + 1),
    );
  });

  it("replaces an errored runtime when the saved connection is retried", async () => {
    platform.native = true;
    platform.name = "android";
    preferences.get.mockResolvedValue({
      value: androidPreferencesDocument(),
    });
    preferences.set.mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "temporarily_unavailable",
              message: "Temporary bootstrap failure.",
              retryable: true,
            },
          },
          { status: 503 },
        ),
      )
      .mockImplementation(async () => Response.json(applicationBootstrap));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Couldn’t open Sedes" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect to Home" }));

    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/application/session"),
      ),
    ).toHaveLength(2);
  });

  it("opens packaged server settings from the mobile drawer", async () => {
    platform.native = true;
    platform.name = "android";
    preferences.get.mockResolvedValue({
      value: androidPreferencesDocument(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationBootstrap)),
    );

    stubMediaQueries(true);
    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    const navigationTrigger = screen.getByRole("button", {
      name: "Open thread navigation",
    });
    expect(navigationTrigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(navigationTrigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(navigationTrigger);
    const drawer = await screen.findByRole("dialog", {
      name: "Thread navigation",
    });
    expect(navigationTrigger).toHaveAttribute("aria-expanded", "true");
    expect(navigationTrigger).toHaveAttribute("aria-controls", drawer.id);
    const inventory = within(drawer).getByRole("navigation", {
      name: "Threads and automations",
    });
    inventory.scrollTop = 420;
    fireEvent.scroll(inventory);
    expect(
      within(drawer).queryByRole("button", { name: "Close thread navigation" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Close thread navigation" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(navigationTrigger);

    fireEvent.click(navigationTrigger);
    const reopenedDrawer = await screen.findByRole("dialog", {
      name: "Thread navigation",
    });
    expect(within(reopenedDrawer).getByRole("navigation", {
      name: "Threads and automations",
    }).scrollTop).toBe(420);
    fireEvent.click(within(reopenedDrawer).getByTestId("settings-trigger"));

    const settingsView = await screen.findByTestId("settings-view");
    expect(window.location.pathname).toBe("/settings");
    expect(screen.queryByRole("dialog", { name: "Thread navigation" })).toBeNull();
    fireEvent.change(within(settingsView).getByLabelText("Settings category"), {
      target: { value: "server" },
    });
    expect(window.location.pathname).toBe("/settings/server");

    expect(
      await screen.findByRole("heading", { name: "Server" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect to Home" })).toBeInTheDocument();
    expect(screen.getByText("http://192.168.1.20:4783")).toBeInTheDocument();
    expect(screen.getByLabelText("Sedes server URL")).toHaveValue("");
    expect(screen.getByLabelText("Connection name")).toHaveValue("");
  });

  it("collapses and restores the desktop sidebar from the nav trigger", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationBootstrap)),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    expect(document.documentElement.dataset.sidebarCollapsed).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(document.documentElement.dataset.sidebarCollapsed).toBe("true");
    expect(window.localStorage.getItem("sedes-sidebar-collapsed")).toBe("true");
    expect(document.querySelector(".application-shell")).toHaveAttribute(
      "data-sidebar-collapsed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(document.documentElement.dataset.sidebarCollapsed).toBe("false");
    expect(window.localStorage.getItem("sedes-sidebar-collapsed")).toBe(
      "false",
    );
    expect(document.querySelector(".application-shell")).not.toHaveAttribute(
      "data-sidebar-collapsed",
    );
  });

  it("keeps the application shell mounted while repairing stale sidebar scope", async () => {
    FakeEventSource.automaticApplicationSnapshots = 1;
    setSidebarInventoryScope({
      projectFilterName: "Missing project",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationSession)),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "What should the agent work on?",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(getSidebarViewPreferences().projectFilterName).toBeNull(),
    );
    expect(document.querySelector(".application-shell")).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("unwinds sidebar search and filters before returning to the thread", async () => {
    platform.native = true;
    platform.name = "android";
    preferences.get.mockResolvedValue({
      value: androidPreferencesDocument(),
    });
    FakeEventSource.applicationSnapshot = {
      ...applicationSnapshot,
      workspaces: [
        {
          id: "workspace-1",
          environmentId: "10000000-0000-4000-8000-000000000002",
          label: { text: "Back test workspace" },
          displayPath: { text: "/back-test" },
          available: true,
        },
      ],
      threads: [
        {
          id: "thread-1",
          workspaceId: "workspace-1",
          targetId: "target-1",
          title: { text: "Back test thread" },
          backend: { label: { text: "Pi" }, brand: "pi" },
          backingState: "bound",
          inventoryState: "active",
          inventoryRevision: 1,
          preferredWorktreeRevision: 0,
          preferredWorktree: null,
          pinned: false,
          pinRevision: 0,
          bookmarkRevision: 0,
          turnBookmarkCount: 0,
          groupId: null,
          groupAssignmentRevision: 0,
          threadRevision: 1,
          runState: "idle",
          queuedInputCount: 0,
          stashedPromptCount: 0,
          pendingQuestionCount: 0,
          terminalSummary: { runningCount: 0, retainedCount: 0 },
          available: true,
          lastActivityAt: "2026-08-04T12:00:00.000Z",
          stateChangedAt: "2026-08-04T12:00:00.000Z",
          automation: null,
          attention: {
            wake: false,
            automationContext: null,
            unseenCompletion: false,
            queueFailure: false,
          },
        },
      ],
      executionTargets: [
        {
          id: "target-1",
          environmentId: "10000000-0000-4000-8000-000000000002",
          label: { text: "Local SDK" },
          backend: { label: { text: "Pi" }, brand: "pi" },
          workspaceExecution: { kind: "direct_only" },
          available: true,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationSession)),
    );

    render(<App />);
    await screen.findByTestId("desktop-sidebar");
    act(() => navigate("/threads/thread-1"));

    // The effect re-registers per route; take the latest registration so the
    // closure reflects the thread route.
    const backButton = capacitorApp.addListener.mock.calls
      .filter(([event]) => event === "backButton")
      .at(-1);
    expect(backButton).toBeDefined();

    // No overlay open: back opens the navigation drawer.
    act(() => backButton![1]({ canGoBack: false }));
    const drawer = await screen.findByRole("dialog", {
      name: "Thread navigation",
    });
    expect(drawer).toBeVisible();

    const search = within(drawer).getByPlaceholderText("Search threads");
    fireEvent.change(search, { target: { value: "Back test" } });
    expect(search).toHaveValue("Back test");

    // Search is the first sidebar state Back unwinds; the drawer stays open.
    act(() => backButton![1]({ canGoBack: false }));
    expect(search).toHaveValue("");
    expect(drawer).toBeVisible();

    act(() =>
      setSidebarInventoryScope({
        projectFilterName: "Back test workspace",
      }),
    );
    expect(
      await within(drawer).findByRole("button", { name: "Clear" }),
    ).toBeVisible();

    // One press clears the complete filter set without dismissing the drawer.
    act(() => backButton![1]({ canGoBack: false }));
    await waitFor(() =>
      expect(
        within(drawer).queryByRole("button", { name: "Clear" }),
      ).not.toBeInTheDocument(),
    );
    expect(drawer).toBeVisible();

    // With no sidebar state left, Back restores the original thread behavior.
    act(() => backButton![1]({ canGoBack: false }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Thread navigation" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("opens the Android drawer on the home route with no history", async () => {
    platform.native = true;
    platform.name = "android";
    preferences.get.mockResolvedValue({
      value: androidPreferencesDocument(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(applicationBootstrap)),
    );

    render(<App />);
    await screen.findByRole("heading", {
      name: "What should the agent work on?",
    });

    const backButton = capacitorApp.addListener.mock.calls.find(
      ([event]) => event === "backButton",
    );
    act(() => backButton![1]({ canGoBack: false }));
    const drawer = await screen.findByRole("dialog", {
      name: "Thread navigation",
    });
    expect(drawer).toBeVisible();

    act(() => backButton![1]({ canGoBack: false }));
    expect(drawer).toBeVisible();
  });

  it("uses packaged lifecycle without installing Android Back on Electron", async () => {
    platform.native = true;
    platform.name = "electron";
    preferences.get.mockResolvedValue({
      value: electronPreferencesDocument("direct"),
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      Response.json(applicationBootstrap),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", {
      name: "What should the agent work on?",
    });

    expect(
      capacitorApp.addListener.mock.calls.some(
        ([event]) => event === "appStateChange",
      ),
    ).toBe(false);
    expect(
      capacitorApp.addListener.mock.calls.some(
        ([event]) => event === "backButton",
      ),
    ).toBe(false);

    FakeEventSource.instances.forEach((source) => {
      source.readyState = 1;
    });
    const initialSources = [...FakeEventSource.instances];
    const inventoryFetchCount = () =>
      fetchMock.mock.calls.filter(
        ([url]) => !String(url).endsWith("/api/application/notifications"),
      ).length;
    const notificationFetchCount = () =>
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/application/notifications"),
      ).length;
    const startupFetchCount = inventoryFetchCount();
    const startupNotificationCount = notificationFetchCount();
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => undefined);

    expect(initialSources.every(({ closed }) => !closed)).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(initialSources.length);
    expect(inventoryFetchCount()).toBe(startupFetchCount);
    await waitFor(() =>
      expect(notificationFetchCount()).toBe(startupNotificationCount + 1),
    );
  });
});
