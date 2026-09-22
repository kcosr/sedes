// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnUsagePopover } from "./TurnUsagePopover.js";
import { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import { usageReport } from "../../stores/usage-test-fixture.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";
import { UsageDetails } from "./RecordedUsage.js";
const caches: UsageQueryCache[] = [];
afterEach(() => { cleanup(); caches.splice(0).forEach(cache => cache.dispose()); vi.restoreAllMocks(); });
function fixture() {
  const report = usageReport();
  report.summary.metrics.input = { value: "9007199254740993", basis: ["sdk_normalized"], providerPresence: "unknown", quality: "partial" };
  const getUsage = vi.fn().mockResolvedValue(report);
  const cache = new UsageQueryCache("thread-1", { getUsage }); caches.push(cache);
  return { cache, getUsage };
}
describe("turn usage popover", () => {
  it("uses metric conflict quality and displays the legacy snapshot time", () => {
    const report=usageReport();
    report.summary.metrics.input={value:"10",quality:"conflict",basis:[],providerPresence:"unknown"};
    report.legacy=usageReport().summary;
    report.legacyRecordedAt="2026-09-21T10:00:00Z";
    const {container}=render(<UsageDetails report={report} />);
    expect(screen.getByText("Usage reconciliation incomplete")).toBeVisible();
    expect(screen.getByText("10 (last valid)")).toBeVisible();
    expect(container.querySelector('time[datetime="2026-09-21T10:00:00Z"]')).toBeVisible();
  });
  it("labels unresolved resets and incomplete money as recorded subtotals", () => {
    const report = usageReport();
    report.summary.reasons = ["source_reset"];
    report.summary.costs = [{ amount: "0.0002", currency: "USD", kind: "estimated", provenance: "Provider estimate", quality: "partial", billing: "unknown" }];
    render(<UsageDetails report={report} />);
    expect(screen.getByText("Usage reconciliation incomplete")).toBeVisible();
    expect(screen.getByText("Estimated cost: 0.0002 USD (known subtotal)")).toBeVisible();
  });
  it("fetches only on open, retains precise counts and toggles a pinned preview", async () => {
    const { cache, getUsage } = fixture(); const onOpenChange = vi.fn();
    render(<TurnUsagePopover cache={cache} turnId="turn-1" onOpenChange={onOpenChange} />);
    expect(getUsage).not.toHaveBeenCalled();
    const trigger = screen.getByRole("button", { name: "Turn usage and cost" });
    fireEvent.focus(trigger); await screen.findByRole("dialog", { name: "Turn usage" });
    await screen.findByText("9,007,199,254,740,993 (known subtotal)");
    expect(screen.getByText("Cost unavailable")).toBeVisible();
    expect(screen.getByText(/SDK-normalized/)).toBeVisible();
    fireEvent.click(trigger); expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger); await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(getUsage).toHaveBeenCalledOnce();
  });
  it("previews on hover without stealing focus and stays open across trigger/content", async () => {
    const { cache } = fixture();
    render(<><input aria-label="Composer" /><TurnUsagePopover cache={cache} turnId="turn-1" onOpenChange={vi.fn()} /></>);
    const composer = screen.getByRole("textbox", { name: "Composer" }); composer.focus();
    const trigger = screen.getByRole("button", { name: "Turn usage and cost" });
    const pointer = (target: Element, type: string, relatedTarget: Element | null = null) => {
      const event = new MouseEvent(type, { bubbles: true, relatedTarget });
      Object.defineProperty(event, "pointerType", { value: "mouse" }); fireEvent(target, event);
    };
    pointer(trigger, "pointerover");
    const dialog = await screen.findByRole("dialog", { name: "Turn usage" });
    expect(composer).toHaveFocus();
    pointer(trigger, "pointerout", dialog); pointer(dialog, "pointerover", trigger);
    expect(dialog).toBeVisible();
    pointer(dialog, "pointerout", document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn usage" })).toBeNull());
    expect(composer).toHaveFocus();
  });
  it("Escape and Android Back's Escape dismiss without reopening on restored focus", async () => {
    const { cache } = fixture(); render(<TurnUsagePopover cache={cache} turnId="turn-1" onOpenChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Turn usage and cost" });
    fireEvent.click(trigger); await screen.findByRole("dialog", { name: "Turn usage" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn usage" })).toBeNull());
    expect(trigger).toHaveFocus(); expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
  it("closes portaled UI when its transcript view becomes hidden", async () => {
    const { cache } = fixture(); const onOpenChange = vi.fn();
    const view = render(<ChatViewVisibilityContext.Provider value={true}><TurnUsagePopover cache={cache} turnId="turn-1" onOpenChange={onOpenChange} /></ChatViewVisibilityContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Turn usage and cost" })); await screen.findByRole("dialog", { name: "Turn usage" });
    view.rerender(<ChatViewVisibilityContext.Provider value={false}><TurnUsagePopover cache={cache} turnId="turn-1" onOpenChange={onOpenChange} /></ChatViewVisibilityContext.Provider>);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Turn usage" })).toBeNull());
  });
});
