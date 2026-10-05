// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOUCH_DENSITY_QUERY } from "../../app/use-touch-density.js";
import {
  ComposerPromptPicker,
  type ComposerPromptPickerItem,
} from "./ComposerPromptPicker.js";

const catalog: readonly ComposerPromptPickerItem[] = [
  { id: "review", title: "Review changes", prompt: "Review the current diff." },
  { id: "tests", title: "Run tests", prompt: "Run the focused test suite." },
];

function setMobile(mobile: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === TOUCH_DENSITY_QUERY && mobile,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function renderPicker(
  props: Partial<React.ComponentProps<typeof ComposerPromptPicker>> = {},
) {
  const onAppend = vi.fn();
  const onSend = vi.fn();
  const onManage = vi.fn();
  const onRetry = vi.fn();
  const onOpen = vi.fn();
  const onApplyUpdate = vi.fn();
  render(
    <ComposerPromptPicker
      triggerVariant="toolbar"
      catalog={catalog}
      loading={false}
      currentDraftState="empty"
      onAppend={onAppend}
      onSend={onSend}
      onManage={onManage}
      onRetry={onRetry}
      updateAvailable={false}
      onOpen={onOpen}
      onApplyUpdate={onApplyUpdate}
      {...props}
    />,
  );
  return {
    onAppend,
    onSend,
    onManage,
    onRetry,
    onOpen,
    onApplyUpdate,
  };
}

beforeEach(() => {
  setMobile(false);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(async () => {
  cleanup();
  // Radix restores focus from a zero-delay unmount timer. Let it run while
  // this JSDOM's Event constructors and focus-scope stack still exist.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ComposerPromptPicker", () => {
  it("opens the desktop layout for browsing when its trigger is touched", async () => {
    renderPicker();
    const trigger = screen.getByRole("button", { name: "Open saved prompts" });
    fireEvent.pointerDown(trigger, { pointerType: "touch", button: 0 });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Saved prompts" });
    expect(dialog).toHaveAttribute("data-slot", "popover-content");
    expect(dialog).toHaveFocus();
    const search = screen.getByRole("searchbox", { name: "Search saved prompts" });
    search.focus();
    fireEvent.change(search, { target: { value: "focused" } });
    expect(search).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Send prompt: Review changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send prompt: Run tests" })).toBeInTheDocument();
  });

  it("opens an ordered text-only desktop library and filters it", async () => {
    const { onOpen } = renderPicker();

    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    expect(onOpen).toHaveBeenCalledOnce();
    const dialog = await screen.findByRole("dialog", { name: "Saved prompts" });
    expect(dialog).toHaveAccessibleDescription(
      "Tap a prompt to send, or add it to the composer",
    );
    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Review changesReview the current diff.",
      "Run testsRun the focused test suite.",
    ]);
    // The shared custom-list anatomy: a two-line main button (500 title over
    // a one-line muted description) and a muted trailing action.
    const send = screen.getByRole("button", { name: "Send prompt: Review changes" });
    expect(rows[0]).toHaveClass("hover:bg-(--hover)", "has-[:focus-visible]:bg-(--hover)");
    expect(send).toHaveClass("min-h-(--menu-row-height)", "outline-hidden");
    expect(send.querySelector('[data-slot$="item-description"]')).toHaveClass("truncate");
    expect(
      screen.getByRole("button", { name: "Add prompt to composer: Review changes" }),
    ).toHaveClass("text-muted-foreground-2", "group-hover/row:text-muted-foreground");
    expect(screen.getByRole("searchbox").closest(".searchable-select-search")).not.toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("searchbox", { name: "Search saved prompts" }),
      ).toHaveFocus(),
    );

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "focused" },
    });
    expect(screen.getByRole("listitem")).toHaveTextContent("Run tests");
    expect(screen.queryByText("Review changes")).not.toBeInTheDocument();
  });

  it("replaces Manage with a fixed-slot refresh action for a staged update", async () => {
    const { onApplyUpdate } = renderPicker({ updateAvailable: true });
    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));

    const refresh = await screen.findByRole("button", {
      name: "Refresh saved prompts",
    });
    expect(
      refresh.closest('[data-slot="composer-prompt-header-action"]'),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();

    fireEvent.click(refresh);
    expect(onApplyUpdate).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Saved prompts" })).toBeVisible();
  });

  it("sends once when the prompt content is tapped", async () => {
    let resolveSend!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { onAppend } = renderPicker({ currentDraftState: "dirty", onSend });
    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    const title = await screen.findByText("Review changes");
    fireEvent.click(title);
    fireEvent.click(title);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(catalog[0]);
    expect(onAppend).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Saved prompts" }),
      ).not.toBeInTheDocument(),
    );
    resolveSend();
  });

  it("shows only the add-to-composer icon and reports it once", async () => {
    let resolveAppend!: () => void;
    const onAppend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAppend = resolve;
        }),
    );
    const { onSend } = renderPicker({ onAppend });
    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    const row = (await screen.findByText("Review changes")).closest("li");
    expect(row?.querySelectorAll("button")).toHaveLength(2);
    expect(row?.querySelectorAll("button svg")).toHaveLength(1);

    const append = screen.getByRole("button", {
      name: "Add prompt to composer: Review changes",
    });
    expect(append).toHaveAttribute("title", "Add to composer");
    fireEvent.click(append);
    fireEvent.click(append);
    expect(onAppend).toHaveBeenCalledTimes(1);
    expect(onAppend).toHaveBeenCalledWith(catalog[0]);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Saved prompts" }),
      ).not.toBeInTheDocument(),
    );
    resolveAppend();
  });

  it("keeps Add available when row delivery is temporarily unavailable", async () => {
    const { onAppend, onSend } = renderPicker({ sendDisabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));

    const append = await screen.findByRole("button", {
      name: "Add prompt to composer: Review changes",
    });
    const send = screen.getByRole("button", {
      name: "Send prompt: Review changes",
    });
    expect(append).toBeEnabled();
    expect(send).toBeDisabled();

    fireEvent.click(append);
    expect(onAppend).toHaveBeenCalledWith(catalog[0]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("supports keyboard navigation, Escape, and Manage", async () => {
    const { onManage } = renderPicker();
    const trigger = screen.getByRole("button", { name: "Open saved prompts" });
    fireEvent.click(trigger);
    const search = await screen.findByRole("searchbox");
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const firstSend = screen.getByRole("button", {
      name: "Send prompt: Review changes",
    });
    const firstAppend = screen.getByRole("button", {
      name: "Add prompt to composer: Review changes",
    });
    expect(firstSend).toHaveFocus();
    fireEvent.keyDown(firstSend, { key: "ArrowRight" });
    expect(firstAppend).toHaveFocus();
    fireEvent.keyDown(firstAppend, { key: "ArrowDown" });
    const secondAppend = screen.getByRole("button", {
      name: "Add prompt to composer: Run tests",
    });
    expect(secondAppend).toHaveFocus();
    fireEvent.keyDown(secondAppend, { key: "Home" });
    expect(firstAppend).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("opens the touch sheet on a swipe up and closes it on the first outside pointer", async () => {
    setMobile(true);
    renderPicker({ triggerVariant: "tab" });
    const trigger = screen.getByRole("button", { name: "Open saved prompts" });

    fireEvent.pointerDown(trigger, { pointerId: 4, button: 0, clientY: 160 });
    fireEvent.pointerMove(trigger, { pointerId: 4, clientY: 100 });
    fireEvent.pointerUp(trigger, { pointerId: 4, clientY: 100 });

    const dialog = await screen.findByRole("dialog", { name: "Saved prompts" });
    expect(dialog).toHaveAttribute("data-slot", "dialog-content");
    expect(dialog).toHaveAttribute("data-layout", "sheet");
    expect(dialog).toHaveAccessibleDescription(
      "Tap a prompt to send, or add it to the composer",
    );
    expect(screen.getByRole("searchbox", { name: "Search saved prompts" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Search saved prompts" })).not.toHaveFocus();
    // Manage sits in the sheet's footer, clear of the close button.
    expect(
      screen.getByRole("button", { name: "Manage" }).closest('[data-slot="dialog-footer"]'),
    ).not.toBeNull();
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Send prompt: Review changes" }),
    ).toHaveFocus());
    // Synthetic pointer events after the swipe do not toggle it closed.
    fireEvent.click(trigger);
    expect(dialog).toBeInTheDocument();

    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    await userEvent.click(overlay!);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("keeps mobile search visible without autofocus and filters after an explicit tap", async () => {
    setMobile(true);
    const { onSend } = renderPicker();
    await userEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    const search = screen.getByRole("searchbox", { name: "Search saved prompts" });
    expect(search).toBeVisible();
    expect(search).not.toHaveFocus();
    await userEvent.type(search, "focused");
    expect(search).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Send prompt: Review changes" })).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const remaining = screen.getByRole("button", { name: "Send prompt: Run tests" });
    expect(remaining).toHaveFocus();
    fireEvent.keyDown(remaining, { key: "ArrowUp" });
    expect(search).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Send prompt: Run tests" }));
    expect(onSend).toHaveBeenCalledWith(catalog[1]);
  });

  it("does not open from the synthetic click after a downward tab swipe", async () => {
    setMobile(true);
    const { onOpen } = renderPicker({ triggerVariant: "tab" });
    const trigger = screen.getByRole("button", { name: "Open saved prompts" });

    fireEvent.pointerDown(trigger, { pointerId: 6, button: 0, clientY: 100 });
    fireEvent.pointerMove(trigger, { pointerId: 6, clientY: 150 });
    fireEvent.pointerUp(trigger, { pointerId: 6, clientY: 150 });
    fireEvent.click(trigger);

    expect(
      screen.queryByRole("dialog", { name: "Saved prompts" }),
    ).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: "Saved prompts" }),
    ).toBeVisible();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("does not arm tab swipes on a mobile toolbar trigger", async () => {
    setMobile(true);
    renderPicker();
    const trigger = screen.getByRole("button", { name: "Open saved prompts" });

    fireEvent.pointerDown(trigger, { pointerId: 8, button: 0, clientY: 160 });
    fireEvent.pointerMove(trigger, { pointerId: 8, clientY: 100 });
    fireEvent.pointerUp(trigger, { pointerId: 8, clientY: 100 });

    expect(trigger.setPointerCapture).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "Saved prompts" }),
    ).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Saved prompts" });
    expect(dialog).toHaveAttribute("data-layout", "sheet");
  });

  it("closes the touch sheet with its close button and returns focus to the trigger", async () => {
    setMobile(true);
    const { onSend } = renderPicker({ triggerVariant: "tab" });
    const trigger = screen.getByRole("button", { name: "Open saved prompts" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Saved prompts" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onSend).not.toHaveBeenCalled();

    // Sending from the sheet closes it without pulling focus back to the tab.
    fireEvent.click(trigger);
    fireEvent.click(
      await screen.findByRole("button", { name: "Send prompt: Run tests" }),
    );
    expect(onSend).toHaveBeenCalledWith(catalog[1]);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Saved prompts" }),
      ).not.toBeInTheDocument(),
    );
    expect(trigger).not.toHaveFocus();
  });

  it("renders loading, empty, no-match and recoverable error states", async () => {
    renderPicker({ catalog: [], loading: true });
    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    const loadingRow = await screen.findByRole("status");
    expect(loadingRow).toHaveTextContent("Loading prompts");
    expect(loadingRow).toHaveClass("min-h-(--menu-row-height)");
    expect(loadingRow.querySelector("svg")).not.toBeNull();
    expect(screen.queryByRole("list")).toBeNull();

    cleanup();
    renderPicker({ catalog: [] });
    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    expect(
      await screen.findByText("No saved prompts yet. Use Manage to create one."),
    ).not.toHaveAttribute("tabindex");

    cleanup();
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    fireEvent.change(await screen.findByRole("searchbox"), {
      target: { value: "nothing like this" },
    });
    expect(screen.getByText("No matching prompts.")).toBeVisible();
    expect(screen.queryByRole("listitem")).toBeNull();

    cleanup();
    const { onRetry } = renderPicker({
      catalog: [],
      loading: false,
      error: "Could not load prompts.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-slot", "callout");
    expect(alert).toHaveAttribute("data-tone", "danger");
    expect(alert).toHaveTextContent("Could not load prompts.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();

    // With prompts loaded, a refresh error stays beside the list.
    cleanup();
    const retry = renderPicker({ error: "Could not refresh prompts." });
    fireEvent.click(screen.getByRole("button", { name: "Open saved prompts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not refresh prompts.",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry.onRetry).toHaveBeenCalledOnce();
  });
});
