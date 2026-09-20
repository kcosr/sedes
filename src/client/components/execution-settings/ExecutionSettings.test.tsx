// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationDocument, ConfigurationSnapshot, ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";
import { ApiError } from "../../api/ApiClient.js";
import { createRef } from "react";
import { ExecutionSettings, type ExecutionSettingsNavigation } from "./ExecutionSettings.js";
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

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("execution configuration administration", () => {
  it("keeps edit actions visible and separates associated backends from activity and diagnostics", async () => {
    const document = configuration();
    const backend = backendEditors.pi.createBackend("pi-remote");
    backend.label = "Build Pi";
    document.backends.push(backend);
    document.targets.push(backendEditors.pi.createTarget("pi-target", backend.id, remoteId));
    render(<ExecutionSettings controls={controls(document, [runtime()])} />);
    const summary = await screen.findByRole("button", { name: "Build host details" });
    const row = summary.closest("tr")!;
    expect(within(row).getByText("SSH · build-host")).toBeVisible();
    expect(within(row).getByText("Connected")).toBeVisible();
    expect(within(row).getByRole("button", { name: "Edit Build host" })).toBeVisible();
    expect(within(row).getByRole("button", { name: "Actions for Build host" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Build host runtime" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Environment editor" })).toBeNull();
    fireEvent.click(summary);
    expect(screen.getByRole("heading", { name: "Build host" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Build Pi details" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Build host runtime" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Activity & diagnostics" }));
    expect(screen.getByRole("button", { name: "Activity & diagnostics" })).toHaveFocus();
    expect(screen.getByRole("region", { name: "Build host runtime" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove Build host" })).toBeDisabled();
    expect(screen.getByText(/Referenced by backend connections/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Recovered operations" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit Build host" }));
    expect(screen.getByLabelText("Environment name")).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Configured environments" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/u }));
    expect(screen.getByRole("region", { name: "Build host runtime" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Backends" }));
    expect(screen.getByRole("button", { name: "Backends" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Recovered operations" })).toBeNull();
  });

  it("identifies stale ownership without misrepresenting it as an unreachable host", async () => {
    render(<ExecutionSettings controls={controls(configuration(), [runtime({
      connectionState: "recovery_required", activeResources: 3,
      lastError: "Confirm the previous sidecar and its children have stopped.",
    })])} />);
    const summary = await screen.findByRole("button", { name: "Build host details" });
    expect(summary.closest("tr")).toHaveTextContent("Recovery required");
    expect(summary.closest("tr")).not.toHaveTextContent("Unreachable");
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole("button", { name: "Activity & diagnostics" }));
    const details = screen.getByRole("region", { name: "Build host runtime" });
    expect(within(details).getByText("Recovery required")).toBeVisible();
    expect(within(details).getByRole("button", { name: "Retry connection" })).toBeEnabled();
    expect(within(details).getByRole("alert")).toHaveTextContent("Confirm the previous sidecar and its children have stopped.");
    fireEvent.click(within(details).getByRole("button", { name: "Build host runtime details" }));
    expect(within(details).getByText("Not confirmed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Recovered operations" })).toBeVisible();
  });

  it("keeps an unsettled lifecycle command guarded across navigation and inventory filtering", async () => {
    const currentRuntime = runtime();
    const api = controls(configuration(), [currentRuntime]);
    api.configurationLifecycle.mockResolvedValue({ mutationId: "pending-command", state: "unknown", runtime: currentRuntime });
    const navigation = createRef<ExecutionSettingsNavigation>();
    render(<ExecutionSettings controls={api} navigationRef={navigation} />);
    fireEvent.click(await screen.findByRole("button", { name: "Build host details" }));
    fireEvent.click(screen.getByRole("button", { name: "Activity & diagnostics" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Runtime actions for Build host" }));
    await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search environments" }), { target: { value: "Local" } });
    expect(screen.queryByRole("button", { name: "Build host details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh status" })).toBeNull();
    act(() => navigation.current!.openPage("backends"));
    expect(screen.getByRole("heading", { name: "Backends" })).toBeVisible();
    act(() => navigation.current!.openPage("environments"));
    expect(screen.getByRole("textbox", { name: "Search environments" })).toHaveValue("Local");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Build host details" }));
    fireEvent.click(screen.getByRole("button", { name: "Activity & diagnostics" }));
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Runtime actions for Build host" })).toBeDisabled();
    expect(api.configurationLifecycle).toHaveBeenCalledOnce();
  });

  it("keeps disabled backends identifiable while their connection details stay in the detail screen", async () => {
    const document = configuration();
    const backend = backendEditors.codex_app_server.createBackend("codex-local");
    backend.label = "Personal Codex";
    backend.enabled = false;
    document.backends.push(backend);
    document.targets.push(backendEditors.codex_app_server.createTarget("codex-target", backend.id, localId));
    render(<ExecutionSettings initialPage="backends" controls={controls(document, [runtime({ resourceKind: "backend", resourceId: backend.id,
      preference: "disconnected", connectionState: "disconnected", supportedActions: [],
    })])} />);
    const summary = await screen.findByRole("button", { name: "Personal Codex details" });
    expect(summary.closest("tr")).toHaveTextContent("Disabled");
    expect(summary.closest("tr")).toHaveTextContent("Intentionally disconnected");
    expect(screen.getByRole("button", { name: "Edit Personal Codex" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Remove Personal Codex" })).toBeNull();
    fireEvent.click(summary);
    expect(screen.getByRole("button", { name: "Remove Personal Codex" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit Personal Codex" }));
    expect(screen.getByLabelText("Backend name")).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Configured backends" })).toBeNull();
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
    render(<ExecutionSettings initialPage="backends" controls={api} />);
    const localGroup = await screen.findByRole("region", { name: "Local backends" });
    const remoteGroup = screen.getByRole("region", { name: "Build host backends" });
    expect(within(localGroup).getByRole("button", { name: "Personal assistant details" })).toBeVisible();
    const pendingRow = within(remoteGroup).getByRole("button", { name: "Build agent details" }).closest("tr")!;
    expect(pendingRow).toBeVisible();
    expect(within(pendingRow).getAllByText("Changes pending")).toHaveLength(1);
    expect(within(pendingRow).getByText("Connected")).toBeVisible();
    expect(within(remoteGroup).getByRole("button", { name: "Archived agent details" })).toBeVisible();
    for (const [query, expected] of [["  RELEASE  ", "Build agent"], ["Pi SDK", "Personal assistant"], ["personal", "Personal assistant"]]) {
      fireEvent.change(screen.getByRole("textbox", { name: "Search backends" }), { target: { value: query } });
      const inventory = screen.getByRole("region", { name: "Configured backends" });
      expect(within(inventory).getByRole("status")).toHaveTextContent("1 backend across environments");
      expect(within(inventory).getByRole("button", { name: `${expected} details` })).toBeVisible();
    }
    fireEvent.change(screen.getByRole("textbox", { name: "Search backends" }), { target: { value: "build-host" } });
    expect(screen.queryByRole("region", { name: "Local backends" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter by environment"), { target: { value: remoteId } });
    fireEvent.change(screen.getByLabelText("Filter by provider"), { target: { value: "codex_app_server" } });
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "attention" } });
    expect(screen.getByRole("button", { name: "Build agent details" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Archived agent details" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "disabled" } });
    expect(screen.getByText("No backends match these filters.")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("textbox", { name: "Search backends" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Search backends" })).toHaveValue("");
    expect(screen.getByLabelText("Filter by environment")).toHaveValue("");
    expect(screen.getByLabelText("Filter by provider")).toHaveValue("");
    for (const status of ["disabled", "stopped"]) {
      fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: status } });
      expect(screen.getByRole("button", { name: "Archived agent details" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Build agent details" })).toBeNull();
    }
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "connected" } });
    expect(screen.getByRole("button", { name: "Build agent details" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Personal assistant details" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Archived agent details" })).toBeNull();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("includes a disabled backend with a connected runtime in Needs attention", async () => {
    const document = configuration();
    const backend = { ...backendEditors.pi.createBackend("disabled-running-pi"), label: "Disabled but running", enabled: false };
    document.backends.push(backend);
    document.targets.push({ ...backendEditors.pi.createTarget("disabled-target", backend.id, localId), enabled: false });
    render(<ExecutionSettings initialPage="backends" controls={controls(document, [runtime({ resourceKind: "backend", resourceId: backend.id })])} />);
    await screen.findByRole("button", { name: "Disabled but running details" });
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "attention" } });
    const row = screen.getByRole("button", { name: "Disabled but running details" }).closest("tr")!;
    expect(within(row).getByText("Connected")).toBeVisible();
    expect(within(row).getByText("Backend disabled")).toBeVisible();
    expect(within(row).getByText("Applied")).toBeVisible();
  });

  it("prefills scoped backend creation and saves every connection in the selected environment", async () => {
    const api = controls();
    render(<ExecutionSettings controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Build host details" }));
    expect(screen.queryByLabelText("Filter by environment")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add backend" }));
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
    expect(saved.targets.every((entry: { executionEnvironmentId: string }) => entry.executionEnvironmentId === remoteId)).toBe(true);
    expect(saved.defaultTargetId).toBe(saved.targets[0]!.id);
    expect(await screen.findByRole("heading", { name: "Build host" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remote builder details" })).toHaveFocus();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("preserves environment search and keyboard focus when returning from details or an editor", async () => {
    render(<ExecutionSettings controls={controls()} />);
    await screen.findByRole("button", { name: "Build host details" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search environments" }), { target: { value: "build-host" } });
    fireEvent.click(screen.getByRole("button", { name: "Build host details" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("textbox", { name: "Search environments" })).toHaveValue("build-host");
    expect(screen.getByRole("button", { name: "Build host details" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Local details" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Build host" }));
    expect(screen.getByLabelText("Environment name")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: "Search environments" })).toHaveValue("build-host");
    expect(screen.getByRole("button", { name: "Build host details" })).toHaveFocus();
  });

  it("guards dirty edits when navigating between sections or leaving settings", async () => {
    const navigation = createRef<ExecutionSettingsNavigation>();
    const onPageChange = vi.fn();
    const leave = vi.fn();
    const api = controls();
    render(<ExecutionSettings controls={api} navigationRef={navigation} onPageChange={onPageChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Local" }));
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Unsaved local name" } });
    act(() => navigation.current!.openPage("backends"));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();
    expect(onPageChange).not.toHaveBeenCalledWith("backends");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Environment name")).toHaveValue("Unsaved local name");
    act(() => navigation.current!.requestLeave(leave));
    expect(leave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("button", { name: "Local details" })).toHaveFocus();
    expect(screen.queryByLabelText("Environment name")).toBeNull();
    act(() => navigation.current!.requestLeave(leave));
    expect(leave).toHaveBeenCalledOnce();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it.each([false, true])("Refresh preserves an open environment editor (dirty: %s)", async (dirty) => {
    const api = controls();
    render(<ExecutionSettings controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Local" }));
    if (dirty) fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Unsaved name" } });
    const field = screen.getByLabelText("Environment name");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.readConfiguration).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.listHostRegistrations).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Environment name")).toBe(field);
    expect(field).toHaveValue(dirty ? "Unsaved name" : "Local");
    expect(screen.getByRole("region", { name: "Environment editor" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it.each(["global", "environment"])("confirms removal of a default backend and returns to the originating %s inventory", async (origin) => {
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
    const api = controls(document);
    render(<ExecutionSettings controls={api} initialPage={origin === "global" ? "backends" : "environments"} />);
    if (origin === "environment") fireEvent.click(await screen.findByRole("button", { name: "Build host details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Build Pi details" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove Build Pi" }));
    const confirmation = screen.getByRole("group", { name: "Confirm configuration change" });
    expect(confirmation).toHaveFocus();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Remove Build Pi" })).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Confirm configuration change" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove Build Pi" }));
    await user.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    expect(api.saveConfiguration.mock.calls[0]![0]).toMatchObject({ expectedRevision: 4, configuration: {
      backends: [retained], targets: [document.targets[2]], defaultTargetId: null,
      executionEnvironments: document.executionEnvironments,
    } });
    const heading = await screen.findByRole("heading", { name: origin === "global" ? "Backends" : "Build host" });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("region", { name: "Configured backends" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Build Pi details" })).toBeNull();
    if (origin === "global") expect(screen.getByRole("button", { name: "Keep Pi details" })).toBeVisible();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("removes an unreferenced environment only after confirmation and returns to the environment list", async () => {
    const document = configuration();
    const api = controls(document);
    render(<ExecutionSettings controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Build host details" }));
    fireEvent.click(screen.getByRole("button", { name: "Activity & diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Build host" }));
    expect(screen.getByRole("group", { name: "Confirm configuration change" })).toHaveFocus();
    expect(api.saveConfiguration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    expect(api.saveConfiguration.mock.calls[0]![0]).toMatchObject({ expectedRevision: 4, configuration: {
      executionEnvironments: [document.executionEnvironments[0]], backends: [], targets: [], defaultTargetId: null,
    } });
    expect(await screen.findByRole("heading", { name: "Execution environments" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Local details" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Build host details" })).toBeNull();
  });

  it("blocks a removal confirmation when another session changes the configuration revision", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const api = controls();
    render(<ExecutionSettings controls={api} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Build host details" }));
    fireEvent.click(screen.getByRole("button", { name: "Activity & diagnostics" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Build host" }));
    expect(screen.getByRole("button", { name: "Confirm removal" })).toBeEnabled();
    const changed = configuration();
    changed.executionEnvironments[1]!.label = "Renamed by another session";
    api.readConfiguration.mockResolvedValue({ revision: 5, configuration: changed, runtimes: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByRole("button", { name: "Confirm removal" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Configuration changed in another session");
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    expect(api.saveConfiguration).not.toHaveBeenCalled();
  });

  it("distinguishes an empty environment from filtered results and clears a removed environment filter", async () => {
    const document = configuration();
    const backend = { ...backendEditors.pi.createBackend("local-pi"), label: "Local Pi" };
    document.backends.push(backend);
    document.targets.push(backendEditors.pi.createTarget("local-target", backend.id, localId));
    const api = controls(document);
    const navigation = createRef<ExecutionSettingsNavigation>();
    render(<ExecutionSettings controls={api} navigationRef={navigation} />);
    fireEvent.click(await screen.findByRole("button", { name: "Build host details" }));
    expect(screen.getByText("No backends in this environment. Add a backend to make a provider available.")).toBeVisible();
    expect(screen.queryByText("No backends match these filters.")).toBeNull();
    act(() => navigation.current!.openPage("backends"));
    fireEvent.change(screen.getByLabelText("Filter by environment"), { target: { value: remoteId } });
    expect(screen.getByText("No backends in this environment. Add a backend to make a provider available.")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Search backends" }), { target: { value: "missing" } });
    expect(screen.getByText("No backends match these filters.")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Search backends" }), { target: { value: "" } });
    api.readConfiguration.mockResolvedValue({ revision: 5, configuration: {
      ...document, executionEnvironments: document.executionEnvironments.filter(entry => entry.id !== remoteId),
    }, runtimes: [] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByLabelText("Filter by environment")).toHaveValue(""));
    expect(screen.getByRole("button", { name: "Local Pi details" })).toBeVisible();
    expect(screen.queryByText("No backends match these filters.")).toBeNull();
  });

  it("does not rebase dirty edits when a hidden lifecycle receipt settles at a newer revision", async () => {
    vi.useFakeTimers();
    const mutationId = "20000000-0000-4000-8000-000000000001";
    const pendingRuntime = runtime({ lifecycleOperation: { mutationId, action: "disconnect", state: "pending" } });
    const api = controls(configuration(), [pendingRuntime]);
    render(<ExecutionSettings controls={api} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Edit Local" }));
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

  it("creates typed SSH configuration and keeps tool/context grants paired", async () => {
    const api = controls();
    render(<ExecutionSettings controls={api} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add environment" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add environment" }));
    fireEvent.click(screen.getByRole("button", { name: /^SSH host/ }));
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "New host" } });
    fireEvent.change(screen.getByLabelText("SSH host alias"), { target: { value: "new-host" } });
    fireEvent.change(screen.getByLabelText("Workspace roots"), { target: { value: "/work/projects\n/work/scratch" } });
    fireEvent.click(screen.getByLabelText("Workspace tools and context"));
    fireEvent.click(screen.getByLabelText("Interactive terminals"));
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    const request = api.saveConfiguration.mock.calls[0]![0];
    expect(request.expectedRevision).toBe(4);
    expect(request).not.toHaveProperty("principalId");
    expect(request.configuration.executionEnvironments[2]).toMatchObject({
      kind: "ssh", label: "New host", hostAlias: "new-host", workspaceRoots: ["/work/projects", "/work/scratch"],
      operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files", "workspace_tools", "workspace_context", "interactive_terminal"] },
    });
    expect(request.configuration.executionEnvironments[2]).not.toHaveProperty("operations.carrier");
    expect(await screen.findByText(/Configuration saved\. Runtime status/)).toBeVisible();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("retains edits after a conflict but requires discarding them before loading a fresh revision", async () => {
    const api = controls();
    api.saveConfiguration.mockRejectedValueOnce(new ApiError(409, "conflict", "Configuration changed in another session.", false));
    render(<ExecutionSettings controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Local details" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Local" }));
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "My edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Configuration changed in another session.");
    expect(screen.getByLabelText("Environment name")).toHaveValue("My edit");
    expect(screen.getByRole("button", { name: "Save environment" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByRole("dialog", { name: "Discard unsaved changes?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(api.readConfiguration).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText("Environment name")).not.toBeInTheDocument();
    expect(api.saveConfiguration).toHaveBeenCalledOnce();
  });

  it("preserves a rejected draft and allows correction without discarding other fields", async () => {
    const api = controls();
    api.saveConfiguration.mockRejectedValueOnce(new ApiError(400, "invalid_configuration", "Workspace roots must be canonical.", false));
    render(<ExecutionSettings controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Local details" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Local" }));
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "My edit" } });
    fireEvent.change(screen.getByLabelText("Workspace roots"), { target: { value: "/work/" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace roots must be canonical.");
    expect(screen.getByLabelText("Environment name")).toHaveValue("My edit");
    expect(screen.getByRole("button", { name: "Save environment" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Workspace roots"), { target: { value: "/work" } });
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledTimes(2));
    expect(api.saveConfiguration.mock.calls[1]![0]).toMatchObject({ expectedRevision: 4,
      configuration: { executionEnvironments: [expect.objectContaining({ label: "My edit", workspaceRoots: ["/work"] }), expect.anything()] },
    });
    expect(await screen.findByText(/Configuration saved/)).toBeVisible();
    expect(api.readConfiguration).toHaveBeenCalledOnce();
  });

  it("cannot remove an environment that still has a backend connection", async () => {
    const document = configuration();
    document.backends.push(backendEditors.pi.createBackend("pi-local"));
    document.targets.push(backendEditors.pi.createTarget("pi-remote", "pi-local", remoteId));
    render(<ExecutionSettings controls={controls(document)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Build host details" }));
    fireEvent.click(screen.getByRole("button", { name: "Activity & diagnostics" }));
    expect(screen.getByRole("button", { name: "Remove Build host" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit Build host" }));
    expect(screen.getByLabelText("SSH host alias")).toBeDisabled();
  });

  it("edits Codex WebSocket credentials as references and saves the backend with its target atomically", async () => {
    const api = controls();
    render(<ExecutionSettings initialPage="backends" controls={api} />);
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

  it("requires an environment before choosing an eligible backend and keeps Grok local", async () => {
    render(<ExecutionSettings initialPage="backends" controls={controls(configurationWithOutbound())} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add backend" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add backend" }));
    const environment = screen.getByLabelText("Execution environment");
    const provider = screen.getByLabelText("Backend type");
    expect(environment).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save backend" })).toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Save backend" })).toBeDisabled();
    fireEvent.change(provider, { target: { value: "codex_app_server" } });
    expect(screen.getByRole("button", { name: "Save backend" })).toBeEnabled();
    expect(screen.queryByRole("option", { name: "Cursor" })).toBeNull();
  });

  it.each([localId, remoteId, outboundId])("saves Claude on %s with the execution account's native configuration default", async (environmentId) => {
    const api = controls(configurationWithOutbound());
    render(<ExecutionSettings initialPage="backends" controls={api} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add backend" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add backend" }));
    fireEvent.change(screen.getByLabelText("Execution environment"), { target: { value: environmentId } });
    fireEvent.change(screen.getByLabelText("Backend type"), { target: { value: "claude_agent_sdk" } });
    fireEvent.change(screen.getByLabelText("Backend name"), { target: { value: "Claude" } });
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
    const api = controls(document);
    render(<ExecutionSettings initialPage="backends" controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remote Claude details" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Remote Claude" }));
    expect(screen.getByLabelText("Execution environment")).toBeDisabled();
    expect(screen.getByLabelText("Execution environment")).toHaveValue(remoteId);
    expect(screen.getByLabelText("Connection enabled")).toBeDisabled();
    expect(screen.queryByText(/retained remote connection is unsupported/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Claude configuration directory"), { target: { value: "/home/remote/.claude" } });
    fireEvent.click(screen.getByLabelText("Backend enabled"));
    expect(screen.getByLabelText("Connection enabled")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Connection enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save backend" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    const saved = api.saveConfiguration.mock.calls[0]![0].configuration;
    expect(saved.backends[0]).toMatchObject({ id: "claude-remote", enabled: true });
    expect(saved.targets[0]).toMatchObject({ id: "claude-target", enabled: true, executionEnvironmentId: remoteId });
  });

  it("allows metadata edits to disabled Windows Claude bindings without offering unsupported enablement", async () => {
    const document = configurationWithOutbound();
    document.executionEnvironments = document.executionEnvironments.map(entry => entry.kind === "outbound" ? { ...entry, platform: "win32", workspaceRoots: ["C:\\Projects"] } : entry);
    const backend = backendEditors.claude_agent_sdk.createBackend("claude-windows");
    backend.label = "Windows Claude"; backend.enabled = false;
    document.backends.push(backend);
    document.targets.push({ ...backendEditors.claude_agent_sdk.createTarget("windows-claude-target", backend.id, outboundId), enabled: false });
    const api = controls(document);
    render(<ExecutionSettings initialPage="backends" controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Windows Claude details" }));
    expect(screen.getByText("Remote execution is unsupported. This retained configuration cannot run here.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit Windows Claude" }));
    expect(screen.getByLabelText("Execution environment")).toHaveValue(outboundId);
    expect(screen.getByLabelText("Execution environment")).toBeDisabled();
    expect(screen.getByLabelText("Backend enabled")).toBeDisabled();
    expect(screen.getByLabelText("Connection enabled")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save backend" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Backend name"), { target: { value: "Archived Windows Claude" } });
    fireEvent.click(screen.getByRole("button", { name: "Save backend" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    const saved = api.saveConfiguration.mock.calls[0]![0].configuration;
    expect(saved.backends[0]).toMatchObject({ id: backend.id, label: "Archived Windows Claude", enabled: false });
    expect(saved.targets[0]).toMatchObject({ id: "windows-claude-target", backendInstanceId: backend.id, executionEnvironmentId: outboundId, enabled: false });
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("builds model policy rules through explicit fields and preserves identifier dimensions", async () => {
    const api = controls();
    render(<ExecutionSettings initialPage="backends" controls={api} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add backend" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add backend" }));
    fireEvent.change(screen.getByLabelText("Execution environment"), { target: { value: localId } });
    fireEvent.change(screen.getByLabelText("Backend type"), { target: { value: "pi" } });
    fireEvent.change(screen.getByLabelText("Backend name"), { target: { value: "Pi SDK" } });
    fireEvent.change(screen.getByLabelText("Available models"), { target: { value: "allowlist" } });
    fireEvent.change(screen.getByLabelText("Provider identifiers"), { target: { value: "provider-a" } });
    fireEvent.change(screen.getByLabelText("Model identifiers"), { target: { value: "model-one\nmodel-two" } });
    fireEvent.change(screen.getByLabelText("Reasoning efforts"), { target: { value: "low" } });
    fireEvent.click(screen.getByRole("button", { name: "Save backend" }));
    await waitFor(() => expect(api.saveConfiguration).toHaveBeenCalledOnce());
    expect(api.saveConfiguration.mock.calls[0]![0].configuration.backends[0]!.modelPolicy).toEqual({ type: "allowlist", allowed: [{ providerIds: ["provider-a"], modelIds: ["model-one", "model-two"], reasoningEfforts: ["low"] }] });
  });
});
