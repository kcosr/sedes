// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ available: true, setDiagnosticsEnabled: vi.fn(), readDiagnostics: vi.fn(), clearDiagnostics: vi.fn() }));
vi.mock("../../../voice/native-voice-plugin.js", () => ({ hasNativeVoice: () => bridge.available, nativeVoice: bridge }));
import { clearDiagnostics } from "../../../app/diagnostics.js";
import { installNativeVoiceDiagnostics } from "../../../voice/native-voice-diagnostics.js";
import { DiagnosticsSettingsPage } from "./DiagnosticsSettingsPage.js";
let uninstall: (() => void) | undefined;
beforeEach(() => {
  bridge.available = true;
  bridge.setDiagnosticsEnabled.mockResolvedValue(undefined);
  bridge.readDiagnostics.mockResolvedValue({ enabled: false, maximumEntries: 512, entries: [] });
  bridge.clearDiagnostics.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); uninstall?.(); uninstall = undefined; clearDiagnostics(); localStorage.clear(); vi.resetAllMocks(); });

it("exposes native voice recording and copies and clears native-only logs after recording stops", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  uninstall = installNativeVoiceDiagnostics();
  render(<DiagnosticsSettingsPage />);
  const toggle = screen.getByTestId("voice-diagnostics-toggle");
  expect(toggle).toHaveAttribute("data-state", "unchecked");
  fireEvent.click(toggle);
  expect(bridge.setDiagnosticsEnabled).toHaveBeenLastCalledWith({ enabled: true });
  fireEvent.click(toggle);
  expect(bridge.setDiagnosticsEnabled).toHaveBeenLastCalledWith({ enabled: false });
  expect(screen.getByRole("button", { name: "Copy log" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Copy log" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(JSON.parse(writeText.mock.calls[0]![0]).nativeVoice).toEqual({ enabled: false, maximumEntries: 512, entries: [] });
  fireEvent.click(screen.getByRole("button", { name: "Clear copy buffer" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copy buffer cleared."));
  expect(bridge.clearDiagnostics).toHaveBeenCalledOnce();
  bridge.clearDiagnostics.mockRejectedValue(new Error("private exception"));
  fireEvent.click(screen.getByRole("button", { name: "Clear copy buffer" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Native buffer could not be cleared."));
  expect(screen.queryByText("private exception")).toBeNull();
});

it("omits the native category when Android voice is unavailable", () => {
  bridge.available = false;
  render(<DiagnosticsSettingsPage />);
  expect(screen.queryByTestId("voice-diagnostics-toggle")).toBeNull();
  expect(screen.getByRole("button", { name: "Copy log (0)" })).toBeDisabled();
});
