// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ConfigurationSnapshot } from "../../../shared/protocol/configuration-admin.js";
import type { HostPairingList, HostRegistration } from "../../../shared/protocol/host-pairing.js";
import { ApiError } from "../../api/ApiClient.js";
import { navigate } from "../../app/router.js";
import { ExecutionSettings } from "./ExecutionSettings.js";
import { allowedEnvironments, backendEditors } from "./backend-editors.js";
import type { ConfigurationControls } from "./useConfiguration.js";
import type { HostPairingControls } from "./useHostPairings.js";

const registration: HostRegistration = {
  id: "20000000-0000-4000-8000-000000000001", connectorId: "20000000-0000-4000-8000-000000000002",
  registrationAttemptId: "20000000-0000-4000-8000-000000000003", correlationCode: "ABCD-1234",
  metadata: { hostname: "Mac Studio", platform: "darwin", architecture: "arm64", account: "operator", connectorVersion: "1" },
  state: "pending", revision: 1, createdAt: "2026-09-12T12:00:00.000Z", updatedAt: "2026-09-12T12:00:00.000Z",
  lastSeenAt: "2026-09-12T12:00:00.000Z", expiresAt: "2026-09-13T12:00:00.000Z", pairingId: null,
};
const environment = { id: "20000000-0000-4000-8000-000000000004", kind: "outbound" as const, label: "My Mac", pairingId: "20000000-0000-4000-8000-000000000005",
  platform: "darwin" as const, workspaceRoots: ["/Users/operator/Projects"], operations: { kind: "sidecar" as const, enabledCapabilities: ["workspace_files" as const] } };
