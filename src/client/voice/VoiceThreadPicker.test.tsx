// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import { VoiceThreadPicker } from "./VoiceThreadPicker.js";

const threads = ["Release review", "Deployment checklist"].map((title, index) => ({
  id: `thread-${index}`, title: { text: title }, available: true, inventoryState: "active",
})) as NormalizedApplicationThreadSummary[];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("VoiceThreadPicker focus", () => {
  it("opens for mobile browsing and searches only after the input is tapped", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(<VoiceThreadPicker threads={threads} open onOpenChange={onOpenChange} onSelect={onSelect} />);
    const search = screen.getByRole("textbox", { name: "Search voice threads" });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Choose voice thread" })).toHaveFocus());
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
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Choose voice thread" })).toHaveFocus());
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Search voice threads" })).toHaveFocus();
  });

  it("preserves desktop search autofocus", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    render(<VoiceThreadPicker threads={threads} open onOpenChange={vi.fn()} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Search voice threads" })).toHaveFocus());
  });
});
