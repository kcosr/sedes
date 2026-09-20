// @vitest-environment jsdom

import type { ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ConfigurationSnapshot } from "../../shared/protocol/configuration-admin.js";
import { getAppearance } from "../app/appearance.js";
import {
  getEnvironmentColorsEnabled,
  getEnvironmentPalette,
  getEnvironmentTintSettings,
} from "../app/environment-palette.js";
import { ApiClient, ApiError } from "../api/ApiClient.js";
import {
  getActivityDetail,
  getChatAtmosphereEnabled,
  getDiagnosticCategoryEnabled,
  getHistoryPageSize,
  getMobileComposerRefocusAfterSend,
  getMobileHistorySeekControl,
  getPanelPresentation,
  getRightOptionFocusesComposer,
  getSeekOnSubmit,
  getSmoothStreamingEnabled,
  getTerminalPreferences,
  getConfirmTerminalTermination,
  setDiagnosticCategoryEnabled,
} from "../app/settings.js";
import { clearDiagnostics, recordSeekDiagnostic } from "../app/diagnostics.js";
import { SEDES_VERSION } from "../../shared/version.js";
import { SettingsView } from "./SettingsView.js";
import { navigate, settingsPath, useRoute } from "../app/router.js";
import { CannedPromptClientStore } from "../stores/CannedPromptClientStore.js";
import type { ApplicationClientState, ApplicationClientStore } from "../stores/ApplicationClientStore.js";

function RoutedSettings(props: Omit<ComponentProps<typeof SettingsView>, "page">) {
  const route = useRoute();
  if (route.name !== "settings") return <p>Workspace</p>;
  return <SettingsView {...props} page={route.page} />;
}

function renderSettings({ page = "general", ...props }: Partial<ComponentProps<typeof SettingsView>> = {}) {
  navigate(settingsPath(page), { replace: true });
  return render(<RoutedSettings onReturn={() => navigate("/")} {...props} />);
}

