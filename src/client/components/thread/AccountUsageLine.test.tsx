// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendAccountUsage, NormalizedApplicationSnapshot } from "../../../shared/index.js";
import { AccountUsageLine, accountUsageForTarget } from "./AccountUsageLine.js";

const NOW = Date.parse("2026-11-14T12:00:00Z");
function usage(overrides: Partial<BackendAccountUsage> = {}): BackendAccountUsage {
  return {
    capturedAt: NOW, accountId: "account-one", plan: "Pro Max", includedUsageAllowed: true,
    windows: [{ remainingPercent: 28, durationMinutes: 10_080, resetsAt: NOW + 86_400_000 }],
    ...overrides,
  };
}
function pointer(target: Element, type: string, pointerType = "mouse", clientX = 250) {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(target, event);
}
async function advance(ms: number) { await act(() => vi.advanceTimersByTimeAsync(ms)); }
function line() { return screen.getByRole("button", { name: /included usage:.*Show usage details/i }); }
function popup() { return screen.queryByRole("dialog", { name: "Codex included usage" }); }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("AccountUsageLine", () => {
  it("shows only reported windows and optional account details", () => {
    render(<AccountUsageLine backendLabel="Codex" usage={usage()} />);
    expect(line()).toHaveAccessibleName("Codex included usage: 28% remaining. Show usage details.");
    expect(screen.queryByText(/Weekly/)).toBeNull();
    fireEvent.click(line());
    expect(popup()).toHaveTextContent("Included usage");
    expect(popup()).toHaveTextContent("Codex · Pro Max");
    expect(popup()).toHaveTextContent("Weekly28% left");
    expect(popup()).not.toHaveTextContent("5-hour");
    expect(popup()).not.toHaveTextContent(/workspace|email/i);
    expect(popup()).toHaveTextContent("Checked");
    expect(popup()?.querySelector('time[datetime="2026-11-14T12:00:00.000Z"]')).not.toBeNull();
    expect(screen.getByText("Account identifier")).toBeInTheDocument();
    expect(screen.getByText("account-one")).toBeInTheDocument();
  });

  it("uses the lowest reported remaining percentage and preserves an exhausted target", () => {
    render(<AccountUsageLine backendLabel="Codex" usage={usage({ windows: [
      { remainingPercent: 62, durationMinutes: 300, resetsAt: null },
      { remainingPercent: 0, durationMinutes: 10_080, resetsAt: null },
    ], includedUsageAllowed: false })} />);
    expect(line()).toHaveAttribute("data-level", "critical");
    expect(line().style.getPropertyValue("--account-usage-remaining")).toBe("0%");
    expect(line().querySelector(".account-usage-track")).not.toBeNull();
    fireEvent.click(line());
    expect(popup()).toHaveTextContent("5-hour62% left");
    expect(popup()).toHaveTextContent("Weekly0% left");
    expect(popup()).toHaveTextContent("Included usage is currently unavailable.");
  });

  it("does not invent missing durations, reset times, plan, or identity", () => {
    render(<AccountUsageLine backendLabel="Codex" usage={usage({ accountId: null, plan: null,
      windows: [{ remainingPercent: 15, durationMinutes: null, resetsAt: null }],
    })} />);
    fireEvent.click(line());
    expect(popup()).toHaveTextContent("Usage window15% left");
    expect(popup()).not.toHaveTextContent(/Resets|Account identifier|Pro Max/);
  });

  it("hides missing, aged, reset, and invisible snapshots", () => {
    const view = render(<AccountUsageLine backendLabel="Codex" />);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<AccountUsageLine backendLabel="Codex" usage={usage({ capturedAt: NOW - 600_000 })} />);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<AccountUsageLine backendLabel="Codex" usage={usage({ windows: [{ remainingPercent: 90, durationMinutes: 300, resetsAt: NOW }] })} />);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<AccountUsageLine backendLabel="Codex" usage={usage()} visible={false} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("expires on the next reset and closes the popover without a new snapshot", async () => {
    const current = usage({ windows: [{ remainingPercent: 4, durationMinutes: 300, resetsAt: NOW + 1_000 }] });
    const view = render(<AccountUsageLine backendLabel="Codex" usage={current} />);
    fireEvent.click(line());
    expect(popup()).not.toBeNull();
    await advance(1_000);
    expect(popup()).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<AccountUsageLine backendLabel="Codex" usage={usage({ capturedAt: NOW + 1_000 })} />);
    expect(line()).toHaveAttribute("aria-expanded", "false");
  });

  it("expires after ten minutes even when no update arrives", async () => {
    render(<AccountUsageLine backendLabel="Codex" usage={usage()} />);
    await advance(599_999);
    expect(line()).toBeInTheDocument();
    await advance(1);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("delays hover, cancels crossings, and lets the pointer enter the details", async () => {
    render(<><input aria-label="Message" /><AccountUsageLine backendLabel="Codex" usage={usage()} /></>);
    screen.getByRole("textbox").focus();
    pointer(line(), "pointerover");
    await advance(499);
    expect(popup()).toBeNull();
    pointer(line(), "pointerout");
    await advance(500);
    expect(popup()).toBeNull();
    pointer(line(), "pointerover");
    await advance(500);
    expect(popup()).not.toBeNull();
    expect(screen.getByRole("textbox")).toHaveFocus();
    pointer(line(), "pointerout");
    pointer(popup()!, "pointerover");
    await advance(500);
    expect(popup()).not.toBeNull();
    pointer(popup()!, "pointerout");
    await advance(140);
    expect(popup()).toBeNull();
  });

  it("cancels a pending hover on Escape, an outside press, or unavailable data", async () => {
    const view = render(<AccountUsageLine backendLabel="Codex" usage={usage()} />);
    pointer(line(), "pointerover");
    fireEvent.keyDown(document, { key: "Escape" });
    await advance(500);
    expect(popup()).toBeNull();
    pointer(line(), "pointerout"); pointer(line(), "pointerover");
    pointer(document.body, "pointerdown");
    await advance(500);
    expect(popup()).toBeNull();
    pointer(line(), "pointerout"); pointer(line(), "pointerover");
    view.rerender(<AccountUsageLine backendLabel="Codex" />);
    await advance(500);
    expect(popup()).toBeNull();
  });

  it("opens immediately by tap, pins across pointer departure, and closes by outside press", async () => {
    render(<AccountUsageLine backendLabel="Codex" usage={usage()} />);
    pointer(line(), "pointerover", "touch");
    await advance(500);
    expect(popup()).toBeNull();
    pointer(line(), "pointerdown", "touch");
    pointer(line(), "pointerup", "touch");
    fireEvent.click(line());
    expect(popup()).not.toBeNull();
    pointer(line(), "pointerout");
    await advance(500);
    expect(popup()).not.toBeNull();
    pointer(document.body, "pointerdown");
    pointer(document.body, "pointerup");
    fireEvent.click(document.body);
    expect(popup()).toBeNull();
  });

  it("opens on keyboard focus and stays dismissed after Escape or the close button", async () => {
    render(<AccountUsageLine backendLabel="Codex" usage={usage()} />);
    act(() => line().focus());
    expect(popup()).not.toBeNull();
    fireEvent.keyDown(line(), { key: "Escape" });
    expect(popup()).toBeNull();
    fireEvent.click(line());
    fireEvent.click(screen.getByRole("button", { name: "Close usage details" }));
    await advance(1);
    expect(popup()).toBeNull();
    expect(line()).toHaveFocus();
  });

  it("clears a pinned popover when account identity changes", () => {
    const view = render(<AccountUsageLine backendLabel="Codex" usage={usage()} />);
    fireEvent.click(line());
    view.rerender(<AccountUsageLine backendLabel="Codex" usage={usage({ accountId: "account-two" })} />);
    expect(line()).toHaveAttribute("aria-expanded", "false");
    expect(popup()).toBeNull();
  });
});

describe("accountUsageForTarget", () => {
  it("requires both server-provided backend and environment and an available target", () => {
    const expected = { ...usage(), backendInstanceId: "backend-one", executionEnvironmentId: "remote" };
    const application = {
      executionTargets: [
        { id: "target", backendInstanceId: "backend-one", environmentId: "remote", available: true },
        { id: "stopped", backendInstanceId: "backend-one", environmentId: "remote", available: false },
      ],
      accountUsages: [
        { ...usage(), backendInstanceId: "backend-two", executionEnvironmentId: "remote" },
        { ...usage(), backendInstanceId: "backend-one", executionEnvironmentId: "local" }, expected,
      ],
    } as unknown as NormalizedApplicationSnapshot;
    expect(accountUsageForTarget(application, "target")).toBe(expected);
    expect(accountUsageForTarget(application, "stopped")).toBeUndefined();
    expect(accountUsageForTarget(application, "missing")).toBeUndefined();
    expect(accountUsageForTarget(undefined, "target")).toBeUndefined();
  });
});
