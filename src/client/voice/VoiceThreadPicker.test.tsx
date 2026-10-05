// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { VoiceThreadPicker } from "./VoiceThreadPicker.js";

const threads = ["Release review", "Deployment checklist"].map((title, index) => ({
  id: `thread-${index}`, title: { text: title }, available: true, inventoryState: "active",
})) as NormalizedApplicationThreadSummary[];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function AnchoredPicker({ onSelect }: { onSelect: (thread: NormalizedApplicationThreadSummary) => void }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <><button ref={anchorRef} onClick={() => setOpen(value => !value)}>Choose target</button>
    <VoiceThreadPicker threads={threads} open={open} onOpenChange={setOpen} onSelect={onSelect}
      presentation="popover" anchorRef={anchorRef} selectedThreadId={threads[0]!.id} /></>;
}

describe("VoiceThreadPicker focus", () => {
  it("opens for mobile browsing and searches only after the input is tapped", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(<VoiceThreadPicker threads={threads} open onOpenChange={onOpenChange} onSelect={onSelect} />);
    const search = screen.getByRole("searchbox", { name: "Search voice threads" });
    const dialog = screen.getByRole("dialog", { name: "Choose target thread" });
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(dialog).toHaveAttribute("data-layout", "sheet");
    expect(search).not.toHaveFocus();
    await user.click(search);
    expect(search).toHaveFocus();
    await user.type(search, "deployment");
    expect(screen.queryByRole("button", { name: "Release review" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deployment checklist" }));
    expect(onSelect).toHaveBeenCalledWith(threads[1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps mobile search reachable with the keyboard from the focused dialog", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const user = userEvent.setup();
    render(<VoiceThreadPicker threads={threads} open onOpenChange={vi.fn()} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Choose target thread" })).toHaveFocus());
    await user.tab();
    expect(screen.getByRole("searchbox", { name: "Search voice threads" })).toHaveFocus();
  });

  it("preserves desktop search autofocus", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    render(<VoiceThreadPicker threads={threads} open onOpenChange={vi.fn()} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search voice threads" })).toHaveFocus());
  });

  it("keeps the mobile row chooser anchored, shows its current choice, and returns focus after selection", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<AnchoredPicker onSelect={onSelect} />);
    const trigger = screen.getByRole("button", { name: "Choose target" });
    await user.click(trigger);
    const popup = await screen.findByRole("dialog", { name: "Choose target thread" });
    expect(popup).toHaveAttribute("data-slot", "popover-content");
    expect(screen.queryByTestId("dialog-overlay")).not.toBeInTheDocument();
    await waitFor(() => expect(popup).toHaveFocus());
    const current = screen.getByRole("button", { name: "Release review" });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current.querySelector(".lucide-check")).not.toBeNull();
    const search = screen.getByRole("searchbox", { name: "Search voice threads" });
    expect(search).not.toHaveFocus();
    expect(search.closest(".searchable-select-search")).not.toBeNull();
    await user.type(search, "deployment");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Deployment checklist" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(threads[1]);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
