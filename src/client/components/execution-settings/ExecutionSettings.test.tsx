// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationDocument, ConfigurationSnapshot, ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";
import { ApiError } from "../../api/ApiClient.js";
import { navigate, settingsPath } from "../../app/router.js";
import { ExecutionSettings } from "./ExecutionSettings.js";
import { backendEditors } from "./backend-editors.js";
import type { HostPairingControls } from "./useHostPairings.js";
import { useConfiguration, type ConfigurationControls } from "./useConfiguration.js";

const localId = "10000000-0000-4000-8000-000000000001";
const remoteId = "10000000-0000-4000-8000-000000000002";
const outboundId = "10000000-0000-4000-8000-000000000003";

function configuration(): ConfigurationDocument {
  return {
    executionEnvironments: [
      { id: localId, kind: "local", label: "Local", workspaceRoots: ["/work"], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } },
      { id: remoteId, kind: "ssh", label: "Build host", hostAlias: "build-host", workspaceRoots: ["/projects"], operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files", "workspace_tools", "workspace_context"] } },
    ], backends: [], targets: [], defaultTargetId: null, webSearch: null,
  };
}

function configurationWithOutbound(): ConfigurationDocument {
  const document = configuration();
  document.executionEnvironments.push({ id: outboundId, kind: "outbound", pairingId: "10000000-0000-4000-8000-000000000004", platform: "darwin", label: "Paired Mac", workspaceRoots: ["/Users/operator/Projects"], operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files"] } });
  return document;
}

function controls(document = configuration(), runtimes: ConfigurationRuntimeState[] = []) {
  let current: ConfigurationSnapshot = { revision: 4, configuration: document, runtimes };
  const api = {
    outboundConnectorSetup: () => ({ serverUrl: "http://sedes.test:4784", downloadUrl: "http://sedes.test:4784/api/outbound/connector/sedes-sidecar.mjs" }),
    listHostRegistrations: vi.fn(async () => ({ registrations: [], pairings: [] })),
    acceptHostRegistration: vi.fn(), denyHostRegistration: vi.fn(), revokeHostPairing: vi.fn(), reapproveHostPairing: vi.fn(),
    readConfiguration: vi.fn(async () => structuredClone(current)),
    saveConfiguration: vi.fn(async (request) => {
      current = { ...current, revision: current.revision + 1, configuration: structuredClone(request.configuration) };
      return structuredClone(current);
    }),
    configurationLifecycleImpact: vi.fn(), configurationLifecycle: vi.fn(), getLifecycleReceipt: vi.fn(),
    listConfigurationOperations: vi.fn(), inspectConfigurationOperation: vi.fn(), acknowledgeConfigurationOperation: vi.fn(),
  } satisfies ConfigurationControls & HostPairingControls;
  return api;
}

function runtime(overrides: Partial<ConfigurationRuntimeState> = {}): ConfigurationRuntimeState {
  return { resourceKind: "environment", resourceId: remoteId, desiredRevision: 4, effectiveRevision: 4,
    applyState: "applied", preference: "automatic", connectionState: "connected", incarnation: "sidecar-one",
    softwareVersion: "1", upgradeState: "current", activeResources: 0, lastError: null,
    supportedActions: ["connect", "disconnect"], ...overrides };
}

/** Opens the page at a settings URL; selection and editing are routes. */
function renderAt(path: string, api = controls()) {
  act(() => navigate(path, { replace: true }));
  render(<ExecutionSettings controls={api} />);
  return api;
}

const detail = (label: string) => screen.getByRole("region", { name: `${label} details` });
const detailHeading = (label: string) => screen.getByRole("heading", { name: label, level: 2 });
const rowOf = (name: string) => screen.getByRole("link", { name }).closest("li")!;
const environmentPath = (id: string, suffix = "") => `/settings/environments/${id}${suffix}`;

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("execution configuration administration", () => {
  it("lists environments as rows and separates overview, backends and activity in a routed detail", async () => {
    const document = configuration();
    const backend = backendEditors.pi.createBackend("pi-remote");
    backend.label = "Build Pi";
    document.backends.push(backend);
    document.targets.push(backendEditors.pi.createTarget("pi-target", backend.id, remoteId));
    renderAt("/settings/environments", controls(document, [runtime()]));
    const user = userEvent.setup();
    const row = (await screen.findByRole("link", { name: "Build host" })).closest("li")!;
    expect(row).toHaveTextContent("SSH · build-host · 1 backend");
    expect(within(row).getByText("Connected")).toBeVisible();
    expect(within(row).getByRole("button", { name: "Actions for Build host" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Build host details" })).toBeNull();
    expect(screen.getByText("Select an environment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Build host" }));
    expect(window.location.pathname).toBe(environmentPath(remoteId));
    expect(detailHeading("Build host")).toHaveFocus();
    expect(rowOf("Build host").querySelector("a")).toHaveAttribute("aria-current", "page");
    const view = detail("Build host");
    // One status pill, in the header; the health summary says it in words.
    expect(within(view).getAllByText("Connected")).toHaveLength(1);
    expect(within(view).getByRole("region", { name: "Build host status" })).toHaveTextContent("Sidecar 1 is up to date.");
    expect(within(view).getByText("build-host")).toBeVisible();
    await user.click(within(view).getByRole("tab", { name: /^Backends/u }));
    expect(within(view).getByRole("link", { name: "Build Pi" })).toHaveAttribute("href", "/settings/backends/pi-remote");
    await user.click(within(view).getByRole("tab", { name: "Activity" }));
    expect(within(view).getByRole("tab", { name: "Activity" })).toHaveFocus();
    expect(within(view).getByText("Sidecar version")).toBeVisible();
    expect(within(view).getByRole("button", { name: "Copy service incarnation" })).toBeVisible();
    expect(within(view).getByRole("button", { name: "Recovered operations" })).toBeVisible();
    await user.click(within(view).getByRole("tab", { name: "Overview" }));
    // Internal identifiers stay in Activity's technical details.
    expect(view).not.toHaveTextContent("sidecar-one");
    await user.click(within(view).getByRole("button", { name: "Remove Build host" }));
    const removal = screen.getByRole("dialog", { name: "Remove Build host?" });
    expect(removal).toHaveTextContent("Referenced by Build Pi");
    expect(within(removal).getByRole("button", { name: "Remove environment" })).toBeDisabled();
    await user.click(within(removal).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(view).getByRole("button", { name: "Edit Build host" }));
    expect(window.location.pathname).toBe(environmentPath(remoteId, "/edit"));
    expect(screen.getByRole("heading", { name: "Edit Build host" })).toHaveFocus();
    const editor = screen.getByRole("region", { name: "Environment editor" });
    expect(within(editor).getByLabelText("Environment name")).toHaveValue("Build host");
    expect(within(editor).getByRole("group", { name: "SSH host alias" })).toHaveTextContent("build-host");
    // The editor's back link goes up through history to the detail it was opened from.
    fireEvent.click(within(editor).getByRole("link", { name: "Build host" }));
    await waitFor(() => expect(window.location.pathname).toBe(environmentPath(remoteId)));
    await waitFor(() => expect(detailHeading("Build host")).toHaveFocus());
  });

  it("identifies stale ownership without misrepresenting it as an unreachable host", async () => {
    renderAt(environmentPath(remoteId), controls(configuration(), [runtime({
      connectionState: "recovery_required", activeResources: 3,
      lastError: "Confirm the previous sidecar and its children have stopped.",
    })]));
    const status = await screen.findByRole("region", { name: "Build host status" });
    expect(rowOf("Build host")).toHaveTextContent("Recovery required");
    expect(rowOf("Build host")).not.toHaveTextContent("Unreachable");
    // The header carries the one pill and the primary action; one Callout the error.
    const view = detail("Build host");
    expect(within(view).getAllByText("Recovery required")).toHaveLength(1);
    expect(within(view).getAllByRole("alert").map(alert => alert.textContent)).toEqual(["Confirm the previous sidecar and its children have stopped."]);
    expect(within(view).getAllByRole("button", { name: "Retry connection" })).toHaveLength(1);
    expect(within(within(view).getByRole("group", { name: "Actions" })).getByRole("button", { name: "Retry connection" })).toBeEnabled();
    expect(within(status).getByRole("button", { name: "Review" })).toBeVisible();
    const user = userEvent.setup();
    await user.click(within(detail("Build host")).getByRole("tab", { name: "Activity" }));
    const technical = screen.getByRole("region", { name: "Technical details" });
    expect(within(technical).getByText("Active or unconfirmed resources").nextElementSibling).toHaveTextContent("Not confirmed");
    expect(screen.getByRole("button", { name: "Recovered operations" })).toBeVisible();
  });

  it("keeps an unsettled lifecycle command guarded across navigation and inventory filtering", async () => {
    const currentRuntime = runtime();
    const api = controls(configuration(), [currentRuntime]);
    api.configurationLifecycle.mockResolvedValue({ mutationId: "pending-command", state: "unknown", runtime: currentRuntime });
    renderAt(environmentPath(remoteId), api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Runtime actions for Build host" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled());
    act(() => navigate("/settings/environments"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search environments" }), { target: { value: "Local" } });
    expect(screen.queryByRole("link", { name: "Build host" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh status" })).toBeNull();
    act(() => navigate("/settings/backends"));
    expect(screen.getByRole("heading", { name: "Backends", level: 1 })).toBeVisible();
    act(() => navigate("/settings/environments"));
    expect(screen.getByRole("searchbox", { name: "Search environments" })).toHaveValue("Local");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    fireEvent.click(screen.getByRole("link", { name: "Build host" }));
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Runtime actions for Build host" }));
    expect(await screen.findByRole("menuitem", { name: "Disconnect" })).toHaveAttribute("aria-disabled", "true");
    expect(api.configurationLifecycle).toHaveBeenCalledOnce();
  });

  it("keeps disabled backends identifiable and removable from their detail", async () => {
    const document = configuration();
    const backend = backendEditors.codex_app_server.createBackend("codex-local");
    backend.label = "Personal Codex";
    backend.enabled = false;
    document.backends.push(backend);
    document.targets.push(backendEditors.codex_app_server.createTarget("codex-target", backend.id, localId));
    renderAt("/settings/backends", controls(document, [runtime({ resourceKind: "backend", resourceId: backend.id,
      preference: "disconnected", connectionState: "disconnected", supportedActions: [],
    })]));
    const row = (await screen.findByRole("link", { name: "Personal Codex" })).closest("li")!;
    expect(row).toHaveTextContent("Disabled");
    expect(row).toHaveTextContent("Intentionally disconnected");
    expect(row).toHaveTextContent("Codex · 1 connection");
    expect(screen.queryByRole("button", { name: "Remove Personal Codex" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Personal Codex" }));
    expect(within(detail("Personal Codex")).getByRole("button", { name: "Remove Personal Codex" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit Personal Codex" }));
    expect(window.location.pathname).toBe("/settings/backends/codex-local/edit");
    expect(screen.getByRole("heading", { name: "Edit Personal Codex" })).toHaveFocus();
    expect(screen.getByLabelText("Backend name")).toHaveValue("Personal Codex");
  });

  it("groups global backends by environment and combines search, provider, environment, and status filters", async () => {
    const document = configuration();
    const local = { ...backendEditors.pi.createBackend("local-pi"), label: "Personal assistant" };
    const remote = { ...backendEditors.codex_app_server.createBackend("remote-codex"), label: "Build agent" };
    const disabled = { ...backendEditors.claude_agent_sdk.createBackend("remote-claude"), label: "Archived agent", enabled: false };
    document.backends.push(local, remote, disabled);
    document.targets.push(
      { ...backendEditors.pi.createTarget("local-target", local.id, localId), label: "Research connection" },
      { ...backendEditors.codex_app_server.createTarget("remote-target", remote.id, remoteId), label: "Release connection" },
      { ...backendEditors.claude_agent_sdk.createTarget("disabled-target", disabled.id, remoteId), enabled: false },
    );
    const api = controls(document, [
      runtime({ resourceKind: "backend", resourceId: local.id, connectionState: "connected" }),
      runtime({ resourceKind: "backend", resourceId: remote.id, connectionState: "connected", applyState: "pending" }),
      runtime({ resourceKind: "backend", resourceId: disabled.id, connectionState: "stopped", preference: "stopped" }),
    ]);
    renderAt("/settings/backends", api);
    const localGroup = await screen.findByRole("region", { name: "Local backends" });
    const remoteGroup = screen.getByRole("region", { name: "Build host backends" });
    expect(localGroup).toHaveTextContent("1 backend");
    expect(remoteGroup).toHaveTextContent("2 backends");
    expect(within(localGroup).getByRole("link", { name: "Personal assistant" })).toBeVisible();
    const pendingRow = within(remoteGroup).getByRole("link", { name: "Build agent" }).closest("li")!;
    // One pill per row: the configuration state outranks a healthy connection.
    expect(within(pendingRow).getAllByText("Changes pending")).toHaveLength(1);
    expect(within(pendingRow).queryByText("Connected")).toBeNull();
    expect(within(remoteGroup).getByRole("link", { name: "Archived agent" })).toBeVisible();
    const inventory = screen.getByRole("region", { name: "Configured backends" });
    for (const [query, expected] of [["  RELEASE  ", "Build agent"], ["Pi SDK", "Personal assistant"], ["personal", "Personal assistant"]]) {
      fireEvent.change(screen.getByRole("searchbox", { name: "Search backends" }), { target: { value: query } });
      expect(within(inventory).getByRole("status")).toHaveTextContent("1 of 3 backends");
      expect(within(inventory).getByRole("link", { name: expected })).toBeVisible();
    }
    fireEvent.change(screen.getByRole("searchbox", { name: "Search backends" }), { target: { value: "build-host" } });
    expect(screen.queryByRole("region", { name: "Local backends" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter by environment"), { target: { value: remoteId } });
    fireEvent.change(screen.getByLabelText("Filter by provider"), { target: { value: "codex_app_server" } });
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "attention" } });
    expect(screen.getByRole("button", { name: "Filters (3)" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Build agent" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Archived agent" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "disabled" } });
    expect(screen.getByText("No backends match these filters.")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("searchbox", { name: "Search backends" })).toHaveFocus();
    expect(screen.getByRole("searchbox", { name: "Search backends" })).toHaveValue("");
    expect(screen.getByLabelText("Filter by environment")).toHaveValue("");
    expect(screen.getByLabelText("Filter by provider")).toHaveValue("");
    for (const status of ["disabled", "stopped"]) {
      fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: status } });
      expect(screen.getByRole("link", { name: "Archived agent" })).toBeVisible();
      expect(screen.queryByRole("link", { name: "Build agent" })).toBeNull();
    }
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "connected" } });
    expect(screen.getByRole("link", { name: "Build agent" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Personal assistant" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Archived agent" })).toBeNull();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("includes a disabled backend with a connected runtime in Needs attention", async () => {
    const document = configuration();
    const backend = { ...backendEditors.pi.createBackend("disabled-running-pi"), label: "Disabled but running", enabled: false };
    document.backends.push(backend);
    document.targets.push({ ...backendEditors.pi.createTarget("disabled-target", backend.id, localId), enabled: false });
    renderAt("/settings/backends", controls(document, [runtime({ resourceKind: "backend", resourceId: backend.id })]));
    await screen.findByRole("link", { name: "Disabled but running" });
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "attention" } });
    const row = rowOf("Disabled but running");
    expect(within(row).getByText("Backend disabled")).toBeVisible();
    // Fixed attributes read in the subtitle; the status is the row's one pill.
    expect(within(row).getByText("Pi SDK · 1 connection · Disabled")).toBeVisible();
    expect(within(row).getByTitle("Backend disabled")).toHaveAttribute("data-slot", "status-pill");
  });

  it("prefills scoped backend creation and opens the new backend after saving every connection in its environment", async () => {
    const api = controls();
    renderAt(environmentPath(remoteId), api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /^Backends/u }));
    expect(screen.getByText("No backends in this environment.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add backend" }));
    expect(window.location.pathname).toBe("/settings/backends/~new");
    expect(screen.getByLabelText("Execution environment")).toHaveValue(remoteId);
    expect(within(screen.getByLabelText("Backend type")).getByRole("option", { name: "Grok" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Backend name"), { target: { value: "Remote builder" } });
    fireEvent.change(screen.getByLabelText("Working directory"), { target: { value: "/projects" } });
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fireEvent.change(screen.getAllByLabelText("Connection name")[1]!, { target: { value: "Second connection" } });
    fireEvent.click(screen.getByRole("button", { name: "Save backend" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    const saved = api.saveConfiguration.mock.calls[0]![0].configuration;
    expect(saved.targets).toHaveLength(2);
    expect(saved.targets.map((entry: { label: string }) => entry.label)).toEqual(["Default connection", "Second connection"]);
    expect(saved.targets.every((entry: { executionEnvironmentId: string }) => entry.executionEnvironmentId === remoteId)).toBe(true);
    expect(saved.defaultTargetId).toBe(saved.targets[0]!.id);
    await waitFor(() => expect(window.location.pathname).toBe(`/settings/backends/${saved.backends[0]!.id}`));
    expect(detailHeading("Remote builder")).toHaveFocus();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("preserves environment search and returns focus to the row when coming back from a detail", async () => {
    renderAt("/settings/environments");
    await screen.findByRole("link", { name: "Build host" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search environments" }), { target: { value: "build-host" } });
    fireEvent.click(screen.getByRole("link", { name: "Build host" }));
    expect(detailHeading("Build host")).toHaveFocus();
    fireEvent.click(within(detail("Build host")).getByRole("link", { name: "Environments" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings/environments"));
    expect(screen.getByRole("searchbox", { name: "Search environments" })).toHaveValue("build-host");
    await waitFor(() => expect(screen.getByRole("link", { name: "Build host" })).toHaveFocus());
    expect(screen.queryByRole("link", { name: "Local" })).toBeNull();
  });

  it("walks entity routes with browser Back and Forward", async () => {
    renderAt("/settings/environments");
    fireEvent.click(await screen.findByRole("link", { name: "Build host" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Build host" }));
    expect(screen.getByRole("region", { name: "Environment editor" })).toBeVisible();
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe(environmentPath(remoteId)));
    expect(screen.queryByRole("region", { name: "Environment editor" })).toBeNull();
    expect(detailHeading("Build host")).toBeVisible();
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/settings/environments"));
    expect(screen.queryByRole("region", { name: "Build host details" })).toBeNull();
    act(() => window.history.forward());
    await waitFor(() => expect(window.location.pathname).toBe(environmentPath(remoteId)));
    expect(detailHeading("Build host")).toBeVisible();
  });

  it("opens deep links to an editor and explains an unknown entity", async () => {
    const api = renderAt(environmentPath(remoteId, "/edit"));
    expect(await screen.findByRole("heading", { name: "Edit Build host" })).toHaveFocus();
    expect(screen.getByLabelText("Environment name")).toHaveValue("Build host");
    cleanup();
    renderAt(environmentPath("10000000-0000-4000-8000-00000000ffff"), api);
    expect(await screen.findByText("Environment unavailable")).toBeVisible();
    expect(screen.getByRole("link", { name: "Environments" })).toHaveAttribute("href", "/settings/environments");
    cleanup();
    renderAt(settingsPath("backends", { mode: "edit", resourceId: "missing-backend" }), api);
    expect(await screen.findByText("Backend unavailable")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Backend editor" })).toBeNull();
  });

  it("names a pending registration unavailable when it is gone or the registrations cannot load", async () => {
    const api = renderAt(settingsPath("environments", { mode: "pending", resourceId: "reg-gone" }));
    expect(await screen.findByText("Registration unavailable")).toBeVisible();
    expect(screen.getByText("It was accepted, denied or expired.")).toBeVisible();
    cleanup();
    api.listHostRegistrations.mockRejectedValue(new Error("Registrations are unreachable."));
    renderAt(settingsPath("environments", { mode: "pending", resourceId: "reg-gone" }), api);
    expect(await screen.findByText("Registration unavailable")).toBeVisible();
    expect(screen.getByText("Host registrations could not be loaded. Refresh to try again.")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Registrations are unreachable.");
  });

  it("guards dirty edits when selecting another route and discards them on request", async () => {
    const api = renderAt(environmentPath(localId, "/edit"));
    fireEvent.change(await screen.findByLabelText("Environment name"), { target: { value: "Unsaved local name" } });
    act(() => navigate("/settings/backends"));
    const discard = screen.getByRole("dialog", { name: "Discard unsaved changes?" });
    expect(discard).toBeVisible();
    expect(window.location.pathname).toBe(environmentPath(localId, "/edit"));
    const user = userEvent.setup();
    await user.click(within(discard).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Environment name")).toHaveValue("Unsaved local name");
    fireEvent.click(screen.getByRole("link", { name: "Build host" }));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(window.location.pathname).toBe(environmentPath(remoteId));
    await waitFor(() => expect(detailHeading("Build host")).toHaveFocus());
    expect(screen.queryByLabelText("Environment name")).toBeNull();
    // The discarded draft is gone; a new editor starts from the saved value.
    act(() => navigate(environmentPath(localId, "/edit")));
    expect(screen.getByLabelText("Environment name")).toHaveValue("Local");
    act(() => navigate("/settings/backends"));
    expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it.each([false, true])("Refresh preserves an open environment editor (dirty: %s)", async (dirty) => {
    const api = renderAt(environmentPath(localId, "/edit"));
    const field = await screen.findByLabelText("Environment name");
    if (dirty) fireEvent.change(field, { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.readConfiguration).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.listHostRegistrations).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Environment name")).toBe(field);
    expect(field).toHaveValue(dirty ? "Unsaved name" : "Local");
    expect(screen.getByRole("region", { name: "Environment editor" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it.each(["global", "environment"])("confirms removal of a default backend and returns to the originating %s view", async (origin) => {
    const document = configuration();
    const backend = { ...backendEditors.pi.createBackend("remote-pi"), label: "Build Pi" };
    const retained = { ...backendEditors.pi.createBackend("local-pi"), label: "Keep Pi" };
    document.backends.push(backend, retained);
    document.targets.push(
      backendEditors.pi.createTarget("remote-primary", backend.id, remoteId),
      { ...backendEditors.pi.createTarget("remote-secondary", backend.id, remoteId), label: "Secondary" },
      backendEditors.pi.createTarget("local-primary", retained.id, localId),
    );
    document.defaultTargetId = "remote-primary";
    const api = renderAt(origin === "global" ? "/settings/backends" : environmentPath(remoteId), controls(document));
    const user = userEvent.setup();
    if (origin === "environment") await user.click(await screen.findByRole("tab", { name: /^Backends/u }));
    fireEvent.click(await screen.findByRole("link", { name: "Build Pi" }));
    expect(detail("Build Pi")).toHaveTextContent("Default");
    await user.click(screen.getByRole("button", { name: "Remove Build Pi" }));
    const confirmation = screen.getByRole("dialog", { name: "Remove Build Pi?" });
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove Build Pi" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Remove Build Pi" }));
    await user.click(within(screen.getByRole("dialog", { name: "Remove Build Pi?" })).getByRole("button", { name: "Remove backend" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    expect(api.saveConfiguration.mock.calls[0]![0]).toMatchObject({ expectedRevision: 4, configuration: {
      backends: [retained], targets: [document.targets[2]], defaultTargetId: null,
      executionEnvironments: document.executionEnvironments,
    } });
    await waitFor(() => expect(window.location.pathname).toBe(origin === "global" ? "/settings/backends" : environmentPath(remoteId)));
    await waitFor(() => expect(screen.getByRole("heading", { name: origin === "global" ? "Backends" : "Build host" })).toHaveFocus());
    expect(screen.queryByRole("link", { name: "Build Pi" })).toBeNull();
    if (origin === "global") expect(screen.getByRole("link", { name: "Keep Pi" })).toBeVisible();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("removes an unreferenced environment only after confirmation and returns to the environment list", async () => {
    const document = configuration();
    const api = renderAt(environmentPath(remoteId), controls(document));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove Build host" }));
    const confirmation = screen.getByRole("dialog", { name: "Remove Build host?" });
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Remove environment" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    expect(api.saveConfiguration.mock.calls[0]![0]).toMatchObject({ expectedRevision: 4, configuration: {
      executionEnvironments: [document.executionEnvironments[0]], backends: [], targets: [], defaultTargetId: null,
    } });
    await waitFor(() => expect(window.location.pathname).toBe("/settings/environments"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Environments", level: 1 })).toHaveFocus());
    expect(screen.getByRole("link", { name: "Local" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Build host" })).toBeNull();
  });

  it("closes a removal confirmation when navigation leaves its resource, and keeps it closed on return", async () => {
    const api = renderAt(environmentPath(remoteId), controls());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove Build host" }));
    expect(screen.getByRole("dialog", { name: "Remove Build host?" })).toBeVisible();
    // Another settings page: this page stays mounted but hidden.
    act(() => navigate("/settings/general"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Build host?" })).toBeNull());
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe(environmentPath(remoteId)));
    expect(await screen.findByRole("button", { name: "Remove Build host" })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();

    // Another location of the same page, from a row menu's confirmation.
    await user.click(screen.getByRole("button", { name: "Actions for Local" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    expect(screen.getByRole("dialog", { name: "Remove Local?" })).toBeVisible();
    act(() => navigate("/settings/environments"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove Local?" })).toBeNull());
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it("opens an entity on Overview each visit unless its row asked for Activity, and keeps the tab back from its editor", async () => {
    renderAt(environmentPath(remoteId));
    const user = userEvent.setup();
    const selected = () => within(detail("Build host")).getByRole("tab", { selected: true });
    await user.click(within(await screen.findByRole("region", { name: "Build host details" })).getByRole("tab", { name: "Activity" }));
    await user.click(within(detail("Build host")).getByRole("button", { name: "Edit Build host" }));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe(environmentPath(remoteId)));
    expect(selected()).toHaveAccessibleName("Activity");
    await user.click(screen.getByRole("link", { name: "Local" }));
    await user.click(screen.getByRole("link", { name: "Build host" }));
    expect(selected()).toHaveAccessibleName("Overview");
    await user.click(screen.getByRole("button", { name: "Actions for Local" }));
    await user.click(await screen.findByRole("menuitem", { name: "View activity" }));
    expect(within(detail("Local")).getByRole("tab", { selected: true })).toHaveAccessibleName("Activity");
  });

  it("offers removal from a row menu and lists what blocks it", async () => {
    const document = configuration();
    document.backends.push(backendEditors.pi.createBackend("pi-local"));
    document.targets.push(backendEditors.pi.createTarget("pi-remote", "pi-local", remoteId));
    const api = renderAt("/settings/environments", controls(document));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Actions for Build host" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    const confirmation = screen.getByRole("dialog", { name: "Remove Build host?" });
    expect(confirmation).toHaveTextContent("Remove that backend first.");
    expect(within(confirmation).getByRole("button", { name: "Remove environment" })).toBeDisabled();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Actions for Build host" }));
    await user.click(await screen.findByRole("menuitem", { name: "View activity" }));
    expect(window.location.pathname).toBe(environmentPath(remoteId));
    expect(within(detail("Build host")).getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it("blocks a removal confirmation when another session changes the configuration revision", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const api = renderAt(environmentPath(remoteId));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Remove Build host" }));
    const confirmation = screen.getByRole("dialog", { name: "Remove Build host?" });
    expect(within(confirmation).getByRole("button", { name: "Remove environment" })).toBeEnabled();
    const changed = configuration();
    changed.executionEnvironments[1]!.label = "Renamed by another session";
    api.readConfiguration.mockResolvedValue({ revision: 5, configuration: changed, runtimes: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(within(confirmation).getByRole("button", { name: "Remove environment" })).toBeDisabled();
    expect(confirmation).toHaveTextContent("The configuration changed or could not be confirmed. Close this and refresh it first.");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Remove environment" }));
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it("distinguishes an empty environment from filtered results and clears a removed environment filter", async () => {
    const document = configuration();
    const backend = { ...backendEditors.pi.createBackend("local-pi"), label: "Local Pi" };
    document.backends.push(backend);
    document.targets.push(backendEditors.pi.createTarget("local-target", backend.id, localId));
    const api = renderAt(environmentPath(remoteId), controls(document));
    await userEvent.setup().click(await screen.findByRole("tab", { name: /^Backends/u }));
    expect(screen.getByText("No backends in this environment.")).toBeVisible();
    expect(screen.queryByText("No backends match these filters.")).toBeNull();
    act(() => navigate("/settings/backends"));
    fireEvent.change(screen.getByLabelText("Filter by environment"), { target: { value: remoteId } });
    expect(screen.getByText("No backends match these filters.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Filter by environment"), { target: { value: "" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search backends" }), { target: { value: "missing" } });
    expect(screen.getByText("No backends match these filters.")).toBeVisible();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search backends" }), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter by environment"), { target: { value: remoteId } });
    api.readConfiguration.mockResolvedValue({ revision: 5, configuration: {
      ...document, executionEnvironments: document.executionEnvironments.filter(entry => entry.id !== remoteId),
    }, runtimes: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByLabelText("Filter by environment")).toHaveValue(""));
    expect(screen.getByRole("link", { name: "Local Pi" })).toBeVisible();
    expect(screen.queryByText("No backends match these filters.")).toBeNull();
  });

  it("does not rebase dirty edits when a hidden lifecycle receipt settles at a newer revision", async () => {
    vi.useFakeTimers();
    const mutationId = "20000000-0000-4000-8000-000000000001";
    const pendingRuntime = runtime({ lifecycleOperation: { mutationId, action: "disconnect", state: "pending" } });
    const api = renderAt(environmentPath(localId, "/edit"), controls(configuration(), [pendingRuntime]));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "My unsaved local name" } });
    const updated = configuration();
    updated.executionEnvironments[0]!.label = "Another session's name";
    const settledRuntime = runtime({ desiredRevision: 5, effectiveRevision: 5, connectionState: "disconnected", preference: "disconnected" });
    api.getLifecycleReceipt.mockResolvedValue({ mutationId, state: "applied", runtime: settledRuntime });
    api.readConfiguration.mockResolvedValue({ revision: 5, configuration: updated, runtimes: [settledRuntime] });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(api.getLifecycleReceipt).toHaveBeenCalledOnce();
    expect(api.getLifecycleReceipt).toHaveBeenCalledWith(mutationId);
    expect(screen.getByLabelText("Environment name")).toHaveValue("My unsaved local name");
    expect(screen.getByRole("alert")).toHaveTextContent("Configuration changed in another session");
    expect(screen.getByRole("button", { name: "Save environment" })).toBeDisabled();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("refreshes runtime status while open without rebasing dirty edits onto another revision", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const api = controls();
    const view = renderHook(({ editing }) => useConfiguration(api, editing), { initialProps: { editing: false } });
    await act(async () => {});
    expect(view.result.current.snapshot?.revision).toBe(4);
    view.rerender({ editing: true });
    const updated = configuration();
    updated.executionEnvironments[0]!.label = "Another editor's change";
    api.readConfiguration.mockResolvedValueOnce({ revision: 5, configuration: updated, runtimes: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(view.result.current.snapshot?.revision).toBe(4);
    expect(view.result.current.snapshot?.configuration.executionEnvironments[0]!.label).toBe("Local");
    expect(view.result.current.needsRefresh).toBe(true);
    expect(view.result.current.error).toContain("Configuration changed in another session");
    view.rerender({ editing: false });
    api.readConfiguration.mockResolvedValueOnce({ revision: 5, configuration: updated, runtimes: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(view.result.current.snapshot?.revision).toBe(5);
    expect(view.result.current.snapshot?.configuration.executionEnvironments[0]!.label).toBe("Another editor's change");
    expect(view.result.current.needsRefresh).toBe(false);
    expect(view.result.current.error).toBe("");
    const reads = api.readConfiguration.mock.calls.length;
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.readConfiguration).toHaveBeenCalledTimes(reads);
  });

  it("creates typed SSH configuration through the add flow and keeps tool/context grants paired", async () => {
    const api = renderAt("/settings/environments");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add environment" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add environment" }));
    expect(window.location.pathname).toBe("/settings/environments/~new");
    expect(screen.getByRole("button", { name: "Local machine" })).toBeDisabled();
    fireEvent.click(screen.getByRole("link", { name: "SSH host" }));
    expect(window.location.pathname).toBe("/settings/environments/~new/ssh");
    expect(screen.getByRole("heading", { name: "New SSH environment" })).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "New host" } });
    fireEvent.change(screen.getByLabelText("SSH host alias"), { target: { value: "new-host" } });
    fireEvent.change(screen.getByLabelText("Workspace root 1"), { target: { value: "/work/projects" } });
    fireEvent.click(screen.getByRole("button", { name: "Add root" }));
    fireEvent.change(screen.getByLabelText("Workspace root 2"), { target: { value: "/work/scratch" } });
    fireEvent.click(screen.getByLabelText("Workspace tools and context"));
    fireEvent.click(screen.getByLabelText("Interactive terminals"));
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    const request = api.saveConfiguration.mock.calls[0]![0];
    expect(request.expectedRevision).toBe(4);
    expect(request).not.toHaveProperty("principalId");
    const created = request.configuration.executionEnvironments[2];
    expect(created).toMatchObject({
      kind: "ssh", label: "New host", hostAlias: "new-host", workspaceRoots: ["/work/projects", "/work/scratch"],
      operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files", "workspace_tools", "workspace_context", "interactive_terminal"] },
    });
    expect(created).not.toHaveProperty("operations.carrier");
    await waitFor(() => expect(window.location.pathname).toBe(environmentPath(created.id)));
    expect(detailHeading("New host")).toHaveFocus();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("maps schema paths to the edited environment's fields and never carries them to another entity", async () => {
    const api = renderAt("/settings/environments/~new/ssh");
    fireEvent.change(await screen.findByLabelText("Environment name"), { target: { value: "Broken host" } });
    fireEvent.change(screen.getByLabelText("SSH host alias"), { target: { value: "broken" } });
    fireEvent.change(screen.getByLabelText("Workspace root 1"), { target: { value: "relative/path" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    const root = screen.getByLabelText("Workspace root 1");
    await waitFor(() => expect(root).toHaveAttribute("aria-invalid", "true"));
    expect(root).toHaveAccessibleDescription("An absolute execution-environment path is required.");
    expect(root).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("Fix the highlighted fields to save.");
    expect(document.body).not.toHaveTextContent(/executionEnvironments|workspaceRoots|Invalid input/u);
    expect(api.saveConfiguration).not.toHaveBeenCalled();
    fireEvent.change(root, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    await waitFor(() => expect(screen.getByRole("group", { name: "Workspace roots" })).toHaveAccessibleDescription(/Add at least one workspace root\./u));
    fireEvent.click(screen.getByRole("link", { name: "Local" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Discard changes" }));
    expect(detailHeading("Local")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Local" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Workspace root 1")).not.toHaveAttribute("aria-invalid");
  });

  it("retains edits after a conflict but requires discarding them before loading a fresh revision", async () => {
    const api = controls();
    api.saveConfiguration.mockRejectedValueOnce(new ApiError(409, "conflict", "Configuration changed in another session.", false));
    renderAt(environmentPath(localId, "/edit"), api);
    fireEvent.change(await screen.findByLabelText("Environment name"), { target: { value: "My edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Configuration changed in another session.");
    expect(screen.getByLabelText("Environment name")).toHaveValue("My edit");
    expect(screen.getByRole("button", { name: "Save environment" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(api.readConfiguration).toHaveBeenCalledTimes(2));
    expect(window.location.pathname).toBe(environmentPath(localId));
    expect(screen.queryByLabelText("Environment name")).not.toBeInTheDocument();
    expect(api.saveConfiguration).toHaveBeenCalledOnce();
  });

  it("preserves a rejected draft, allows correction, and confirms the save in the save bar", async () => {
    const api = controls();
    api.saveConfiguration.mockRejectedValueOnce(new ApiError(400, "invalid_configuration", "Workspace roots must be canonical.", false));
    renderAt(environmentPath(localId, "/edit"), api);
    fireEvent.change(await screen.findByLabelText("Environment name"), { target: { value: "My edit" } });
    fireEvent.change(screen.getByLabelText("Workspace root 1"), { target: { value: "/work/" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace roots must be canonical.");
    expect(screen.getByLabelText("Environment name")).toHaveValue("My edit");
    expect(screen.getByRole("button", { name: "Save environment" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Workspace root 1"), { target: { value: "/work" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledTimes(2));
    expect(api.saveConfiguration.mock.calls[1]![0]).toMatchObject({ expectedRevision: 4,
      configuration: { executionEnvironments: [expect.objectContaining({ label: "My edit", workspaceRoots: ["/work"] }), expect.anything()] },
    });
    expect(await screen.findByText("Saved")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Save environment" })).toBeDisabled();
    expect(api.readConfiguration).toHaveBeenCalledOnce();
  });

  it("cannot remove an environment that still has a backend connection and keeps its alias fixed", async () => {
    const document = configuration();
    document.backends.push(backendEditors.pi.createBackend("pi-local"));
    document.targets.push(backendEditors.pi.createTarget("pi-remote", "pi-local", remoteId));
    renderAt(environmentPath(remoteId), controls(document));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Build host" }));
    expect(within(screen.getByRole("dialog", { name: "Remove Build host?" })).getByRole("button", { name: "Remove environment" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Build host" }));
    expect(screen.queryByRole("textbox", { name: "SSH host alias" })).toBeNull();
    expect(screen.getByRole("group", { name: "SSH host alias" })).toHaveTextContent("build-hostLocked");
  });

  it("edits Codex WebSocket credentials as references and saves the backend with its target atomically", async () => {
    const api = renderAt("/settings/backends");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add backend" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add backend" }));
    fireEvent.change(screen.getByLabelText("Backend name"), { target: { value: "Remote Codex" } });
    fireEvent.change(screen.getByLabelText("Connection transport"), { target: { value: "tcp_websocket" } });
    fireEvent.change(screen.getByLabelText("WebSocket endpoint"), { target: { value: "wss://provider.internal:9000" } });
    fireEvent.change(screen.getByLabelText("Token file reference"), { target: { value: "/secrets/codex-token" } });
    fireEvent.change(screen.getByLabelText("Execution environment"), { target: { value: remoteId } });
    fireEvent.click(screen.getByRole("button", { name: "Save backend" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    const saved = api.saveConfiguration.mock.calls[0]![0].configuration;
    expect(saved.backends).toHaveLength(1);
    expect(saved.backends[0]).toMatchObject({ kind: "codex_app_server", moduleConfiguration: { connection: {
      ownership: "external", channel: { type: "tcp_websocket", url: "wss://provider.internal:9000", authentication: { type: "capability_token", secret: { source: "protected_file", path: "/secrets/codex-token" } } },
    } } });
    expect(saved.targets[0]).toMatchObject({ backendInstanceId: saved.backends[0]!.id, executionEnvironmentId: remoteId, enabled: true });
    expect(saved.defaultTargetId).toBe(saved.targets[0]!.id);
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("explains a token variable name the schema rejects on its own field", async () => {
    const api = renderAt("/settings/backends/~new");
    fireEvent.change(await screen.findByLabelText("Execution environment"), { target: { value: localId } });
    fireEvent.change(screen.getByLabelText("Backend name"), { target: { value: "Remote Codex" } });
    fireEvent.change(screen.getByLabelText("Connection transport"), { target: { value: "tcp_websocket" } });
    fireEvent.change(screen.getByLabelText("WebSocket endpoint"), { target: { value: "wss://provider.internal:9000" } });
    fireEvent.change(screen.getByLabelText("Capability token source"), { target: { value: "environment" } });
    fireEvent.change(screen.getByLabelText("Token environment variable"), { target: { value: "MY_TOKEN" } });
    fireEvent.click(screen.getByRole("button", { name: "Save backend" }));
    await waitFor(() => expect(screen.getByLabelText("Token environment variable")).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByLabelText("Token environment variable")).toHaveAccessibleDescription(/starts with SEDES_CODEX_ and contains TOKEN/u);
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it("requires an environment before choosing an eligible backend and keeps Grok local", async () => {
    renderAt("/settings/backends", controls(configurationWithOutbound()));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add backend" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add backend" }));
    const environment = screen.getByLabelText("Execution environment");
    const provider = screen.getByLabelText("Backend type");
    expect(environment).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save backend" })).toBeDisabled();
    expect(screen.getByText("Choose an execution environment to select a supported backend type.")).toBeVisible();
    for (const option of within(provider).getAllByRole("option")) expect(option).toBeDisabled();
    for (const id of [remoteId, outboundId, localId]) {
      fireEvent.change(environment, { target: { value: id } });
      for (const name of ["Claude", "Codex", "Pi SDK"]) expect(within(provider).getByRole("option", { name })).toBeEnabled();
      expect(within(provider).getByRole("option", { name: "Grok" })).toHaveProperty("disabled", id !== localId);
    }
    fireEvent.change(provider, { target: { value: "pi" } });
    expect(screen.getByText(/SDK and model connection run on Sedes/)).toBeVisible();
    fireEvent.change(provider, { target: { value: "grok_build" } });
    fireEvent.change(environment, { target: { value: remoteId } });
    expect(provider).toHaveValue("grok_build");
    expect(environment).toHaveValue(remoteId);
    expect(screen.getByRole("alert")).toHaveTextContent("This provider is not supported in Build host.");
    expect(screen.getByRole("button", { name: "Save backend" })).toBeDisabled();
    fireEvent.change(provider, { target: { value: "codex_app_server" } });
    expect(screen.getByRole("button", { name: "Save backend" })).toBeEnabled();
    expect(screen.queryByRole("option", { name: "Cursor" })).toBeNull();
  });

  it.each([localId, remoteId, outboundId])("saves Claude on %s with the execution account's native configuration default", async (environmentId) => {
    const api = renderAt("/settings/backends/~new", controls(configurationWithOutbound()));
    fireEvent.change(await screen.findByLabelText("Execution environment"), { target: { value: environmentId } });
    fireEvent.change(screen.getByLabelText("Backend type"), { target: { value: "claude_agent_sdk" } });
    fireEvent.change(screen.getByLabelText("Backend name"), { target: { value: "Claude" } });
    expect(screen.queryByLabelText("Claude configuration directory")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Advanced/u }));
    const directory = screen.getByLabelText("Claude configuration directory");
    expect(directory).toHaveValue("");
    expect(directory).not.toBeRequired();
    expect(directory).toHaveAccessibleDescription(/CLAUDE_CONFIG_DIR or ~\/.claude/);
    fireEvent.change(directory, { target: { value: "/custom/claude" } });
    fireEvent.change(directory, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save backend" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    const saved = api.saveConfiguration.mock.calls[0]![0].configuration;
    expect(saved.backends[0]).toMatchObject({ kind: "claude_agent_sdk" });
    expect(saved.backends[0].moduleConfiguration).not.toHaveProperty("configDirectory");
    expect(saved.targets[0]).toMatchObject({ executionEnvironmentId: environmentId });
  });

  it("enables retained remote Claude connections while preserving their execution environment and identity", async () => {
    const document = configuration();
    const backend = backendEditors.claude_agent_sdk.createBackend("claude-remote");
    backend.label = "Remote Claude";
    backend.enabled = false;
    document.backends.push(backend);
    document.targets.push({ ...backendEditors.claude_agent_sdk.createTarget("claude-target", backend.id, remoteId), enabled: false });
    const api = renderAt("/settings/backends/claude-remote/edit", controls(document));
    expect(await screen.findByRole("group", { name: "Execution environment" })).toHaveTextContent("Build host");
    expect(screen.queryByRole("combobox", { name: "Execution environment" })).toBeNull();
    expect(screen.getByLabelText("Connection enabled")).toBeDisabled();
    expect(screen.queryByText(/retained remote connection is unsupported/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Advanced/u }));
    fireEvent.change(screen.getByLabelText("Claude configuration directory"), { target: { value: "/home/remote/.claude" } });
    fireEvent.click(screen.getByLabelText("Backend enabled"));
    expect(screen.getByLabelText("Connection enabled")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Connection enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save backend" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    const saved = api.saveConfiguration.mock.calls[0]![0].configuration;
    expect(saved.backends[0]).toMatchObject({ id: "claude-remote", enabled: true, moduleConfiguration: { configDirectory: "/home/remote/.claude" } });
    expect(saved.targets[0]).toMatchObject({ id: "claude-target", enabled: true, executionEnvironmentId: remoteId });
  });

  it("allows metadata edits to disabled Windows Claude bindings without offering unsupported enablement", async () => {
    const document = configurationWithOutbound();
    document.executionEnvironments = document.executionEnvironments.map(entry => entry.kind === "outbound" ? { ...entry, platform: "win32", workspaceRoots: ["C:\\Projects"] } : entry);
    const backend = backendEditors.claude_agent_sdk.createBackend("claude-windows");
    backend.label = "Windows Claude"; backend.enabled = false;
    document.backends.push(backend);
    document.targets.push({ ...backendEditors.claude_agent_sdk.createTarget("windows-claude-target", backend.id, outboundId), enabled: false });
    const api = renderAt("/settings/backends/claude-windows", controls(document));
    expect(await screen.findByText("Remote execution is unsupported. This retained configuration cannot run here.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit Windows Claude" }));
    expect(screen.getByRole("group", { name: "Execution environment" })).toHaveTextContent("Paired Mac");
    expect(screen.getByLabelText("Backend enabled")).toBeDisabled();
    expect(screen.getByLabelText("Connection enabled")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Backend name"), { target: { value: "Archived Windows Claude" } });
    expect(screen.getByRole("button", { name: "Save backend" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save backend" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    const saved = api.saveConfiguration.mock.calls[0]![0].configuration;
    expect(saved.backends[0]).toMatchObject({ id: backend.id, label: "Archived Windows Claude", enabled: false });
    expect(saved.targets[0]).toMatchObject({ id: "windows-claude-target", backendInstanceId: backend.id, executionEnvironmentId: outboundId, enabled: false });
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("builds model policy rules from identifier chips and preserves identifier dimensions", async () => {
    const api = renderAt("/settings/backends/~new");
    fireEvent.change(await screen.findByLabelText("Execution environment"), { target: { value: localId } });
    fireEvent.change(screen.getByLabelText("Backend type"), { target: { value: "pi" } });
    fireEvent.change(screen.getByLabelText("Backend name"), { target: { value: "Pi SDK" } });
    fireEvent.change(screen.getByLabelText("Available models"), { target: { value: "allowlist" } });
    fireEvent.change(screen.getByLabelText("Provider identifiers"), { target: { value: "provider-a," } });
    fireEvent.change(screen.getByLabelText("Model identifiers"), { target: { value: "model-one, model-two" } });
    const efforts = screen.getByLabelText("Reasoning efforts");
    fireEvent.change(efforts, { target: { value: "low" } });
    fireEvent.keyDown(efforts, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove model-two" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Model identifiers"), { target: { value: "model-one," } });
    fireEvent.click(screen.getByRole("button", { name: "Save backend" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    expect(api.saveConfiguration.mock.calls[0]![0].configuration.backends[0]!.modelPolicy).toEqual({ type: "allowlist", allowed: [{ providerIds: ["provider-a"], modelIds: ["model-one", "model-two"], reasoningEfforts: ["low"] }] });
  });

  it("saves the account defaults inline and guards them like any unsaved edit", async () => {
    const document = configuration();
    const backend = { ...backendEditors.pi.createBackend("local-pi"), label: "Local Pi" };
    document.backends.push(backend);
    document.targets.push(backendEditors.pi.createTarget("local-target", backend.id, localId));
    const api = renderAt("/settings/backends", controls(document));
    const defaults = await screen.findByRole("form", { name: "Backend defaults" });
    expect(within(defaults).queryByRole("button", { name: "Save defaults" })).toBeNull();
    fireEvent.change(within(defaults).getByLabelText("Default connection for new threads"), { target: { value: "local-target" } });
    fireEvent.click(within(defaults).getByLabelText("Grok CLI research"));
    act(() => navigate("/settings/environments"));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(within(defaults).getByRole("button", { name: "Save defaults" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    expect(api.saveConfiguration.mock.calls[0]![0].configuration).toMatchObject({ defaultTargetId: "local-target", webSearch: { provider: "grok_cli" } });
    expect(await within(defaults).findByText("Saved")).toBeVisible();
    act(() => navigate("/settings/environments"));
    expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
  });
});
