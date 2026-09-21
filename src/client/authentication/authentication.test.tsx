// @vitest-environment jsdom
import { useContext, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationGate, NavigationScopeContext, readPairingToken } from "./AuthenticationGate.js";
import { authenticatedFetch, getEndpointCredential, notifyUnauthorized, setEndpointCredential } from "./auth-transport.js";
import { configuredSedesServer, sameOriginSedesServer } from "../app/server-endpoint.js";
const native = vi.hoisted(() => ({ enabled: false, get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
vi.mock("../app/client-platform.js", () => ({ isPackagedClient: () => native.enabled }));
vi.mock("../app/client-credentials.js", () => ({ getCredential: native.get, setCredential: native.set, removeCredential: native.remove }));
afterEach(() => { cleanup(); native.enabled = false; vi.clearAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });
describe("connection authentication", () => {
  it("remounts in-memory application drafts when an admitted navigation namespace changes", async () => {
    native.enabled = true;
    let finishCredentials!: (credential: string) => void;
    native.get.mockReturnValue(new Promise<string>((resolve) => { finishCredentials = resolve; }));
    const endpoint = configuredSedesServer("https://scope-reset.example");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ required: false, authenticated: false, navigationNamespace: "a".repeat(64) }))
      .mockResolvedValueOnce(Response.json({ required: false, authenticated: false, navigationNamespace: "b".repeat(64) }));
    vi.stubGlobal("fetch", fetchMock);
    function Draft() { return <><output data-testid="scope">{useContext(NavigationScopeContext)}</output><input aria-label="Local draft" defaultValue="" /></>; }
    render(<AuthenticationGate endpoint={endpoint} profileId="profile"><Draft /></AuthenticationGate>);
    const oldInput = await screen.findByLabelText("Local draft");
    fireEvent.change(oldInput, { target: { value: "Prior principal draft" } });
    await act(async () => { finishCredentials("c".repeat(43)); });
    await waitFor(() => expect(screen.getByTestId("scope").textContent).toContain("b".repeat(64)));
    expect(screen.getByLabelText("Local draft")).not.toBe(oldInput);
    expect(screen.getByLabelText("Local draft")).toHaveValue("");
  });

  it("provides server-origin and admitted-principal storage scope after status and pairing", async () => {
    const namespace = "a".repeat(64);
    const endpoint = configuredSedesServer("https://scope.example");
    function ScopedChild() { return <output data-testid="navigation-scope">{useContext(NavigationScopeContext) ?? "disabled"}</output>; }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ required: false, authenticated: false, navigationNamespace: namespace })));
    const view = render(<AuthenticationGate endpoint={endpoint}><ScopedChild /></AuthenticationGate>);
    expect((await screen.findByTestId("navigation-scope")).textContent).toBe(JSON.stringify(["https://scope.example", namespace]));
    view.unmount();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/status") ? { required: true, authenticated: false } : {
      client: { id: "10000000-0000-4000-8000-000000000001", name: "Browser", kind: "management", createdAt: "2026-09-13T00:00:00Z", expiresAt: "2027-09-13T00:00:00Z" }, navigationNamespace: namespace,
    })));
    render(<AuthenticationGate endpoint={endpoint}><ScopedChild /></AuthenticationGate>);
    fireEvent.change(await screen.findByLabelText("Pairing URL or code"), { target: { value: "BCDF-GHJK" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair connection" }));
    expect((await screen.findByTestId("navigation-scope")).textContent).toBe(JSON.stringify(["https://scope.example", namespace]));
    act(() => notifyUnauthorized(endpoint));
    await waitFor(() => expect(screen.queryByTestId("navigation-scope")).toBeNull());
  });

  it("sends credentials only to their bound endpoint and rejects redirects", async () => {
    const a = configuredSedesServer("https://a.example");
    const b = configuredSedesServer("https://b.example");
    setEndpointCredential(a, "secret");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetchMock);
    await authenticatedFetch(a, "/api/auth/status");
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("Authorization")).toBe("Bearer secret");
    expect(fetchMock.mock.calls[0]![1].redirect).toBe("error");
    await authenticatedFetch(b, "/api/auth/status");
    expect(new Headers(fetchMock.mock.calls[1]![1].headers).has("Authorization")).toBe(false);
    setEndpointCredential(a, null);
  });
  it("does not let a stale unauthorized response erase a replacement credential", async () => {
    const endpoint = configuredSedesServer("https://a.example");
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((done) => { resolve = done; })));
    setEndpointCredential(endpoint, "old"); const pending = authenticatedFetch(endpoint, "/api/auth/status");
    setEndpointCredential(endpoint, "new"); resolve(new Response("{}", { status: 401 })); await pending;
    expect(getEndpointCredential(endpoint)).toBe("new"); setEndpointCredential(endpoint, null);
  });
  it("loads and stores native credentials per saved profile without browser storage", async () => {
    native.enabled = true; native.get.mockResolvedValue(null); native.set.mockResolvedValue(undefined);
    const endpoint = configuredSedesServer("https://device.example");
    const fetchMock = vi.fn().mockImplementation(async (path: string) => new Response(JSON.stringify(path.endsWith("/status") ? { required: true, authenticated: false } : { client: { id: "10000000-0000-4000-8000-000000000001", name: "Device", kind: "management", createdAt: "2026-09-13T00:00:00Z", expiresAt: "2027-09-13T00:00:00Z" }, credential: "d".repeat(43) })));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthenticationGate endpoint={endpoint} profileId="profile-id"><div>Private application</div></AuthenticationGate>);
    const input = await screen.findByLabelText("Pairing URL or code");
    fireEvent.change(input, { target: { value: " bcdfghjk " } });
    fireEvent.click(screen.getByRole("button", { name: "Pair connection" }));
    await screen.findByText("Private application");
    expect(native.get).toHaveBeenCalledWith("profile-id", "https://device.example");
    expect(native.set).toHaveBeenCalledWith("profile-id", "https://device.example", "d".repeat(43));
    expect(getEndpointCredential(endpoint)).toBe("d".repeat(43));
  });
  it("rejects pairing links for another server", () => {
    expect(readPairingToken("https://a.example/#pair=bcdfghjk", "https://a.example")).toBe("BCDF-GHJK");
    expect(() => readPairingToken("https://b.example/#pair=bcdfghjk", "https://a.example")).toThrow("different server");
  });
  it.each(["bcdfghjk", "bcdf-ghjk", "  BCDF-GHJK  "])("normalizes manually entered codes: %s", (input) => {
    expect(readPairingToken(input, "https://a.example")).toBe("BCDF-GHJK");
  });
  it.each(["ABCD-EFGH", "1234-5678", "BCDF-GHJK-L", "p".repeat(43)])("rejects invalid manual enrollment codes: %s", (input) => {
    expect(() => readPairingToken(input, "https://a.example")).toThrow("eight-letter");
  });
  it("removes URL secrets, gates application data, pairs and tears down on revocation", async () => {
    window.history.replaceState({}, "", "/#pair=BCDF-GHJK");
    const fetchMock = vi.fn().mockImplementation(async (path: string) => new Response(JSON.stringify(path === "/api/auth/status" ? { required: true, authenticated: false } : { client: { id: "10000000-0000-4000-8000-000000000001", name: "Browser", kind: "management", createdAt: "2026-09-13T00:00:00Z", expiresAt: "2027-09-13T00:00:00Z" } })));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthenticationGate endpoint={sameOriginSedesServer}><div>Private application</div></AuthenticationGate>);
    expect(window.location.hash).toBe("");
    expect(screen.queryByText("Private application")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Pair connection" }));
    expect(await screen.findByText("Private application")).toBeTruthy();
    expect(fetchMock.mock.calls.find(([path]) => path === "/api/auth/pair")![1].body).toContain('"token":"BCDF-GHJK"');
    notifyUnauthorized(sameOriginSedesServer);
    await waitFor(() => expect(screen.queryByText("Private application")).toBeNull());
  });
});