function fixture(paired = false) {
  let snapshot: ConfigurationSnapshot = { revision: 3, configuration: { executionEnvironments: paired ? [environment] : [], backends: [], targets: [], defaultTargetId: null, webSearch: null }, runtimes: [] };
  const binding = { id: environment.pairingId, connectorId: registration.connectorId, executionEnvironmentId: environment.id, platform: "darwin" as const,
    metadata: registration.metadata, state: "accepted" as const, revision: 1, createdAt: registration.createdAt, updatedAt: registration.updatedAt, lastSeenAt: registration.lastSeenAt };
  let hosts: HostPairingList = { registrations: paired ? [] : [{ ...registration, connected: false }], pairings: paired ? [{ ...binding, connected: false }] : [] };
  const api = {
    outboundConnectorSetup: () => ({ serverUrl: "http://sedes.test:4784", downloadUrl: "http://sedes.test:4784/api/outbound/connector/sedes-sidecar.mjs" }),
    listHostRegistrations: vi.fn(async () => structuredClone(hosts)),
    acceptHostRegistration: vi.fn(async request => {
      snapshot = { ...snapshot, revision: 4, configuration: { ...snapshot.configuration, executionEnvironments: [{ ...environment, label: request.label, workspaceRoots: request.workspaceRoots, operations: request.operations }] } };
      const accepted = { ...registration, state: "accepted" as const, pairingId: binding.id };
      hosts = { registrations: [{ ...accepted, connected: false }], pairings: [{ ...binding, connected: false }] };
      return { registration: accepted, pairing: binding, configuration: snapshot };
    }),
    denyHostRegistration: vi.fn(async () => { hosts = { ...hosts, registrations: [] }; return { ...registration, state: "denied" as const }; }),
    revokeHostPairing: vi.fn(async () => {
      const revoked = { ...binding, revision: 2, state: "revoked" as const };
      hosts = { ...hosts, pairings: [{ ...revoked, connected: false }] }; return { pairing: revoked, configuration: snapshot };
    }), reapproveHostPairing: vi.fn(async () => {
      const reapproved = { ...binding, revision: 3 };
      hosts = { ...hosts, pairings: [{ ...reapproved, connected: false }] }; return { pairing: reapproved, configuration: snapshot };
    }),
    readConfiguration: vi.fn(async () => structuredClone(snapshot)), saveConfiguration: vi.fn(),
    configurationLifecycleImpact: vi.fn(), configurationLifecycle: vi.fn(), getLifecycleReceipt: vi.fn(),
    listConfigurationOperations: vi.fn(), inspectConfigurationOperation: vi.fn(), acknowledgeConfigurationOperation: vi.fn(),
  } satisfies ConfigurationControls & HostPairingControls;
  return api;
}
function renderAt(path: string, api: ReturnType<typeof fixture>) {
  act(() => navigate(path, { replace: true }));
  render(<ExecutionSettings controls={api} />);
  return api;
}
const pendingPath = `/settings/environments/~pending/${registration.id}`;

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("outbound host settings", () => {
  it("lists pending hosts at the top of the environments and shows connector instructions only while pairing", async () => {
    renderAt("/settings/environments", fixture());
    const awaiting = await screen.findByRole("region", { name: "Awaiting approval" });
    expect(awaiting).toHaveTextContent("1 host");
    const row = within(awaiting).getByRole("link", { name: "Mac Studio" });
    expect(row.closest("li")).toHaveTextContent("Code ABCD-1234 · macOS arm64");
    expect(row.closest("li")).toHaveTextContent("Host offline");
    expect(screen.queryByRole("link", { name: "Download connector" })).toBeNull();
    fireEvent.click(row);
    expect(window.location.pathname).toBe(pendingPath);
    expect(screen.getByRole("region", { name: "Pending Mac Studio" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Download connector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add environment" }));
    fireEvent.click(screen.getByRole("link", { name: "Pair a host" }));
    expect(window.location.pathname).toBe("/settings/environments/~new/pair");
    const setup = screen.getByRole("region", { name: "Pair a host" });
    expect(within(setup).getByRole("link", { name: "Download connector" })).toHaveAttribute("href", "http://sedes.test:4784/api/outbound/connector/sedes-sidecar.mjs");
    expect(within(setup).getByRole("button", { name: "Copy pairing command" })).toBeVisible();
    expect(within(setup).getByRole("link", { name: "Mac Studio" })).toHaveAttribute("href", pendingPath);
  });

  it("accepts an offline Mac with explicit roots and paired tool grants, retaining its identity", async () => {
    const api = renderAt(pendingPath, fixture());
    const pending = await screen.findByRole("region", { name: "Pending Mac Studio" });
    expect(pending).toHaveTextContent("Host offline"); expect(pending).toHaveTextContent("macOS · arm64 · operator");
    expect(pending).toHaveTextContent("ABCD-1234");
    fireEvent.click(screen.getByRole("button", { name: "Accept host" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Fix the highlighted fields to accept this host.");
    expect(screen.getByRole("group", { name: "Workspace roots" })).toHaveAccessibleDescription(/Add at least one workspace root\./u);
    expect(api.acceptHostRegistration).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "My Mac" } });
    fireEvent.change(screen.getByLabelText("Workspace root 1"), { target: { value: "/Users/operator/Projects" } });
    fireEvent.click(screen.getByLabelText("Workspace tools and context"));
    fireEvent.click(screen.getByRole("button", { name: "Accept host" }));
    await waitFor(() => expect(api.acceptHostRegistration).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.location.pathname).toBe(`/settings/environments/${environment.id}`));
    expect(api.acceptHostRegistration).toHaveBeenCalledWith(expect.objectContaining({ registrationId: registration.id, expectedRegistrationRevision: 1,
      expectedConfigurationRevision: 3, workspaceRoots: ["/Users/operator/Projects"], operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files", "workspace_tools", "workspace_context"] } }));
    expect(await screen.findByRole("heading", { name: "My Mac", level: 2 })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("link", { name: "My Mac" }).closest("li")).toHaveTextContent("Host offline"));
    expect(screen.queryByRole("region", { name: "Awaiting approval" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove My Mac" }));
    const removal = screen.getByRole("dialog", { name: "Remove My Mac?" });
    expect(removal).toHaveTextContent("Revoke the pairing first.");
    expect(within(removal).getByRole("button", { name: "Remove environment" })).toBeDisabled();
    fireEvent.click(within(removal).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit My Mac" }));
    expect(screen.getByRole("group", { name: "Environment type" })).toHaveTextContent("Paired host");
    expect(screen.getByRole("group", { name: "Platform" })).toHaveTextContent("macOS");
    expect(screen.queryByRole("textbox", { name: "SSH host alias" })).toBeNull();
  });

  it("denies the exact registration after confirmation without saving an environment", async () => {
    const api = renderAt(pendingPath, fixture());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deny Mac Studio" }));
    const confirmation = screen.getByRole("dialog", { name: "Deny Mac Studio?" });
    expect(api.denyHostRegistration).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Deny host" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings/environments"));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Mac Studio" })).toBeNull());
    expect(api.denyHostRegistration).toHaveBeenCalledWith(expect.objectContaining({ registrationId: registration.id, expectedRegistrationRevision: 1 }));
    expect(api.saveConfiguration).not.toHaveBeenCalled(); expect(api.acceptHostRegistration).not.toHaveBeenCalled();
  });

  it("confirms revocation and same-binding reapproval and restores focus to the relabeled action", async () => {
    const api = renderAt(`/settings/environments/${environment.id}`, fixture(true));
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: "Revoke My Mac" });
    await user.click(trigger);
    expect(api.revokeHostPairing).not.toHaveBeenCalled();
    const revoke = screen.getByRole("dialog", { name: "Revoke My Mac?" });
    expect(within(revoke).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(revoke).toHaveTextContent(/does not stop host-owned processes/u);
    await user.click(within(revoke).getByRole("button", { name: "Revoke pairing" }));
    const reapprove = await screen.findByRole("button", { name: "Reapprove My Mac" });
    expect(reapprove).toBeEnabled();
    expect(reapprove).toBe(trigger);
    await waitFor(() => expect(reapprove).toHaveFocus());
    expect(api.revokeHostPairing).toHaveBeenCalledWith(expect.objectContaining({ pairingId: environment.pairingId, expectedPairingRevision: 1, expectedConfigurationRevision: 3 }));
    await user.click(screen.getByRole("button", { name: "Remove My Mac" }));
    expect(within(screen.getByRole("dialog", { name: "Remove My Mac?" })).getByRole("button", { name: "Remove environment" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(reapprove);
    expect(api.reapproveHostPairing).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("dialog", { name: "Reapprove My Mac?" });
    expect(within(confirmation).getByRole("button", { name: "Reapprove pairing" })).toHaveFocus();
    await user.click(within(confirmation).getByRole("button", { name: "Reapprove pairing" }));
    const revokeAgain = await screen.findByRole("button", { name: "Revoke My Mac" });
    expect(revokeAgain).toBeEnabled();
    expect(revokeAgain).toBe(trigger);
    await waitFor(() => expect(revokeAgain).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Remove My Mac" }));
    expect(within(screen.getByRole("dialog", { name: "Remove My Mac?" })).getByRole("button", { name: "Remove environment" })).toBeDisabled();
    expect(api.reapproveHostPairing).toHaveBeenCalledWith(expect.objectContaining({ pairingId: environment.pairingId, expectedPairingRevision: 2, expectedConfigurationRevision: 3 }));
  });

  it("preserves the acceptance editor and requires refresh after a conflicting decision", async () => {
    const api = fixture(); api.acceptHostRegistration.mockRejectedValueOnce(new ApiError(409, "conflict", "Registration changed.", false));
    renderAt(pendingPath, api);
    fireEvent.change(await screen.findByLabelText("Workspace root 1"), { target: { value: "/Users/operator/Projects" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept host" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh before trying again");
    expect(screen.getByLabelText("Workspace root 1")).toHaveValue("/Users/operator/Projects");
    expect(screen.getByRole("button", { name: "Accept host" })).toBeDisabled();
    expect(window.location.pathname).toBe(pendingPath);
  });

  it("keeps Windows Files and supported backends eligible while rejecting native Windows Claude", () => {
    const windows = { ...environment, platform: "win32" as const, workspaceRoots: ["C:\\Projects"] };
    for (const kind of ["pi", "codex_app_server"] as const) expect(allowedEnvironments(backendEditors[kind].createBackend(kind), [windows])).toEqual([windows]);
    for (const kind of ["claude_agent_sdk", "grok_build"] as const) expect(allowedEnvironments(backendEditors[kind].createBackend(kind), [windows])).toEqual([]);
  });

  it("gives every compiled backend truthful outbound environment eligibility", () => {
    for (const kind of ["pi", "codex_app_server", "claude_agent_sdk"] as const) expect(allowedEnvironments(backendEditors[kind].createBackend(kind), [environment])).toEqual([environment]);
    for (const kind of ["grok_build"] as const) expect(allowedEnvironments(backendEditors[kind].createBackend(kind), [environment])).toEqual([]);
  });
});
