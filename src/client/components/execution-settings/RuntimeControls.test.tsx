// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationLifecycleImpact, ConfigurationLifecycleRequest, ConfigurationLifecycleResult, ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";
import { ApiError } from "../../api/ApiClient.js";
import { RuntimeControls } from "./RuntimeControls.js";
import type { ConfigurationControls } from "./useConfiguration.js";

const runtime: ConfigurationRuntimeState = {
  resourceKind: "environment", resourceId: "environment-one", desiredRevision: 7, effectiveRevision: 6,
  applyState: "pending", preference: "automatic", connectionState: "connected", incarnation: "sidecar-incarnation-one",
  softwareVersion: "1", upgradeState: "required", activeResources: 2, lastError: null,
  supportedActions: ["connect", "disconnect", "stop", "restart", "upgrade"],
};
const impact: ConfigurationLifecycleImpact = {
  token: "exact-impact-token", resourceKind: "environment", resourceId: runtime.resourceId, action: "upgrade",
  configurationRevision: 7, incarnation: runtime.incarnation, activeResources: 2,
  interruptions: ["Codex turn will be interrupted", "Terminal shell will end"], expiresAt: "2026-09-09T23:59:00.000Z",
};
function controls() {
  return { readConfiguration: vi.fn(), saveConfiguration: vi.fn(), configurationLifecycleImpact: vi.fn(async () => ({ ...impact, expiresAt: new Date(Date.now() + 120_000).toISOString() })),
    configurationLifecycle: vi.fn(async (request: ConfigurationLifecycleRequest): Promise<ConfigurationLifecycleResult> => ({ mutationId: request.mutationId, state: "pending", runtime })),
    getLifecycleReceipt: vi.fn(async (mutationId: string): Promise<ConfigurationLifecycleResult> => ({ mutationId, state: "applied", runtime })),
    listConfigurationOperations: vi.fn(), inspectConfigurationOperation: vi.fn(), acknowledgeConfigurationOperation: vi.fn(),
  } satisfies ConfigurationControls;
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function chooseDisconnect() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Runtime actions for Build host" }));
  await user.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
}
const moreActions = () => screen.getByRole("button", { name: "Runtime actions for Build host" });