function executionControls() {
  const snapshot: ConfigurationSnapshot = {
    revision: 0, runtimes: [], configuration: {
      executionEnvironments: [{ id: "10000000-0000-4000-8000-000000000001", kind: "local", label: "Local", workspaceRoots: ["/work"], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }],
      backends: [], targets: [], defaultTargetId: null, webSearch: null,
    },
  };
  const controls = {
    outboundConnectorSetup: () => ({ serverUrl: "http://sedes.test", downloadUrl: "http://sedes.test/connector" }),
    listHostRegistrations: vi.fn(async () => ({ registrations: [], pairings: [] })),
    acceptHostRegistration: vi.fn(), denyHostRegistration: vi.fn(), revokeHostPairing: vi.fn(), reapproveHostPairing: vi.fn(),
    readConfiguration: vi.fn(async () => structuredClone(snapshot)),
    saveConfiguration: vi.fn(async (): Promise<ConfigurationSnapshot> => structuredClone(snapshot)),
    configurationLifecycleImpact: vi.fn(), configurationLifecycle: vi.fn(), getLifecycleReceipt: vi.fn(),
    listConfigurationOperations: vi.fn(), inspectConfigurationOperation: vi.fn(), acknowledgeConfigurationOperation: vi.fn(),
  };
  return { controls, snapshot };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  clearDiagnostics();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-environment-palette");
  document.documentElement.removeAttribute("data-environment-tint-intensity");
  document.documentElement.removeAttribute("data-environment-tint-fade-in");
  document.documentElement.removeAttribute("data-environment-tint-coverage");
  document.documentElement.style.removeProperty(
    "--environment-row-start-opacity",
  );
  document.documentElement.style.removeProperty(
    "--environment-row-tail-opacity",
  );
  document.documentElement.style.removeProperty(
    "--environment-sidebar-start-opacity",
  );
  document.documentElement.style.removeProperty(
    "--environment-sidebar-tail-opacity",
  );
  document.documentElement.style.removeProperty(
    "--environment-gradient-head-stop",
  );
  document.documentElement.style.removeProperty("--environment-row-tail-stop");
  document.documentElement.style.removeProperty("--environment-row-clear-stop");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SettingsView", () => {
  it("routes Projects as its own page without embedding it in environment settings", async () => {
    const { controls } = executionControls();
    const listProjects = vi.fn(async () => ({ projects: [] }));
    const state = { snapshot: { environments: [], workspaces: [], threads: [] } } as unknown as ApplicationClientState;
    const applicationStore = { api: { listProjects }, getSnapshot: () => state, subscribe: () => () => {} } as unknown as ApplicationClientStore;
    renderSettings({ configuration: controls, applicationStore, page: "projects" });

    expect(await screen.findByText("No projects yet. Add a directory to start a thread.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Projects" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Projects" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("combobox", { name: "Settings category" })).toHaveValue("projects");

    fireEvent.click(screen.getByRole("button", { name: "Environments" }));
    fireEvent.click(await screen.findByRole("button", { name: "Local details" }));
    const sections = screen.getByRole("navigation", { name: "Environment sections" });
    expect(within(sections).queryByRole("button", { name: "Projects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Projects" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(window.location.pathname).toBe("/settings/projects");
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeVisible();
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it("exposes principal execution administration separately from client connection settings", async () => {
    const configuration = {
      outboundConnectorSetup: () => ({ serverUrl: "http://sedes.test:4784", downloadUrl: "http://sedes.test:4784/api/outbound/connector/sedes-sidecar.mjs" }),
    listHostRegistrations: vi.fn(async () => ({ registrations: [], pairings: [] })),
    acceptHostRegistration: vi.fn(), denyHostRegistration: vi.fn(), revokeHostPairing: vi.fn(), reapproveHostPairing: vi.fn(),
    readConfiguration: vi.fn(async () => ({ revision: 0, configuration: { executionEnvironments: [], backends: [], targets: [], defaultTargetId: null, webSearch: null }, runtimes: [] })),
      saveConfiguration: vi.fn(), configurationLifecycleImpact: vi.fn(), configurationLifecycle: vi.fn(), getLifecycleReceipt: vi.fn(),
      listConfigurationOperations: vi.fn(), inspectConfigurationOperation: vi.fn(), acknowledgeConfigurationOperation: vi.fn(),
    };
    renderSettings({ configuration: configuration, page: "backends" });
    expect(screen.getByRole("heading", { name: "Backends" })).toBeVisible();
    expect(await screen.findByText(/Add an execution environment first/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Environments" }));
    expect(await screen.findByRole("heading", { name: "Execution environments" })).toBeVisible();
    expect(screen.queryByLabelText(/principal/i)).toBeNull();
  });

  it("protects execution edits when leaving settings and follows explicit execution page requests", async () => {
    const configuration = {
      outboundConnectorSetup: () => ({ serverUrl: "http://sedes.test", downloadUrl: "http://sedes.test/connector" }),
      listHostRegistrations: vi.fn(async () => ({ registrations: [], pairings: [] })),
      acceptHostRegistration: vi.fn(), denyHostRegistration: vi.fn(), revokeHostPairing: vi.fn(), reapproveHostPairing: vi.fn(),
      readConfiguration: vi.fn(async () => ({ revision: 0, configuration: { executionEnvironments: [], backends: [], targets: [], defaultTargetId: null, webSearch: null }, runtimes: [] })),
      saveConfiguration: vi.fn(), configurationLifecycleImpact: vi.fn(), configurationLifecycle: vi.fn(), getLifecycleReceipt: vi.fn(),
      listConfigurationOperations: vi.fn(), inspectConfigurationOperation: vi.fn(), acknowledgeConfigurationOperation: vi.fn(),
    };
    renderSettings({ configuration, page: "environments" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add environment" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add environment" }));
    fireEvent.click(screen.getByRole("button", { name: /^Local machine/ }));
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Unsaved local" } });
    fireEvent.click(screen.getByTestId("settings-return"));
    expect(screen.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    expect(window.location.pathname).toBe("/settings/environments");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Environment name")).toHaveValue("Unsaved local");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Backends" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("heading", { name: "Backends" })).toHaveFocus();
    act(() => navigate(settingsPath("environments")));
    expect(screen.getByRole("heading", { name: "Execution environments" })).toBeVisible();
  });

  it("keeps a dirty execution draft on browser Back and resumes the original traversal after discard", async () => {
    const { controls } = executionControls();
    navigate("/threads/retained-thread", { replace: true });
    navigate(settingsPath("environments"));
    render(<RoutedSettings configuration={controls} onReturn={() => navigate("/threads/retained-thread")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Local" }));
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Browser draft" } });
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
    await waitFor(() => expect(window.location.pathname).toBe("/settings/environments"));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Environment name")).toHaveValue("Browser draft");
    act(() => window.history.back());
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(window.location.pathname).toBe("/threads/retained-thread"));
    expect(await screen.findByText("Workspace")).toBeVisible();
    act(() => window.history.forward());
    expect(await screen.findByRole("heading", { name: "Execution environments" })).toBeVisible();
    expect(window.location.pathname).toBe("/settings/environments");
  });

  it("normalizes unavailable categories to Settings home", async () => {
    renderSettings({ page: "server" });
    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
    expect(screen.getByTestId("settings-view")).toHaveAttribute("data-page", "home");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Server" })).toBeNull();
  });

  it("loads and polls execution settings only while an execution page is visible", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const { controls } = executionControls();
    renderSettings({ configuration: controls });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(controls.readConfiguration).not.toHaveBeenCalled();
    expect(controls.listHostRegistrations).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Environments" }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Local details" })).toBeVisible();
    const initialReads = controls.readConfiguration.mock.calls.length;
    const initialHostReads = controls.listHostRegistrations.mock.calls.length;
    expect(initialReads).toBeGreaterThan(0);
    expect(initialHostReads).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(controls.readConfiguration.mock.calls.length).toBeGreaterThan(initialReads);
    expect(controls.listHostRegistrations.mock.calls.length).toBeGreaterThan(initialHostReads);
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    const reads = controls.readConfiguration.mock.calls.length;
    const hostReads = controls.listHostRegistrations.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
    expect(controls.readConfiguration).toHaveBeenCalledTimes(reads);
    expect(controls.listHostRegistrations).toHaveBeenCalledTimes(hostReads);
    fireEvent.click(screen.getByRole("button", { name: "Backends" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(controls.readConfiguration.mock.calls.length).toBeGreaterThan(reads);
    expect(controls.listHostRegistrations.mock.calls.length).toBeGreaterThan(hostReads);
  });

  it("keeps checking an original lifecycle receipt after switching to an unrelated settings page", async () => {
    vi.useFakeTimers();
    const { controls, snapshot } = executionControls();
    const mutationId = "20000000-0000-4000-8000-000000000001";
    const runtime = { resourceKind: "environment" as const, resourceId: snapshot.configuration.executionEnvironments[0]!.id,
      desiredRevision: 0, effectiveRevision: 0, applyState: "applied" as const, preference: "automatic" as const,
      connectionState: "connected" as const, incarnation: "local-one", softwareVersion: "1", upgradeState: "current" as const,
      activeResources: 0, lastError: null, supportedActions: [],
    };
    snapshot.runtimes = [{ ...runtime, lifecycleOperation: { mutationId, action: "connect", state: "pending" } }];
    renderSettings({ configuration: controls, page: "environments" });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    controls.getLifecycleReceipt.mockResolvedValue({ mutationId, state: "applied", runtime });
    snapshot.runtimes = [runtime];
    const hostReads = controls.listHostRegistrations.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(controls.getLifecycleReceipt).toHaveBeenCalledOnce();
    expect(controls.getLifecycleReceipt).toHaveBeenCalledWith(mutationId);
    expect(controls.configurationLifecycle).not.toHaveBeenCalled();
    expect(controls.listHostRegistrations).toHaveBeenCalledTimes(hostReads);
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
  });

  it("announces a queued page change and waits for an in-flight save before leaving the editor", async () => {
    const { controls, snapshot } = executionControls();
    let finishSave!: (value: ConfigurationSnapshot) => void;
    controls.saveConfiguration.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    renderSettings({ configuration: controls, page: "environments" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Local" }));
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Saved local name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    expect(controls.saveConfiguration).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByText(/Waiting .* finish/i)).toBeVisible();
    expect(screen.getByLabelText("Environment name")).toHaveValue("Saved local name");
    expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull();
    const saved = structuredClone(snapshot);
    saved.revision = 1;
    saved.configuration.executionEnvironments[0]!.label = "Saved local name";
    await act(async () => { finishSave(saved); });
    expect(await screen.findByRole("heading", { name: "Appearance" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
    expect(screen.queryByLabelText("Environment name")).toBeNull();
  });

  it("cancels queued navigation after a rejected save and leaves the server error beside the retained draft", async () => {
    const { controls, snapshot } = executionControls();
    let rejectSave!: (reason: Error) => void;
    controls.saveConfiguration.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    renderSettings({ configuration: controls, page: "environments" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Local" }));
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Retained draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByText(/Waiting .* finish/i)).toBeVisible();
    await act(async () => { rejectSave(new ApiError(400, "invalid_configuration", "Workspace access is no longer available.", false)); });
    expect(screen.getByRole("alert")).toHaveTextContent("Workspace access is no longer available.");
    expect(screen.getByLabelText("Environment name")).toHaveValue("Retained draft");
    expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
    expect(screen.queryByText(/Waiting .* finish/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Stay here" })).toBeNull();
    expect(screen.getByTestId("settings-view")).toHaveAttribute("data-page", "environments");
    const saved = structuredClone(snapshot);
    saved.revision = 1;
    saved.configuration.executionEnvironments[0]!.label = "Retained draft";
    controls.saveConfiguration.mockResolvedValueOnce(saved);
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    await waitFor(() => expect(controls.saveConfiguration).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("heading", { name: "Retained draft" })).toBeVisible();
    expect(screen.getByTestId("settings-view")).toHaveAttribute("data-page", "environments");
  });

  it("Stay here cancels queued navigation and moves focus to the persistent page heading", async () => {
    const { controls, snapshot } = executionControls();
    let finishSave!: (value: ConfigurationSnapshot) => void;
    controls.saveConfiguration.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    renderSettings({ configuration: controls, page: "environments" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Local" }));
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Saved local name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Stay here" }));
    expect(screen.getByRole("heading", { name: "Edit Saved local name", level: 3 })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Stay here" })).toBeNull();
    expect(screen.queryByText(/Waiting .* finish/i)).toBeNull();
    const saved = structuredClone(snapshot);
    saved.revision = 1;
    saved.configuration.executionEnvironments[0]!.label = "Saved local name";
    await act(async () => { finishSave(saved); });
    expect(await screen.findByRole("heading", { name: "Saved local name" })).toBeVisible();
    expect(screen.getByTestId("settings-view")).toHaveAttribute("data-page", "environments");
    expect(controls.saveConfiguration).toHaveBeenCalledOnce();
  });

  it("adds the shared prompt library page and honors a new page request", async () => {
    const store = new CannedPromptClientStore({
      listCannedPrompts: vi.fn().mockResolvedValue({ revision: 0, items: [] }),
    } as unknown as ApiClient);
    renderSettings({ cannedPrompts: store });

    expect(
      screen.getAllByTestId("settings-page").map((page) => page.dataset.page),
    ).toEqual(["general", "appearance", "prompts", "mobile", "terminal", "diagnostics"]);

    act(() => navigate(settingsPath("prompts")));

    expect(screen.getByTestId("settings-view")).toHaveAttribute(
      "data-page",
      "prompts",
    );
    expect(screen.getByRole("heading", { name: "Prompts" })).toBeVisible();
    await waitFor(() => expect(store.getSnapshot().status).toBe("ready"));
    store.dispose();
  });

  it("offers category navigation from Settings home and the persistent picker", async () => {
    navigate(settingsPath(), { replace: true });
    render(<RoutedSettings onReturn={() => navigate("/")} />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "General" })).toBeNull();
    const home = screen.getByTestId("settings-view");
    expect(home).toHaveAttribute("data-page", "home");
    fireEvent.change(screen.getByLabelText("Settings category"), { target: { value: "terminal" } });
    expect(window.location.pathname).toBe("/settings/terminal");
    expect(screen.getByRole("heading", { name: "Terminal" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Settings category"), { target: { value: "appearance" } });
    expect(window.location.pathname).toBe("/settings/appearance");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
  });

  it("navigates category pages from the left nav", () => {
    renderSettings();

    expect(screen.getByTestId("settings-view")).toBeInTheDocument();
    const pages = screen.getAllByTestId("settings-page");
    expect(pages.map((page) => page.dataset.page)).toEqual([
      "general",
      "appearance",
      "mobile",
      "terminal",
      "diagnostics",
    ]);
    expect(pages[0]).toHaveAttribute("data-active", "true");
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();

    fireEvent.click(pages[1]!);
    expect(pages[1]).toHaveAttribute("data-active", "true");
    expect(pages[0]).toHaveAttribute("data-active", "false");
    expect(
      screen.getByRole("heading", { name: "Appearance" }),
    ).toBeInTheDocument();
  });

  it("adds the server page only when packaged-client controls are present", () => {
    const controls = {
      connections: { version: 1 as const, profiles: [{id: "10000000-0000-4000-8000-000000000001", name: "Home", baseUrl: "http://192.168.1.20:4783"}], selectedProfileId: null },
      save: vi.fn(async () => undefined),
      connect: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const view = renderSettings({ serverSettings: controls, page: "server" });

    expect(
      screen.getAllByTestId("settings-page").map((page) => page.dataset.page),
    ).toEqual(["general", "appearance", "mobile", "terminal", "server", "diagnostics"]);
    expect(screen.getByRole("heading", { name: "Server" })).toBeInTheDocument();
    expect(screen.getByText("http://192.168.1.20:4783")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect to Home" })).toBeInTheDocument();

    view.unmount();
    renderSettings();
    expect(
      screen.getAllByTestId("settings-page").map((page) => page.dataset.page),
    ).toEqual(["general", "appearance", "mobile", "terminal", "diagnostics"]);
    expect(screen.queryByRole("heading", { name: "Server" })).toBeNull();
  });

  it("shows Electron connection controls separately from Android server settings", async () => {
    const switchConnection = vi.fn(async () => undefined);
    const onReturn = vi.fn();
    renderSettings({ onReturn: onReturn, serverSettings: {
          connections: { version: 1 as const, profiles: [], selectedProfileId: null },
          save: vi.fn(async () => undefined),
          connect: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
        }, electronConnectionSettings: {
          activeProfile: {
            id: "10000000-0000-4000-8000-000000000001",
            name: "Build host",
            kind: "ssh",
            sshHost: "build-host",
            remotePort: 4784,
          },
          switchConnection,
        }, page: "connection" });

    expect(
      screen.getAllByTestId("settings-page").map((page) => page.dataset.page),
    ).toEqual(["general", "appearance", "mobile", "terminal", "connection", "diagnostics"]);
    expect(screen.getByRole("heading", { name: "Connection" })).toBeVisible();
    expect(screen.getByText("Build host")).toBeVisible();
    expect(
      screen.getByText(/SSH · build-host · remote port 4784/),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Server" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Switch connection" }));
    await waitFor(() => expect(switchConnection).toHaveBeenCalledOnce());
    await waitFor(() => expect(onReturn).toHaveBeenCalledOnce());
  });

  it("describes the built-in Local connection without exposing the desktop stack", () => {
    renderSettings({ electronConnectionSettings: {
          activeProfile: {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Local",
            kind: "local",
          },
          switchConnection: vi.fn(async () => undefined),
        }, page: "connection" });

    expect(
      screen.getByText("Local · Managed by the desktop app"),
    ).toBeVisible();
    expect(screen.getByTestId("settings-view")).not.toHaveTextContent(/\bElectron\b/u);
  });

  it("keeps the Electron connection page open and announces switch failures", async () => {
    const onReturn = vi.fn();
    renderSettings({ onReturn: onReturn, electronConnectionSettings: {
          activeProfile: {
            id: "10000000-0000-4000-8000-000000000001",
            name: "Office",
            kind: "direct",
            baseUrl: "https://sedes.example",
          },
          switchConnection: vi.fn(async () => {
            throw new Error("Could not stop the active tunnel.");
          }),
        }, page: "connection" });

    fireEvent.click(screen.getByRole("button", { name: "Switch connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not stop the active tunnel.",
    );
    expect(onReturn).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Switch connection" }),
    ).toBeEnabled();
  });

  it("adds the server-backed Tool clients page with its effective endpoint", async () => {
    const getToolClientOptions = vi.fn().mockResolvedValue({
      environments: [
        { id: "env-local", label: "Local", kind: "local", available: true },
      ],
      groups: [],
    });
    const listToolClients = vi.fn().mockResolvedValue({ items: [] });
    renderSettings({ page: "tool_clients", toolClients: {
          endpoint: "https://sedes.example",
          resources: { workspaces: [], threads: [] },
          api: {
            getToolClientOptions,
            listToolClients,
            getToolClient: vi.fn(),
            createToolClient: vi.fn(),
            replaceToolClient: vi.fn(),
            rotateToolClient: vi.fn(),
            revokeToolClient: vi.fn(),
          },
        } });

    expect(
      screen.getAllByTestId("settings-page").map((page) => page.dataset.page),
    ).toEqual(["general", "appearance", "mobile", "terminal", "tool_clients", "diagnostics"]);
    expect(screen.getByTestId("settings-view")).toHaveAttribute(
      "data-page",
      "tool_clients",
    );
    expect(screen.getByRole("heading", { name: "Tool clients" })).toBeVisible();
    await waitFor(() => expect(listToolClients).toHaveBeenCalled());
  });

  it("requires an explicit server scheme before saving a named connection", async () => {
    const save = vi.fn(async () => undefined);
    const controls = {
      connections: { version: 1 as const, profiles: [], selectedProfileId: null },
      save,
      connect: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const session = vi
      .spyOn(ApiClient.prototype, "session")
      .mockResolvedValue({} as Awaited<ReturnType<ApiClient["session"]>>);
    renderSettings({ serverSettings: controls, page: "server" });
    const input = screen.getByLabelText("Sedes server URL");

    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "Home" } });
    fireEvent.change(input, { target: { value: "192.168.1.20:4783" } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "must begin with http:// or https://",
    );
    expect(session).not.toHaveBeenCalled();

    fireEvent.change(input, {
      target: { value: "http://192.168.1.20:4783/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add & connect" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({id: expect.any(String), name: "Home", baseUrl: "http://192.168.1.20:4783"}),
    );
    expect(session).not.toHaveBeenCalled();
  });

  it("toggles seek-on-send through the settings module", () => {
    renderSettings();

    const toggle = screen.getByTestId("seek-on-submit-toggle");
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    expect(getSeekOnSubmit()).toBe(false);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("data-state", "checked");
    expect(getSeekOnSubmit()).toBe(true);

    fireEvent.click(toggle);
    expect(getSeekOnSubmit()).toBe(false);
  });

  it("chooses the device-local panel opening presentation", () => {
    renderSettings();

    const setting = screen.getByTestId("panel-presentation-setting");
    expect(setting).toHaveValue("split");
    expect(getPanelPresentation()).toBe("split");

    fireEvent.change(setting, { target: { value: "single" } });
    expect(setting).toHaveValue("single");
    expect(getPanelPresentation()).toBe("single");
  });

  it("selects server-projected activity summaries for this browser", () => {
    renderSettings();

    const setting = screen.getByTestId("activity-detail-setting");
    expect(setting).toHaveValue("full");
    expect(getActivityDetail()).toBe("full");
    expect(
      screen.getByText(/explicit provider reasoning summaries/),
    ).toBeVisible();
    expect(screen.getByText(/server omits detailed reasoning/)).toBeVisible();

    fireEvent.change(setting, { target: { value: "summary" } });
    expect(setting).toHaveValue("summary");
    expect(getActivityDetail()).toBe("summary");
    expect(localStorage.getItem("sedes-activity-detail")).toBe("summary");
  });

  it("loads and CAS-updates the account-wide OpenAI skill visibility", async () => {
    const read = vi.fn(async () => ({
      showOpenAIComposerSkills: false,
      revision: 0,
    }));
    const update = vi.fn(async () => ({
      showOpenAIComposerSkills: true,
      revision: 1,
    }));
    renderSettings({ applicationPreferences: { read, update } });

    const toggle = screen.getByTestId("show-openai-composer-skills-toggle");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByText(/across every Codex connection/)).toBeVisible();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        showOpenAIComposerSkills: true,
        expectedRevision: 0,
      }),
    );
    await waitFor(() =>
      expect(toggle).toHaveAttribute("data-state", "checked"),
    );
  });

  it("toggles right-Option composer focus through the settings module", () => {
    renderSettings();

    const toggle = screen.getByTestId("right-option-focuses-composer-toggle");
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    expect(toggle).toHaveAttribute(
      "aria-describedby",
      "setting-right-option-focuses-composer-description",
    );
    expect(getRightOptionFocusesComposer()).toBe(false);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("data-state", "checked");
    expect(getRightOptionFocusesComposer()).toBe(true);

    fireEvent.click(toggle);
    expect(getRightOptionFocusesComposer()).toBe(false);
  });

  it("configures post-send composer refocus on the Mobile page", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Mobile" }));
    const toggle = screen.getByTestId(
      "mobile-composer-refocus-after-send-toggle",
    );
    expect(screen.getByRole("heading", { name: "Mobile" })).toBeInTheDocument();
    expect(toggle).toHaveAttribute("data-state", "checked");
    expect(toggle).toHaveAttribute(
      "aria-describedby",
      "setting-mobile-composer-refocus-after-send-description",
    );
    expect(getMobileComposerRefocusAfterSend()).toBe(true);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    expect(getMobileComposerRefocusAfterSend()).toBe(false);
    expect(
      localStorage.getItem("sedes-mobile-composer-refocus-after-send"),
    ).toBe("false");
  });

  it("configures the mobile history seek control for this browser", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Mobile" }));
    const toggle = screen.getByTestId("mobile-history-seek-control-toggle");
    expect(toggle).toHaveAttribute("data-state", "checked");
    expect(toggle).toHaveAttribute(
      "aria-describedby",
      "setting-mobile-history-seek-control-description",
    );
    expect(getMobileHistorySeekControl()).toBe(true);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    expect(getMobileHistorySeekControl()).toBe(false);
    expect(localStorage.getItem("sedes-mobile-history-seek-control")).toBe(
      "false",
    );
  });

  it("stores a bounded earlier-history page size for this browser", () => {
    localStorage.setItem("sedes-history-page-size", "999");
    renderSettings();

    const pageSize = screen.getByTestId("history-page-size-setting");
    expect(pageSize).toHaveValue("10");
    expect(getHistoryPageSize()).toBe(10);
    fireEvent.change(pageSize, { target: { value: "25" } });
    expect(getHistoryPageSize()).toBe(25);
    expect(localStorage.getItem("sedes-history-page-size")).toBe("25");
  });

  it("controls diagnostic categories independently and copies their shared buffer", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    setDiagnosticCategoryEnabled("seek", true);
    vi.spyOn(console, "debug").mockImplementation(() => {});
    recordSeekDiagnostic("seek_pin_engaged", { spacerHeight: 240 });
    renderSettings();

    expect(screen.getByTestId("seek-on-submit-toggle")).toBeVisible();
    expect(screen.queryByTestId("seek-diagnostics-toggle")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copy log/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(window.location.pathname).toBe("/settings/diagnostics");
    expect(screen.getByRole("heading", { name: "Diagnostics" })).toBeVisible();
    expect(screen.queryByTestId("seek-on-submit-toggle")).toBeNull();

    expect(screen.getByTestId("seek-diagnostics-toggle")).toHaveAttribute(
      "data-state",
      "checked",
    );
    fireEvent.click(screen.getByTestId("thread-load-diagnostics-toggle"));
    expect(getDiagnosticCategoryEnabled("thread_load")).toBe(true);
    expect(getDiagnosticCategoryEnabled("seek")).toBe(true);
    expect(getDiagnosticCategoryEnabled("composer_input")).toBe(false);
    fireEvent.click(screen.getByTestId("composer-input-diagnostics-toggle"));
    expect(getDiagnosticCategoryEnabled("composer_input")).toBe(true);
    fireEvent.click(screen.getByTestId("streaming-diagnostics-toggle"));
    expect(getDiagnosticCategoryEnabled("streaming")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy log (1)" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]![0]).toContain("seek_pin_engaged");
    expect(await screen.findByRole("status")).toHaveTextContent("Log copied.");

    fireEvent.click(screen.getByTestId("seek-diagnostics-toggle"));
    expect(getDiagnosticCategoryEnabled("seek")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear copy buffer" }));
    expect(screen.getByRole("button", { name: "Copy log (0)" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Copy buffer cleared.");
  });

  it("names this build in Diagnostics and adds the server build only when it differs", () => {
    const store = (serverVersion?: string) =>
      ({
        getSnapshot: () => ({ serverVersion }) as unknown as ApplicationClientState,
        subscribe: () => () => {},
      }) as unknown as ApplicationClientStore;

    const matching = renderSettings({
      page: "diagnostics",
      applicationStore: store(SEDES_VERSION),
    });
    expect(screen.getByTestId("sedes-version")).toHaveTextContent(
      `Sedes ${SEDES_VERSION}`,
    );
    expect(screen.getByTestId("sedes-version").textContent).not.toContain(
      "server",
    );
    matching.unmount();

    renderSettings({ page: "diagnostics", applicationStore: store("9.9.9") });
    expect(screen.getByTestId("sedes-version")).toHaveTextContent(
      `Sedes ${SEDES_VERSION} · server Sedes 9.9.9`,
    );
  });

  it("drives the same appearance mechanism as the actions menu", () => {
    renderSettings();
    fireEvent.click(
      screen
        .getAllByTestId("settings-page")
        .find((page) => page.dataset.page === "appearance")!,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    // Same storage key + dataset write as appearance.ts consumers.
    expect(getAppearance()).toBe("dark");
    expect(localStorage.getItem("sedes-appearance")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(getAppearance()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("stores the browser-local environment palette and tint sliders", () => {
    renderSettings();
    fireEvent.click(
      screen
        .getAllByTestId("settings-page")
        .find((page) => page.dataset.page === "appearance")!,
    );

    expect(screen.getByRole("radio", { name: "Gem" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Spectrum" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Signal" })).toBeVisible();
    const intensity = screen.getByRole("slider", { name: "Intensity" });
    const fadeIn = screen.getByRole("slider", { name: "Row fade-in" });
    const coverage = screen.getByRole("slider", { name: "Coverage" });
    const enabledToggle = screen.getByTestId(
      "environment-colors-enabled-toggle",
    );
    expect(enabledToggle).toHaveAttribute("data-state", "checked");
    expect(getEnvironmentColorsEnabled()).toBe(true);
    expect(intensity).toHaveValue("15");
    expect(fadeIn).toHaveValue("6");
    expect(coverage).toHaveValue("68");
    expect(coverage).toHaveAttribute("min", "20");
    expect(coverage).toHaveAccessibleDescription(
      "Sets where each row tint becomes fully transparent.",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Vivid" }));
    fireEvent.change(intensity, { target: { value: "24" } });
    fireEvent.change(fadeIn, { target: { value: "7" } });
    fireEvent.change(coverage, { target: { value: "20" } });

    expect(getEnvironmentPalette()).toBe("vivid");
    expect(localStorage.getItem("sedes-environment-palette")).toBe("vivid");
    expect(document.documentElement.dataset.environmentPalette).toBe("vivid");
    expect(getEnvironmentTintSettings()).toEqual({
      intensity: 24,
      fadeIn: 7,
      coverage: 20,
    });
    expect(localStorage.getItem("sedes-environment-tint-settings")).toBe(
      JSON.stringify({ intensity: 24, fadeIn: 7, coverage: 20 }),
    );
    expect(document.documentElement.dataset.environmentTintIntensity).toBe(
      "24",
    );
    expect(document.documentElement.dataset.environmentTintFadeIn).toBe("7");
    expect(document.documentElement.dataset.environmentTintCoverage).toBe("20");

    fireEvent.click(enabledToggle);
    expect(getEnvironmentColorsEnabled()).toBe(false);
    expect(localStorage.getItem("sedes-environment-colors-enabled")).toBe(
      "false",
    );
    expect(screen.getByRole("radio", { name: "Vivid" })).toBeDisabled();
    expect(intensity).toBeDisabled();
    expect(fadeIn).toBeDisabled();
    expect(coverage).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reset tint controls" }),
    ).toBeDisabled();
    expect(getEnvironmentPalette()).toBe("vivid");
    expect(getEnvironmentTintSettings()).toEqual({
      intensity: 24,
      fadeIn: 7,
      coverage: 20,
    });

    fireEvent.click(enabledToggle);
    expect(getEnvironmentColorsEnabled()).toBe(true);
    expect(screen.getByRole("radio", { name: "Vivid" })).toBeEnabled();
    expect(intensity).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Reset tint controls" }),
    );
    expect(getEnvironmentTintSettings()).toEqual({
      intensity: 15,
      fadeIn: 6,
      coverage: 68,
    });
  });

  it("stores the default-on smooth-streaming appearance preference", () => {
    renderSettings();
    fireEvent.click(
      screen
        .getAllByTestId("settings-page")
        .find((page) => page.dataset.page === "appearance")!,
    );

    const toggle = screen.getByTestId("smooth-streaming-toggle");
    expect(toggle).toHaveAttribute("data-state", "checked");
    expect(toggle).toHaveAttribute(
      "aria-describedby",
      "setting-smooth-streaming-description",
    );
    expect(screen.getByText(/system's Reduce Motion preference/)).toBeVisible();
    expect(getSmoothStreamingEnabled()).toBe(true);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    expect(getSmoothStreamingEnabled()).toBe(false);
    expect(localStorage.getItem("sedes-smooth-streaming")).toBe("false");

    fireEvent.click(toggle);
    expect(getSmoothStreamingEnabled()).toBe(true);
  });

  it("keeps the animated chat background opt-in", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));

    const toggle = screen.getByTestId("chat-atmosphere-toggle");
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    expect(toggle).toHaveAccessibleDescription(
      "Draw a subtle animated point field behind conversations. Reduce Motion always disables this effect.",
    );
    expect(getChatAtmosphereEnabled()).toBe(false);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("data-state", "checked");
    expect(getChatAtmosphereEnabled()).toBe(true);
    expect(localStorage.getItem("sedes-chat-atmosphere")).toBe("true");

    fireEvent.click(toggle);
    expect(getChatAtmosphereEnabled()).toBe(false);
  });

  it("defaults to terminal termination confirmation and persists toggling it", () => {
    const view = renderSettings({ page: "terminal" });
    const toggle = screen.getByRole("checkbox", {
      name: "Confirm before ending active terminals",
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(getConfirmTerminalTermination()).toBe(false);
    view.unmount();
    renderSettings({ page: "terminal" });
    expect(screen.getByRole("checkbox", {
      name: "Confirm before ending active terminals",
    })).not.toBeChecked();
  });

  it("persists the client-local cursor blink setting", () => {
    const view = renderSettings({ page: "terminal" });
    const toggle = screen.getByRole("checkbox", { name: "Cursor blink" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(getTerminalPreferences().cursorBlink).toBe(false);
    view.unmount();
    renderSettings({ page: "terminal" });
    expect(screen.getByRole("checkbox", { name: "Cursor blink" })).not.toBeChecked();
  });

  it("owns browser-local terminal renderer preferences", () => {
    renderSettings();
    fireEvent.click(
      screen
        .getAllByTestId("settings-page")
        .find((page) => page.dataset.page === "terminal")!,
    );

    const fontSize = screen.getByTestId("terminal-font-size-setting");
    const scrollback = screen.getByTestId("terminal-scrollback-setting");
    expect(fontSize).toHaveValue("13");
    expect(scrollback).toHaveValue("8000");
    fireEvent.change(fontSize, { target: { value: "18" } });
    fireEvent.change(scrollback, { target: { value: "16000" } });

    expect(getTerminalPreferences()).toEqual({
      cursorBlink: true,
      fontSize: 18,
      scrollback: 16_000,
    });
    expect(localStorage.getItem("sedes-terminal-font-size")).toBe("18");
    expect(localStorage.getItem("sedes-terminal-scrollback")).toBe("16000");
  });

  it("focuses the selected category heading and returns through the page control", async () => {
    renderSettings();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Appearance" }));
    expect(window.location.pathname).toBe("/settings/appearance");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Appearance" })).toHaveFocus());
    fireEvent.click(screen.getByTestId("settings-return"));
    expect(window.location.pathname).toBe("/");
    expect(await screen.findByText("Workspace")).toBeVisible();
  });
});
