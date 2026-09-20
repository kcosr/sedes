// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationOperationRecoveryDetails } from "../../../shared/protocol/configuration-operation-recovery.js";
import { RecoveredOperations, type OperationRecoveryControls } from "./RecoveredOperations.js";

const details: ConfigurationOperationRecoveryDetails = {
  kind: "shell", receiptId: "30000000-0000-4000-8000-000000000001", state: "succeeded", summary: "Build workspace",
  acknowledgeable: true, details: "Command exited with status 0.", stdout: "<script>untrusted output</script>", stderr: "", omittedBytes: 128,
};
function controls(result = details) {
  return {
    listConfigurationOperations: vi.fn(async () => ({ receipts: [{ kind: result.kind, receiptId: result.receiptId, state: result.state, summary: result.summary, acknowledgeable: result.acknowledgeable }] })),
    inspectConfigurationOperation: vi.fn(async () => ({ operation: result, confirmationToken: "exact-inspection-confirmation" })),
    acknowledgeConfigurationOperation: vi.fn(async () => ({ acknowledged: true })),
  } satisfies OperationRecoveryControls;
}
afterEach(cleanup);

describe("retained operation recovery", () => {
  it("requires inspection before explicit acknowledgment and renders bounded output as text", async () => {
    const api = controls();
    render(<RecoveredOperations controls={api} environmentId="environment" label="Build host" disabled={false} />);
    expect(api.listConfigurationOperations).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Recovered operations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Inspect Build workspace" }));
    expect(await screen.findByText(details.stdout)).toBeVisible();
    expect(screen.getByText(/128 output bytes were omitted/)).toBeVisible();
    expect(document.querySelector("pre script")).toBeNull();
    expect(api.acknowledgeConfigurationOperation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge and release result" }));
    await waitFor(() => expect(api.acknowledgeConfigurationOperation).toHaveBeenCalledOnce());
    expect(api.acknowledgeConfigurationOperation.mock.calls[0]).toEqual(["environment", { kind: "shell", receiptId: details.receiptId }, { confirmationToken: "exact-inspection-confirmation" }, expect.any(AbortSignal)]);
    expect(await screen.findByText("No retained operations.")).toBeVisible();
  });

  it("keeps unknown outcomes retained without an acknowledgment action", async () => {
    const api = controls({ ...details, state: "unknown", acknowledgeable: false });
    render(<RecoveredOperations controls={api} environmentId="environment" label="Build host" disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Recovered operations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Inspect Build workspace" }));
    expect(await screen.findByText(/does not have an acknowledgeable final result/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Acknowledge and release result" })).toBeNull();
    expect(api.acknowledgeConfigurationOperation).not.toHaveBeenCalled();
  });

  it("requires an explicit workspace review before releasing an acknowledgeable unknown outcome", async () => {
    const api = controls({ ...details, kind: "file", state: "unknown", acknowledgeable: true });
    render(<RecoveredOperations controls={api} environmentId="environment" label="Build host" disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Recovered operations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Inspect Build workspace" }));
    const release = await screen.findByRole("button", { name: "Release inspected unknown outcome" });
    expect(release).toBeDisabled();
    expect(api.acknowledgeConfigurationOperation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("I inspected the affected workspace and accept this unknown outcome"));
    expect(release).toBeEnabled();
    fireEvent.click(release);
    expect(await screen.findByText("Retained result released. The operation's outcome remains unknown.")).toBeVisible();
    expect(api.acknowledgeConfigurationOperation).toHaveBeenCalledOnce();
  });

  it("aborts an unfinished read when the inspection dialog is unmounted", async () => {
    const api = controls();
    let signal: AbortSignal | undefined;
    const list = vi.fn((_environment: string, requestedSignal?: AbortSignal) => {
      signal = requestedSignal;
      return new Promise<{ receipts: [] }>(() => {});
    });
    const view = render(<RecoveredOperations controls={{ ...api, listConfigurationOperations: list }} environmentId="environment" label="Build host" disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Recovered operations" }));
    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(api.acknowledgeConfigurationOperation).not.toHaveBeenCalled();
  });

  it("does not retry an uncertain acknowledgment before a fresh inspection", async () => {
    const api = controls();
    api.acknowledgeConfigurationOperation.mockRejectedValueOnce(new Error("Connection lost"));
    render(<RecoveredOperations controls={api} environmentId="environment" label="Build host" disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Recovered operations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Inspect Build workspace" }));
    fireEvent.click(await screen.findByRole("button", { name: "Acknowledge and release result" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(screen.getByRole("button", { name: "Acknowledge and release result" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh operations" }));
    await waitFor(() => expect(api.listConfigurationOperations).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Acknowledge and release result" })).toBeNull();
    expect(api.acknowledgeConfigurationOperation).toHaveBeenCalledOnce();
  });
});