describe("runtime administration controls", () => {
  it.each(["pending", "unknown"] as const)("restores a %s command after Settings remounts without replaying it", async state => {
    const api = controls();
    const mutationId = "e1d9bfa4-20bc-4903-9763-6117b41a6d70";
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, lifecycleOperation: { mutationId, action: "upgrade", state } }} disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn(async () => true)} />);
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    expect(moreActions()).toBeDisabled();
    expect(Boolean(screen.queryByRole("button", { name: "Stop" }))).toBe(state === "unknown");
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(api.getLifecycleReceipt).toHaveBeenCalledWith(mutationId));
    await waitFor(() => expect(moreActions()).toBeEnabled());
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("retries a settled receipt when configuration refresh is temporarily busy without repeating the command", async () => {
    vi.useFakeTimers();
    const api = controls();
    const mutationId = "pending-during-save";
    const refresh = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, lifecycleOperation: { mutationId, action: "upgrade", state: "pending" } }} disabled={false} onRuntime={vi.fn()} onRefresh={refresh} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(api.getLifecycleReceipt).toHaveBeenCalledTimes(1);
    expect(moreActions()).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(api.getLifecycleReceipt).toHaveBeenCalledTimes(2);
    expect(moreActions()).toBeEnabled();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("returns focus to the Actions trigger after cancelling a menu-initiated interruption", async () => {
    const user = userEvent.setup();
    const api = controls();
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, upgradeState: "current", applyState: "applied" }} disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn(async () => true)} />);
    await user.click(moreActions());
    await user.click(await screen.findByRole("menuitem", { name: "Restart" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(moreActions()).toHaveFocus();
  });

  it("previews Stop for an unknown command and retains its original receipt if supersession is rejected", async () => {
    const api = controls();
    const mutationId = "e1d9bfa4-20bc-4903-9763-6117b41a6d70";
    api.configurationLifecycleImpact.mockResolvedValue({ ...impact, action: "stop", expiresAt: new Date(Date.now() + 120_000).toISOString() });
    api.configurationLifecycle.mockRejectedValueOnce(new ApiError(409, "conflict", "The earlier command is still running.", false));
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, lifecycleOperation: { mutationId, action: "upgrade", state: "unknown" } }} disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn(async () => true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText(/2 affected resources/)).toBeVisible();
    expect(screen.getByText(/Unrecovered output or results may be lost/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(api.configurationLifecycle).toHaveBeenCalledOnce());
    expect(api.configurationLifecycle.mock.calls[0]![0]).toMatchObject({ action: "stop", impactToken: impact.token });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(api.getLifecycleReceipt).toHaveBeenCalledWith(mutationId));
  });

  it("keeps the earlier unknown receipt when an admitted Stop returns a settled rejection", async () => {
    const api = controls();
    const originalId = "e1d9bfa4-20bc-4903-9763-6117b41a6d70";
    const unresolved: ConfigurationRuntimeState = { ...runtime, lifecycleOperation: { mutationId: originalId, action: "upgrade", state: "unknown" } };
    api.configurationLifecycleImpact.mockResolvedValue({ ...impact, action: "stop", expiresAt: new Date(Date.now() + 120_000).toISOString() });
    api.configurationLifecycle.mockImplementation(async request => ({ mutationId: request.mutationId, state: "rejected", runtime: { ...runtime, lastError: "Earlier command is still accepted on the host." } }));
    const refresh = vi.fn<() => Promise<boolean>>(async () => {
      view.rerender(<RuntimeControls {...props} runtime={{ ...unresolved, desiredRevision: 8 }} revision={8} />);
      return true;
    });
    const props = { controls: api, resourceKind: "environment" as const, resourceId: runtime.resourceId, label: "Build host", disabled: false, onRuntime: vi.fn(), onRefresh: refresh };
    const view = render(<RuntimeControls {...props} runtime={unresolved} revision={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(moreActions()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(api.getLifecycleReceipt).toHaveBeenCalledWith(originalId));
    expect(api.configurationLifecycle).toHaveBeenCalledOnce();
  });

  it.each(["network", "server"] as const)("restores the earlier receipt after a %s failure when the new Stop was never admitted", async failure => {
    const api = controls();
    const originalId = "e1d9bfa4-20bc-4903-9763-6117b41a6d70";
    api.configurationLifecycleImpact.mockResolvedValue({ ...impact, action: "stop", expiresAt: new Date(Date.now() + 120_000).toISOString() });
    api.configurationLifecycle.mockRejectedValueOnce(failure === "network" ? new Error("Connection lost") : new ApiError(503, "unavailable", "Server unavailable", true));
    api.getLifecycleReceipt.mockRejectedValueOnce(new ApiError(404, "not_found", "No receipt", false));
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, lifecycleOperation: { mutationId: originalId, action: "upgrade", state: "unknown" } }} disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn(async () => true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(api.configurationLifecycle).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    const stopMutationId = api.configurationLifecycle.mock.calls[0]![0].mutationId;
    expect(stopMutationId).not.toBe(originalId);
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(api.getLifecycleReceipt).toHaveBeenCalledWith(stopMutationId));
    await expect(screen.findByText("No new operation was admitted. The earlier operation still has an unconfirmed outcome.")).resolves.toBeVisible();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(moreActions()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(api.getLifecycleReceipt).toHaveBeenLastCalledWith(originalId));
    expect(api.configurationLifecycle).toHaveBeenCalledOnce();
  });

  it("offers one state-driven primary action and hides actions the state cannot use", async () => {
    const user = userEvent.setup();
    const api = controls();
    const view = render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={runtime} disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Build host runtime details", "Upgrade and restart", "Runtime actions for Build host"]);
    expect(screen.getByText(/incompatible with this server/)).toBeVisible();
    view.rerender(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, connectionState: "stopped", preference: "stopped", upgradeState: "current", applyState: "applied", supportedActions: ["connect", "disconnect", "start", "stop", "restart", "upgrade"] }}
      disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Runtime actions for Build host" })).toBeEnabled();
    expect(screen.getByText("Intentionally stopped")).toBeVisible();
    view.rerender(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, connectionState: "unreachable", upgradeState: "current", applyState: "unavailable" }} disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeEnabled();
    expect(screen.getByText(/Stop only records that the sidecar should not start automatically/)).toBeVisible();
    await user.click(moreActions());
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Retry connection", "Disconnect", "Stop"]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    view.rerender(<RuntimeControls controls={api} revision={7} resourceKind="backend" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, resourceKind: "backend", connectionState: "unreachable", upgradeState: "current", applyState: "unavailable", supportedActions: ["connect", "start", "stop", "restart"] }}
      disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeEnabled();
    await user.click(moreActions());
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Retry connection", "Stop"]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    view.rerender(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, connectionState: "recovery_required", upgradeState: "current", applyState: "applied", supportedActions: ["connect", "disconnect", "start", "stop", "restart", "upgrade"] }}
      disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeEnabled();
    await user.click(moreActions());
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Retry connection", "Disconnect", "Stop"]);
  });

  it("explains paused controls and keeps diagnostics behind a details disclosure", async () => {
    const user = userEvent.setup();
    render(<RuntimeControls controls={controls()} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={runtime} disabled disabledReason="Refresh the configuration before issuing runtime commands." onRuntime={vi.fn()} onRefresh={vi.fn()} />);
    const primary = screen.getByRole("button", { name: "Upgrade and restart" });
    expect(primary).toBeDisabled();
    expect(primary).toHaveAccessibleDescription("Refresh the configuration before issuing runtime commands.");
    expect(screen.getByRole("status")).toHaveTextContent("Refresh the configuration");
    expect(screen.queryByText("Saved revision")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Build host runtime details" }));
    expect(screen.getByText("Saved revision")).toBeVisible();
    expect(screen.getByText("Pending application")).toBeVisible();
  });
  it("shows incompatible status and confirms the exact impact before upgrade", async () => {
    const api = controls();
    const onRuntime = vi.fn();
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={runtime} disabled={false} onRuntime={onRuntime} onRefresh={vi.fn()} />);
    expect(screen.getByText("Upgrade required")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade and restart" }));
    expect(await screen.findByText("Terminal shell will end")).toBeVisible();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
    expect(api.configurationLifecycleImpact).toHaveBeenCalledWith({ resourceKind: "environment", resourceId: runtime.resourceId, action: "upgrade", expectedRevision: 7 });
    fireEvent.click(screen.getByRole("button", { name: "Confirm upgrade and restart" }));
    await waitFor(() => expect(api.configurationLifecycle).toHaveBeenCalledOnce());
    expect(api.configurationLifecycle.mock.calls[0]![0]).toMatchObject({
      expectedRevision: 7, resourceKind: "environment", resourceId: runtime.resourceId, action: "upgrade", expectedIncarnation: runtime.incarnation, impactToken: impact.token,
    });
    expect(await screen.findByText(/Operation pending/)).toBeVisible();
    expect(onRuntime).toHaveBeenCalledWith(runtime);
    expect(screen.queryByText("Confirmed stopped")).toBeNull();
  });

  it("applies an explicit safe-idle upgrade without an interruption prompt", async () => {
    const api = controls();
    api.configurationLifecycleImpact.mockResolvedValue({ ...impact, expiresAt: new Date(Date.now() + 120_000).toISOString(), activeResources: 0, interruptions: [] });
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, activeResources: 0 }} disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Upgrade and restart" }));
    await waitFor(() => expect(api.configurationLifecycle).toHaveBeenCalledOnce());
    expect(screen.queryByRole("group", { name: "Confirm runtime interruption" })).toBeNull();
    expect(api.configurationLifecycle.mock.calls[0]![0].impactToken).toBe(impact.token);
  });

  it("does not repeat an uncertain command or clear its gate after a failed refresh", async () => {
    const api = controls();
    api.configurationLifecycle.mockRejectedValueOnce(new Error("Connection lost"));
    const refresh = vi.fn(async () => false);
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={{ ...runtime, lastError: "Confirm the previous sidecar and its children have stopped." }} disabled={false} onRuntime={vi.fn()} onRefresh={refresh} />);
    await chooseDisconnect();
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(screen.getByRole("alert")).toHaveTextContent("Confirm the previous sidecar and its children have stopped.");
    expect(moreActions()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const mutationId = api.configurationLifecycle.mock.calls[0]![0].mutationId;
    expect(api.getLifecycleReceipt).toHaveBeenCalledWith(mutationId);
    expect(api.getLifecycleReceipt.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]!);
    expect(moreActions()).toBeDisabled();
    refresh.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(moreActions()).toBeEnabled());
    expect(api.configurationLifecycle).toHaveBeenCalledOnce();
    expect(api.getLifecycleReceipt).toHaveBeenNthCalledWith(2, mutationId);
  });

  it("retains pending and unknown receipts until the original operation settles", async () => {
    const api = controls();
    api.getLifecycleReceipt.mockImplementationOnce(async (mutationId) => ({ mutationId, state: "unknown", runtime }));
    const refresh = vi.fn(async () => true);
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={runtime} disabled={false} onRuntime={vi.fn()} onRefresh={refresh} />);
    await chooseDisconnect();
    expect(await screen.findByRole("status")).toHaveTextContent("Operation pending");
    expect(moreActions()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("outcome is unknown");
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled());
    expect(moreActions()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(moreActions()).toBeEnabled());
    expect(api.configurationLifecycle).toHaveBeenCalledOnce();
    const mutationId = api.configurationLifecycle.mock.calls[0]![0].mutationId;
    expect(api.getLifecycleReceipt.mock.calls).toEqual([[mutationId], [mutationId]]);
  });

  it("keeps an uncertain delivery gated when its receipt cannot be read", async () => {
    const api = controls();
    api.configurationLifecycle.mockRejectedValueOnce(new Error("Connection lost"));
    api.getLifecycleReceipt.mockRejectedValueOnce(new Error("Receipt unavailable"));
    const refresh = vi.fn(async () => true);
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={runtime} disabled={false} onRuntime={vi.fn()} onRefresh={refresh} />);
    await chooseDisconnect();
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Receipt unavailable");
    expect(moreActions()).toBeDisabled();
    expect(refresh).not.toHaveBeenCalled();
    expect(api.configurationLifecycle).toHaveBeenCalledOnce();
  });

  it("releases a rejected command only after receipt lookup proves it was never admitted", async () => {
    const api = controls();
    api.configurationLifecycle.mockRejectedValueOnce(new ApiError(409, "impact_expired", "Preview expired", false));
    api.getLifecycleReceipt.mockRejectedValueOnce(new ApiError(404, "not_found", "No receipt", false));
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={runtime} disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn(async () => true)} />);
    await chooseDisconnect();
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview expired");
    expect(moreActions()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByRole("status")).toHaveTextContent("No operation was admitted");
    expect(moreActions()).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Refresh status" })).not.toBeInTheDocument();
    expect(api.configurationLifecycle).toHaveBeenCalledOnce();
  });

  it.each([false, true])("expires an interruption preview before confirmation (paused timer: %s)", async (pausedTimer) => {
    vi.useFakeTimers();
    const api = controls();
    render(<RuntimeControls controls={api} revision={7} resourceKind="environment" resourceId={runtime.resourceId} label="Build host"
      runtime={runtime} disabled={false} onRuntime={vi.fn()} onRefresh={vi.fn(async () => true)} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Upgrade and restart" })); });
    expect(screen.getByRole("button", { name: "Confirm upgrade and restart" })).toBeEnabled();
    if (pausedTimer) {
      vi.setSystemTime(Date.now() + 120_000);
      fireEvent.click(screen.getByRole("button", { name: "Confirm upgrade and restart" }));
    } else {
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    }
    expect(screen.queryByRole("group", { name: "Confirm runtime interruption" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("preview expired");
    expect(screen.getByRole("button", { name: "Upgrade and restart" })).toBeEnabled();
    expect(api.configurationLifecycle).not.toHaveBeenCalled();
  });

  it("reloads the configuration revision after a settled lifecycle response before another command", async () => {
    const api = controls();
    api.configurationLifecycle.mockImplementation(async (request) => ({ mutationId: request.mutationId, state: "applied", runtime: { ...runtime, desiredRevision: 8 } }));
    let finishRefresh: (value: boolean) => void = () => {};
    const refresh = vi.fn(() => new Promise<boolean>((resolve) => { finishRefresh = resolve; }));
    const disconnected: ConfigurationRuntimeState = { ...runtime, connectionState: "disconnected", preference: "disconnected", upgradeState: "current", applyState: "applied" };
    const props = { controls: api, resourceKind: "environment" as const, resourceId: runtime.resourceId, label: "Build host", runtime: disconnected, disabled: false, onRuntime: vi.fn(), onRefresh: refresh };
    const view = render(<RuntimeControls {...props} revision={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeVisible();
    view.rerender(<RuntimeControls {...props} revision={8} />);
    finishRefresh(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.configurationLifecycle).toHaveBeenCalledTimes(2));
    expect(api.configurationLifecycle.mock.calls[1]![0].expectedRevision).toBe(8);
  });
});
