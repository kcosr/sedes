// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ConfigurationSnapshot } from "../../../shared/protocol/configuration-admin.js";
import type { HostPairingList, HostRegistration } from "../../../shared/protocol/host-pairing.js";
import { ApiError } from "../../api/ApiClient.js";
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
afterEach(cleanup);

describe("outbound host settings", () => {
  it("keeps pending hosts compact and shows connector instructions only during host setup", async () => {
    render(<ExecutionSettings controls={fixture()} />);
    expect(await screen.findByText("1 host awaiting approval")).toBeVisible();
    expect(screen.queryByRole("article", { name: "Pending Mac Studio" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Download connector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review hosts" }));
    expect(screen.getByRole("article", { name: "Pending Mac Studio" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Download connector" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Add environment" }));
    fireEvent.click(screen.getByRole("button", { name: /^Pair a host/ }));
    expect(screen.getByRole("link", { name: "Download connector" })).toHaveAttribute("href", "http://sedes.test:4784/api/outbound/connector/sedes-sidecar.mjs");
    expect(screen.getByRole("article", { name: "Pending Mac Studio" })).toBeVisible();
  });

  it("accepts an offline Mac with explicit roots and paired tool grants, retaining its identity", async () => {
    const api = fixture(); render(<ExecutionSettings controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review hosts" }));
    const pending = await screen.findByRole("article", { name: "Pending Mac Studio" });
    expect(pending).toHaveTextContent("Host offline"); expect(pending).toHaveTextContent("macOS · arm64");
    fireEvent.click(within(pending).getByRole("button", { name: "Accept Mac Studio" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept host" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("workspaceRoots"); expect(api.acceptHostRegistration).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "My Mac" } });
    fireEvent.change(screen.getByLabelText("Workspace roots"), { target: { value: "/Users/operator/Projects" } });
    fireEvent.click(screen.getByLabelText("Workspace tools and context"));
    fireEvent.click(screen.getByRole("button", { name: "Accept host" }));
    await waitFor(() => expect(api.acceptHostRegistration).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Accept host" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const summary = await screen.findByRole("button", { name: "My Mac details" }); expect(summary.closest("tr")).toHaveTextContent("Host offline");
    expect(api.acceptHostRegistration).toHaveBeenCalledWith(expect.objectContaining({ registrationId: registration.id, expectedRegistrationRevision: 1,
      expectedConfigurationRevision: 3, workspaceRoots: ["/Users/operator/Projects"], operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files", "workspace_tools", "workspace_context"] } }));
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole("button", { name: "Activity & diagnostics" }));
    expect(screen.getByRole("button", { name: "Remove My Mac" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit My Mac" }));
    expect(screen.getByLabelText("Environment type")).toHaveValue("outbound"); expect(screen.getByLabelText("Environment type")).toBeDisabled();
    expect(screen.queryByLabelText("SSH host alias")).toBeNull();
  });

  it("denies the exact registration without saving an environment", async () => {
    const api = fixture(); render(<ExecutionSettings controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review hosts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Deny Mac Studio" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Pending Mac Studio" })).toBeNull());
    expect(api.denyHostRegistration).toHaveBeenCalledWith(expect.objectContaining({ registrationId: registration.id, expectedRegistrationRevision: 1 }));
    expect(api.saveConfiguration).not.toHaveBeenCalled(); expect(api.acceptHostRegistration).not.toHaveBeenCalled();
  });

  it("confirms revocation and same-binding reapproval and restores focus to the relabeled action", async () => {
    const api = fixture(true); render(<ExecutionSettings controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "My Mac details" }));
    fireEvent.click(screen.getByRole("button", { name: "Activity & diagnostics" }));
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Revoke My Mac" });
    await user.click(trigger);
    expect(api.revokeHostPairing).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm configuration change" })).toHaveFocus();
    expect(screen.getByText(/does not stop host-owned processes/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm revocation" }));
    const reapprove = await screen.findByRole("button", { name: "Reapprove My Mac" });
    expect(reapprove).toBeEnabled();
    expect(reapprove).toBe(trigger);
    expect(reapprove).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remove My Mac" })).toBeEnabled();
    expect(api.revokeHostPairing).toHaveBeenCalledWith(expect.objectContaining({ pairingId: environment.pairingId, expectedPairingRevision: 1, expectedConfigurationRevision: 3 }));
    await user.click(reapprove);
    expect(api.reapproveHostPairing).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm configuration change" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Confirm reapproval" }));
    const revoke = await screen.findByRole("button", { name: "Revoke My Mac" });
    expect(revoke).toBeEnabled();
    expect(revoke).toBe(trigger);
    expect(revoke).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remove My Mac" })).toBeDisabled();
    expect(api.reapproveHostPairing).toHaveBeenCalledWith(expect.objectContaining({ pairingId: environment.pairingId, expectedPairingRevision: 2, expectedConfigurationRevision: 3 }));
  });

  it("preserves the acceptance editor and requires refresh after a conflicting decision", async () => {
    const api = fixture(); api.acceptHostRegistration.mockRejectedValueOnce(new ApiError(409, "conflict", "Registration changed.", false));
    render(<ExecutionSettings controls={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review hosts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept Mac Studio" }));
    fireEvent.change(screen.getByLabelText("Workspace roots"), { target: { value: "/Users/operator/Projects" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept host" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh before trying again");
    expect(screen.getByLabelText("Workspace roots")).toHaveValue("/Users/operator/Projects");
    expect(screen.getByRole("button", { name: "Accept host" })).toBeDisabled();
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