describe("pairing URL connection setup", () => {
  it("keeps enrollment codes out of saved profile URLs and consumes once", async () => {
    const { serverFromPairingInput, consumePairingToken } = await import("./pairing-link.js");
    expect(serverFromPairingInput("https://sedes.example/#pair=secret")).toBe("https://sedes.example");
    expect(consumePairingToken("https://other.example")).toBe("");
    expect(consumePairingToken("https://sedes.example")).toBe("secret");
    expect(consumePairingToken("https://sedes.example")).toBe("");
  });
});

describe("authentication lifecycle fencing", () => {
  const client = { id: "10000000-0000-4000-8000-000000000001", name: "Device", kind: "management", createdAt: "2026-09-13T00:00:00Z", expiresAt: "2027-09-13T00:00:00Z" };
  it("discards delayed enrollment when another profile selects the same origin", async () => {
    native.enabled = true;
    native.get.mockImplementation(async (profileId: string) => profileId === "new-profile" ? "n".repeat(43) : null);
    const endpoint = configuredSedesServer("https://device.example");
    let finishPair!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (path: string, init: RequestInit) => {
      if (path.endsWith("/pair")) return new Promise<Response>((resolve) => { finishPair = resolve; });
      const authenticated = new Headers(init.headers).has("Authorization");
      return Response.json({ required: true, authenticated, ...(authenticated ? { client } : {}) });
    }));
    const view = render(<AuthenticationGate key="old" endpoint={endpoint} profileId="old-profile"><div>Old private data</div></AuthenticationGate>);
    fireEvent.change(await screen.findByLabelText("Pairing URL or code"), { target: { value: "BCDF-GHJK" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair connection" }));
    await waitFor(() => expect(finishPair).toBeDefined());
    view.rerender(<AuthenticationGate key="new" endpoint={endpoint} profileId="new-profile"><div>New private data</div></AuthenticationGate>);
    await screen.findByText("New private data");
    finishPair(Response.json({ client, credential: "o".repeat(43) }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(native.set).not.toHaveBeenCalled();
    expect(getEndpointCredential(endpoint)).toBe("n".repeat(43));
    expect(screen.queryByText("Old private data")).toBeNull();
  });
  it("disables retry while a one-use pairing request is pending", async () => {
    native.enabled = true; native.get.mockResolvedValue(null); native.set.mockResolvedValue(undefined);
    const endpoint = configuredSedesServer("https://device.example");
    let finishPair!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith("/pair")) return new Promise<Response>((resolve) => { finishPair = resolve; });
      return Response.json({ required: true, authenticated: false });
    }));
    render(<AuthenticationGate endpoint={endpoint} profileId="profile"><div>Private data</div></AuthenticationGate>);
    fireEvent.change(await screen.findByLabelText("Pairing URL or code"), { target: { value: "BCDF-GHJK" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair connection" }));
    await waitFor(() => expect(finishPair).toBeDefined());
    const retry = screen.getByRole("button", { name: "Retry connection" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    finishPair(Response.json({ client, credential: "n".repeat(43) }));
    await screen.findByText("Private data");
    expect(native.set).toHaveBeenCalledWith("profile", "https://device.example", "n".repeat(43));
  });
  it("keeps a newer profile credential when an old logout finishes", async () => {
    const { AuthenticationSettings } = await import("./AuthenticationSettings.js");
    native.enabled = true; native.get.mockImplementation(async (profileId: string) => profileId === "new-profile" ? "n".repeat(43) : "o".repeat(43));
    const endpoint = configuredSedesServer("https://device.example");
    let finishLogout!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith("/logout")) return new Promise<Response>((resolve) => { finishLogout = resolve; });
      if (path.endsWith("/clients")) return Response.json({ clients: [client] });
      return Response.json({ required: true, authenticated: true, client });
    }));
    const view = render(<AuthenticationGate key="old" endpoint={endpoint} profileId="old-profile"><AuthenticationSettings /></AuthenticationGate>);
    fireEvent.click(await screen.findByRole("button", { name: "Unpair" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm unpair" }));
    await waitFor(() => expect(finishLogout).toBeDefined());
    view.rerender(<AuthenticationGate key="new" endpoint={endpoint} profileId="new-profile"><div>New private data</div></AuthenticationGate>);
    await screen.findByText("New private data");
    finishLogout(Response.json({ ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(native.remove).not.toHaveBeenCalled();
    expect(getEndpointCredential(endpoint)).toBe("n".repeat(43));
  });
  it("retains the enrollment code through StrictMode effect replay", async () => {
    const { StrictMode } = await import("react");
    window.history.replaceState({}, "", `/#pair=${"BCDF-GHJK"}`);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ required: true, authenticated: false })));
    render(<StrictMode><AuthenticationGate endpoint={sameOriginSedesServer}><div>Private</div></AuthenticationGate></StrictMode>);
    expect(await screen.findByLabelText("Pairing URL or code")).toHaveValue("BCDF-GHJK");
    expect(window.location.hash).toBe("");
  });
});

describe("servers with authentication disabled", () => {
  const endpoint = configuredSedesServer("https://open.example");
  it("keeps an open server visible after an auth-management rejection when status refresh fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ required: false, authenticated: false })).mockRejectedValue(new Error("Temporary network failure"));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthenticationGate endpoint={sameOriginSedesServer}><div>Open server</div></AuthenticationGate>);
    await screen.findByText("Open server");
    await act(async () => { notifyUnauthorized(sameOriginSedesServer); await Promise.resolve(); });
    expect(screen.getByText("Open server")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pair with this server" })).toBeNull();
  });
  it("returns to pairing when a rejected request confirms authentication was re-enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ required: false, authenticated: false })).mockImplementation(async () => Response.json({ required: true, authenticated: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthenticationGate endpoint={sameOriginSedesServer}><div>Open server</div></AuthenticationGate>);
    await screen.findByText("Open server");
    await act(async () => { notifyUnauthorized(sameOriginSedesServer); });
    await screen.findByRole("heading", { name: "Pair with this server" });
    expect(screen.queryByText("Open server")).toBeNull();
  });
  it("opens an anonymous browser without pairing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ required: false, authenticated: false })));
    render(<AuthenticationGate endpoint={sameOriginSedesServer}><div>Open server</div></AuthenticationGate>);
    await screen.findByText("Open server");
    expect(screen.queryByLabelText("Pairing URL or code")).toBeNull();
  });
  it("opens native clients while credential storage is unavailable without removing saved credentials", async () => {
    native.enabled = true; native.get.mockRejectedValue(new Error("Vault locked"));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ required: false, authenticated: false })));
    render(<AuthenticationGate endpoint={endpoint} profileId="profile"><div>Open server</div></AuthenticationGate>);
    await screen.findByText("Open server");
    await waitFor(() => expect(native.get).toHaveBeenCalled());
    expect(native.remove).not.toHaveBeenCalled(); expect(native.set).not.toHaveBeenCalled();
  });
  it("does not wait for credential storage before opening an unauthenticated server", async () => {
    native.enabled = true; native.get.mockReturnValue(new Promise(() => undefined));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ required: false, authenticated: false })));
    render(<AuthenticationGate endpoint={endpoint} profileId="profile"><div>Open server</div></AuthenticationGate>);
    await screen.findByText("Open server");
  });
  it("retains even an invalid saved credential while anonymous access is allowed", async () => {
    native.enabled = true; native.get.mockResolvedValue("s".repeat(43));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ required: false, authenticated: false })));
    render(<AuthenticationGate endpoint={endpoint} profileId="profile"><div>Open server</div></AuthenticationGate>);
    await screen.findByText("Open server");
    await waitFor(() => expect(getEndpointCredential(endpoint)).toBe("s".repeat(43)));
    expect(native.remove).not.toHaveBeenCalled(); expect(native.set).not.toHaveBeenCalled();
  });
  it("rebuilds application stores when a saved credential becomes available after anonymous startup", async () => {
    native.enabled = true;
    let finishRead!: (credential: string) => void;
    native.get.mockReturnValue(new Promise<string>((resolve) => { finishRead = resolve; }));
    const client = { id: "10000000-0000-4000-8000-000000000001", name: "Device", kind: "management", createdAt: "2026-09-13T00:00:00Z", expiresAt: "2027-09-13T00:00:00Z" };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_path: string, init: RequestInit) => {
      const authenticated = new Headers(init.headers).has("Authorization");
      return Response.json({ required: false, authenticated, ...(authenticated ? { client } : {}) });
    }));
    const started = vi.fn(); const stopped = vi.fn();
    function Application(): React.JSX.Element { useEffect(() => { started(); return stopped; }, []); return <div>Open server</div>; }
    render(<AuthenticationGate endpoint={endpoint} profileId="profile"><Application /></AuthenticationGate>);
    await screen.findByText("Open server"); expect(started).toHaveBeenCalledTimes(1);
    finishRead("s".repeat(43));
    await waitFor(() => expect(started).toHaveBeenCalledTimes(2));
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(getEndpointCredential(endpoint)).toBe("s".repeat(43));
    expect(native.remove).not.toHaveBeenCalled();
  });
  it("uses the retained credential when optional enrollment is rejected", async () => {
    native.enabled = true;
    let finishRead!: (credential: string) => void;
    native.get.mockReturnValue(new Promise<string>((resolve) => { finishRead = resolve; }));
    window.history.replaceState({}, "", `/#pair=${"BCDF-GHJK"}`);
    const client = { id: "10000000-0000-4000-8000-000000000001", name: "Retained device", kind: "management", createdAt: "2026-09-13T00:00:00Z", expiresAt: "2027-09-13T00:00:00Z" };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (path: string, init: RequestInit) => {
      if (path.endsWith("/pair")) return Response.json({ error: "pairing_invalid" }, { status: 401 });
      const authenticated = new Headers(init.headers).has("Authorization");
      return Response.json({ required: false, authenticated, ...(authenticated ? { client } : {}) });
    }));
    render(<AuthenticationGate endpoint={endpoint} profileId="profile"><div>Open server</div></AuthenticationGate>);
    fireEvent.click(await screen.findByRole("button", { name: "Pair connection" }));
    await screen.findByRole("alert");
    await act(async () => { finishRead("s".repeat(43)); });
    await screen.findByText("Open server");
    expect(getEndpointCredential(endpoint)).toBe("s".repeat(43));
    expect(native.set).not.toHaveBeenCalled();
    expect(native.remove).not.toHaveBeenCalled();
  });
  it("does not let a delayed vault read replace a new optional pairing", async () => {
    native.enabled = true;
    let finishRead!: (credential: string) => void;
    native.get.mockReturnValue(new Promise<string>((resolve) => { finishRead = resolve; }));
    native.set.mockResolvedValue(undefined);
    window.history.replaceState({}, "", `/#pair=${"BCDF-GHJK"}`);
    const client = { id: "10000000-0000-4000-8000-000000000001", name: "Device", kind: "management", createdAt: "2026-09-13T00:00:00Z", expiresAt: "2027-09-13T00:00:00Z" };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (path: string) => Response.json(path.endsWith("/pair") ? { client, credential: "n".repeat(43) } : { required: false, authenticated: false })));
    render(<AuthenticationGate endpoint={endpoint} profileId="profile"><div>Open server</div></AuthenticationGate>);
    fireEvent.click(await screen.findByRole("button", { name: "Pair connection" }));
    await screen.findByText("Open server");
    await act(async () => { finishRead("o".repeat(43)); });
    expect(getEndpointCredential(endpoint)).toBe("n".repeat(43));
  });
  it("allows skipping an explicit pairing link when pairing is optional", async () => {
    window.history.replaceState({}, "", `/#pair=${"BCDF-GHJK"}`);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ required: false, authenticated: false })));
    render(<AuthenticationGate endpoint={sameOriginSedesServer}><div>Open server</div></AuthenticationGate>);
    fireEvent.click(await screen.findByRole("button", { name: "Continue without pairing" }));
    await screen.findByText("Open server"); expect(window.location.hash).toBe("");
  });
});
